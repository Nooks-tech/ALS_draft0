import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { customerMarkArrived, fetchOrdersForCustomer, holdOrder, insertOrder, resumeOrder, subscribeToOrders, type OrderRow } from '../api/orders';
import { useMerchant } from './MerchantContext';
import { submitOrderToNooks } from '../api/nooksOrders';
import type { CartItem } from './CartContext';
import { useAuth } from './AuthContext';

const ORDER_STATUSES = ['Placed', 'Accepted', 'Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled', 'On Hold'] as const;
const MAX_HISTORY_ORDERS = 30;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type PlacedOrder = {
  id: string;
  status: OrderStatus;
  total: number;
  date: string;
  items: CartItem[];
  orderType: 'delivery' | 'pickup' | 'drivethru';
  merchantId?: string;
  branchName?: string;
  branchId?: string;
  deliveryAddress?: string;
  deliveryLat?: number;
  deliveryLng?: number;
  branchLat?: number;
  branchLon?: number;
  otoWarehouseId?: string;
  otoId?: number;
  cancellationReason?: string;
  cancelledBy?: string;
  refundStatus?: string;
  refundAmount?: number;
  refundFee?: number;
  refundMethod?: string;
  createdAt?: string;
  readyAt?: string;
  deliveryFee?: number;
  paymentId?: string;
  paymentMethod?: string;
  promoCode?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  driver_name?: string;
  driver_phone?: string;
  otoDispatchStatus?: 'success' | 'failed';
  otoDispatchError?: string;
  // Payment breakdown — used by the order detail modal to show
  // customer where the total came from (subtotal − cashback − wallet
  // − promo = card portion). Optional because legacy orders pre-
  // 2026-05-12 don't have these columns populated.
  walletPaidSar?: number;
  cashbackPaidSar?: number;
  cardPaidSar?: number;
  promoDiscountSar?: number;
  // Curbside ("receive from your car") arrival ping — set when the
  // customer taps "I've arrived" on the order card. Persisted in
  // customer_orders.customer_arrived_at so it survives device
  // changes / signouts. foodicsOrderId is exposed so the OrderCard
  // can gate the button: if Foodics never accepted the order, the
  // arrival ping has no destination.
  customerArrivedAt?: string | null;
  foodicsOrderId?: string | null;
};

export type OrdersContextType = {
  orders: PlacedOrder[];
  loading: boolean;
  addOrder: (
    order: Omit<PlacedOrder, 'id' | 'date' | 'status'> & {
      otoId?: number;
      deliveryFee?: number;
      paymentId?: string;
      paymentMethod?: string;
      promoCode?: string;
        customerName?: string;
        customerPhone?: string;
        customerEmail?: string;
      otoDispatchStatus?: 'success' | 'failed';
      otoDispatchError?: string;
      serverPersisted?: boolean;
    },
    generatedId?: string,
    initialStatus?: OrderStatus
  ) => void;
  cancelOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  holdOrderForEdit: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  resumeHeldOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  /**
   * Curbside arrival ping. Optimistically writes
   * customerArrivedAt locally so the OrderCard flips to
   * "Notified at HH:MM" immediately, then fires the API call. On
   * failure we revert the optimistic write so the button reappears
   * — the customer can re-tap. Server is idempotent on the
   * customer_arrived_at column, so a successful re-tap returns the
   * original timestamp via `alreadyArrived: true`.
   */
  markArrived: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
};

const OrdersContext = createContext<OrdersContextType | undefined>(undefined);

function formatOrderDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `Today, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

function rowToOrder(row: OrderRow): PlacedOrder {
  const items = (Array.isArray(row.items) ? row.items : []) as Record<string, unknown>[];
  const cartItems: CartItem[] = items.map((it, i) => ({
    id: String(it.id ?? ''),
    name: String(it.name ?? ''),
    price: Number(it.price ?? 0),
    quantity: Number(it.quantity ?? 1),
    image: String(it.image ?? ''),
    uniqueId: String(it.uniqueId ?? `${it.id}-${i}`),
    ...(it.customizations && { customizations: it.customizations as Record<string, unknown> }),
  }));
  const status = ORDER_STATUSES.includes(row.status as OrderStatus) ? (row.status as OrderStatus) : 'Preparing';
  return {
    id: row.id,
    status,
    total: Number(row.total_sar),
    date: formatOrderDate(row.created_at),
    items: cartItems,
    orderType: row.order_type,
    merchantId: row.merchant_id ?? undefined,
    branchName: row.branch_name ?? undefined,
    branchId: row.branch_id ?? undefined,
    deliveryAddress: row.delivery_address ?? undefined,
    deliveryLat: row.delivery_lat ?? undefined,
    deliveryLng: row.delivery_lng ?? undefined,
    otoId: row.oto_id ?? undefined,
    cancellationReason: row.cancellation_reason ?? undefined,
    cancelledBy: row.cancelled_by ?? undefined,
    refundStatus: row.refund_status ?? undefined,
    refundAmount: row.refund_amount ?? undefined,
    refundFee: row.refund_fee ?? undefined,
    refundMethod: row.refund_method ?? undefined,
    createdAt: row.created_at,
    readyAt: (row as { ready_at?: string }).ready_at ?? undefined,
    deliveryFee: row.delivery_fee ?? undefined,
    paymentId: row.payment_id ?? undefined,
    paymentMethod: row.payment_method ?? undefined,
    driver_name: row.driver_name ?? undefined,
    driver_phone: row.driver_phone ?? undefined,
    walletPaidSar: row.wallet_paid_sar != null ? Number(row.wallet_paid_sar) : undefined,
    cashbackPaidSar: row.cashback_paid_sar != null ? Number(row.cashback_paid_sar) : undefined,
    cardPaidSar: row.card_paid_sar != null ? Number(row.card_paid_sar) : undefined,
    promoDiscountSar: row.promo_discount_sar != null ? Number(row.promo_discount_sar) : undefined,
    promoCode: row.promo_code ?? undefined,
    customerArrivedAt: (row as { customer_arrived_at?: string | null }).customer_arrived_at ?? null,
    foodicsOrderId: (row as { foodics_order_id?: string | null }).foodics_order_id ?? null,
  };
}

function mergeOrderHistory(primary: PlacedOrder[], secondary: PlacedOrder[]): PlacedOrder[] {
  // Merge primary INTO secondary: secondary entries fill in IDs the
  // server doesn't have (optimistic addOrder rows that haven't synced
  // yet), but primary wins on every overlap. Map.set overwrites, so
  // iterating secondary FIRST and primary SECOND means primary keys
  // land last and replace any secondary entry with the same id.
  //
  // The previous order ([...primary, ...secondary]) was backwards —
  // secondary always overwrote primary, which meant a refresh() pulled
  // fresh server data and then immediately discarded it under the
  // local cached copy. Symptom (observed 2026-05-18 order-1779074527673):
  // server-side sweep cancelled the order, customer app stayed on
  // 'Placed' forever because every AppState 'active' transition
  // re-merged stale prev over fresh mapped.
  const byId = new Map<string, PlacedOrder>();
  for (const order of [...secondary, ...primary]) {
    byId.set(order.id, order);
  }
  return [...byId.values()].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  }).slice(0, MAX_HISTORY_ORDERS);
}

export const OrdersProvider = ({ children }: { children: React.ReactNode }) => {
  const { user, loading: authLoading, initialized } = useAuth();
  const { merchantId } = useMerchant();
  const [orders, setOrders] = useState<PlacedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const customerId = user?.id ?? null;
  const merchantScope = merchantId || 'default';
  // Cache + reset key tracks BOTH axes so signing in with the same
  // phone on a sibling merchant's app (same auth.uid) doesn't pull
  // the previous merchant's cached order list. Same hardening as
  // CartContext / FavoritesContext.
  const cacheKey = `@als_orders_${merchantScope}_${customerId ?? 'guest'}`;

  const persistOrdersCache = useCallback((nextOrders: PlacedOrder[]) => {
    const capped = nextOrders.slice(0, MAX_HISTORY_ORDERS);
    AsyncStorage.setItem(cacheKey, JSON.stringify(capped)).catch(() => {});
  }, [cacheKey]);

  // Reset orders when EITHER user or merchant scope changes.
  const prevScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const scope = `${merchantScope}:${customerId ?? 'guest'}`;
    if (prevScopeRef.current !== null && prevScopeRef.current !== scope) {
      setOrders([]);
    }
    prevScopeRef.current = scope;
  }, [customerId, merchantScope]);

  // Pull fresh orders from Supabase. Exposed via context so callers can
  // force a refresh — used by AppState ('active' transition) to recover
  // from missed realtime updates and by screens that want a manual
  // pull-to-refresh.
  const refresh = useCallback(async () => {
    if (!customerId || !merchantId) return;
    try {
      const rows = await fetchOrdersForCustomer(customerId, merchantId);
      const mapped = rows.map(rowToOrder);
      if (mapped.length > 0) {
        setOrders((prev) => {
          const merged = mergeOrderHistory(mapped, prev);
          persistOrdersCache(merged);
          return merged;
        });
      }
    } catch {
      // best effort — realtime + AppState retry will catch up later
    }
  }, [customerId, merchantId, persistOrdersCache]);

  useEffect(() => {
    if (!initialized || authLoading) return;
    let cancelled = false;
    setLoading(true);
    AsyncStorage.getItem(cacheKey)
      .then((raw) => {
        if (!raw || cancelled) return;
        try {
          const cached = JSON.parse(raw) as PlacedOrder[];
          if (Array.isArray(cached) && cached.length > 0) {
            setOrders(cached);
            setLoading(false);
          }
        } catch {}
      })
      .catch(() => {});
    if (!customerId || !merchantId) {
      setLoading(false);
      return;
    }
    fetchOrdersForCustomer(customerId, merchantId).then((rows) => {
      if (!cancelled) {
        const mapped = rows.map(rowToOrder);
        if (mapped.length > 0) {
          setOrders((prev) => {
            const merged = mergeOrderHistory(mapped, prev);
            persistOrdersCache(merged);
            return merged;
          });
        }
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId, merchantId, initialized, authLoading, cacheKey, persistOrdersCache]);

  // Foreground refresh — Supabase realtime occasionally drops updates if
  // the app was backgrounded, sleeping, or on a flaky network. Without
  // this fallback an order that flipped Placed → Delivered while the
  // device was off the channel would stay stuck at Placed in the UI
  // until the user pulled to refresh (or the app was force-killed and
  // reopened, triggering the initial-load effect above).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  useEffect(() => {
    persistOrdersCache(orders);
  }, [orders, persistOrdersCache]);

  useEffect(() => {
    if (!customerId || !merchantId) return;
    // Defense against the Supabase Realtime multi-merchant gap: the
    // postgres_changes filter only supports single-column equality, so
    // the wire filter is `customer_id=eq.<uid>` (the same auth.uid is
    // shared across every white-label app). The merchant_id check
    // therefore happens INSIDE this callback — but the realtime row
    // is fully attacker-controllable for any client that opens its
    // own channel with a spoofed filter. We re-verify the row's
    // merchant_id matches our context BEFORE doing anything, and
    // ignore rows that don't.
    const safeMerchantMatch = (row: OrderRow): boolean =>
      (row as { merchant_id?: string }).merchant_id === merchantId;

    channelRef.current = subscribeToOrders(
      customerId,
      merchantId,
      (row) => {
        if (!safeMerchantMatch(row)) return;
        // Suppress realtime INSERTs where the order hasn't reached
        // Foodics yet. The local addOrder still surfaces the order
        // for the customer who placed it; this only stops orphans
        // (failed-payment / abandoned-3DS rows) from showing up on
        // a second device of the same customer. Once the relay
        // succeeds, the UPDATE event below brings the row in.
        if (!(row as { foodics_order_id?: string | null }).foodics_order_id) return;
        setOrders((prev) => [rowToOrder(row), ...prev.filter((o) => o.id !== row.id)]);
      },
      // Update list — do NOT fire a local notification here. The
      // server (Foodics webhook → sendLocalizedPushToCustomer) already
      // sends a properly-localized push for every status transition.
      // The previous local-notification call was bypassing the language
      // pick and pushing a hardcoded English "Order update — Your order
      // is being prepared" duplicate on top of the Arabic server push.
      //
      // If the row was previously suppressed by the INSERT guard and
      // the relay just succeeded (foodics_order_id transitioning
      // null→set), insert it now. If foodics_order_id is still null
      // even on UPDATE (sweep cancelled it), drop the row from view.
      (row) => {
        if (!safeMerchantMatch(row)) return;
        setOrders((prev) => {
          const foodicsId = (row as { foodics_order_id?: string | null }).foodics_order_id;
          const existing = prev.find((o) => o.id === row.id);
          if (!foodicsId) {
            return existing ? prev.filter((o) => o.id !== row.id) : prev;
          }
          if (existing) {
            return prev.map((o) => (o.id === row.id ? rowToOrder(row) : o));
          }
          return [rowToOrder(row), ...prev];
        });
      }
    );
    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [customerId, merchantId]);

  const addOrder = useCallback(
    (
      order: Omit<PlacedOrder, 'id' | 'date' | 'status'> & {
        otoId?: number;
        deliveryFee?: number;
        paymentId?: string;
        promoCode?: string;
        otoDispatchStatus?: 'success' | 'failed';
        otoDispatchError?: string;
        serverPersisted?: boolean;
      },
      generatedId?: string,
      initialStatus: OrderStatus = 'Placed'
    ) => {
      const id = generatedId ?? `order-${Date.now()}`;
      const now = new Date().toISOString();
      const date = formatOrderDate(now);
      const status: OrderStatus = initialStatus;
      const placed: PlacedOrder = {
        ...order,
        id,
        date,
        status,
        createdAt: now,
      };
      setOrders((prev) => {
        // Dedupe by id — the screen that calls addOrder also has a
        // Supabase Realtime subscription open (see subscribeToOrders
        // below) and both can fire for the same row in a race. If
        // Realtime gets there first the array already contains this
        // order, so "next = [placed, ...prev]" would show it twice with
        // different statuses (optimistic vs server). Filter first.
        const existing = prev.find((o) => o.id === placed.id);
        const merged = existing ? { ...existing, ...placed } : placed;
        const next = [merged, ...prev.filter((o) => o.id !== placed.id)];
        persistOrdersCache(next);
        return next;
      });

      if (order.merchantId && order.branchId && !order.serverPersisted) {
        void (async () => {
          let inserted = false;
          if (customerId && customerId !== 'guest') {
            const insertPayload = {
              id,
              merchant_id: order.merchantId ?? null,
              branch_id: order.branchId ?? null,
              branch_name: order.branchName ?? null,
              customer_id: customerId,
              total_sar: order.total,
              status,
              items: order.items,
              order_type: order.orderType,
              delivery_address: order.deliveryAddress ?? null,
              delivery_lat: order.deliveryLat ?? null,
              delivery_lng: order.deliveryLng ?? null,
              delivery_city: null,
              oto_id: order.otoId ?? null,
              delivery_fee: order.deliveryFee ?? null,
              payment_id: order.paymentId ?? null,
              payment_method: order.paymentMethod ?? null,
            };
            inserted = await insertOrder(insertPayload);
          }
          if (!inserted) {
            // Service-role fallback (and guest-mode path): send to nooksweb public orders API
            // so dashboard pages still receive orders even when direct app insert is unavailable.
            await submitOrderToNooks({
              id,
              merchant_id: order.merchantId,
              branch_id: order.branchId,
              total_sar: order.total,
              status,
              order_type: order.orderType,
              branch_name: order.branchName,
              delivery_fee: order.deliveryFee ?? null,
              ...(order.paymentId ? { payment_id: order.paymentId } : {}),
              ...(order.paymentMethod ? { payment_method: order.paymentMethod } : {}),
              ...(order.customerName ? { customer_name: order.customerName } : {}),
              ...(order.customerPhone ? { customer_phone: order.customerPhone } : {}),
              ...(order.customerEmail ? { customer_email: order.customerEmail } : {}),
              items: order.items.map((i) => ({
                product_id: i.id,
                name: i.name,
                quantity: i.quantity,
                price_sar: i.price,
              })),
              ...(customerId && customerId !== 'guest' ? { customer_id: customerId } : {}),
              ...(order.promoCode ? { promo_code: order.promoCode } : {}),
              ...(order.deliveryAddress && { delivery_address: order.deliveryAddress }),
              ...(order.deliveryLat != null && { delivery_lat: order.deliveryLat }),
              ...(order.deliveryLng != null && { delivery_lng: order.deliveryLng }),
            });
          }
          if (inserted) {
            // Even when direct insert succeeds, mirror to nooksweb API with payment_id dedupe
            // so dashboard pages always receive orders from one canonical ingestion path.
            await submitOrderToNooks({
              id,
              merchant_id: order.merchantId,
              branch_id: order.branchId,
              total_sar: order.total,
              status,
              order_type: order.orderType,
              branch_name: order.branchName,
              delivery_fee: order.deliveryFee ?? null,
              ...(order.paymentId ? { payment_id: order.paymentId } : {}),
              ...(order.paymentMethod ? { payment_method: order.paymentMethod } : {}),
              ...(order.customerName ? { customer_name: order.customerName } : {}),
              ...(order.customerPhone ? { customer_phone: order.customerPhone } : {}),
              ...(order.customerEmail ? { customer_email: order.customerEmail } : {}),
              items: order.items.map((i) => ({
                product_id: i.id,
                name: i.name,
                quantity: i.quantity,
                price_sar: i.price,
              })),
              ...(customerId && customerId !== 'guest' ? { customer_id: customerId } : {}),
              ...(order.promoCode ? { promo_code: order.promoCode } : {}),
              ...(order.deliveryAddress && { delivery_address: order.deliveryAddress }),
              ...(order.deliveryLat != null && { delivery_lat: order.deliveryLat }),
              ...(order.deliveryLng != null && { delivery_lng: order.deliveryLng }),
            });
          }
        })();
      }
    },
    [customerId, persistOrdersCache]
  );

  // Customer-cancel was removed per platform policy: end users cannot
  // directly cancel orders. Refunds happen exclusively through the
  // complaint flow (resolved by the merchant, credited to the
  // customer's wallet). This function is kept as a stub to preserve
  // the OrdersContext API shape so existing UI code calling it still
  // type-checks; the call always rejects with a guidance message.
  const cancelOrder = useCallback(async (_orderId: string) => {
    return {
      success: false,
      error: 'Direct cancel is no longer supported. To request a refund, file a complaint after delivery — the merchant will credit your wallet.',
    };
  }, []);

  const holdOrderForEdit = useCallback(async (orderId: string) => {
    try {
      const result = await holdOrder(orderId);
      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'On Hold' as OrderStatus } : o))
        );
        return result;
      }
      // If backend row has not been committed yet, allow local edit flow as fallback.
      if ((result.error || '').toLowerCase().includes('not found')) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'On Hold' as OrderStatus } : o))
        );
        return { success: true };
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to hold' };
    }
  }, []);

  const resumeHeldOrder = useCallback(async (orderId: string) => {
    try {
      const result = await resumeOrder(orderId);
      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'Preparing' as OrderStatus } : o))
        );
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to resume' };
    }
  }, []);

  const markArrived = useCallback(async (orderId: string) => {
    // Optimistic UI: flip customerArrivedAt locally NOW so the
    // button hides immediately and the customer doesn't double-tap
    // while the request is in flight. If the server rejects we
    // revert. The server is idempotent, so a successful retry of a
    // failed attempt just confirms what we already wrote.
    const optimisticAt = new Date().toISOString();
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, customerArrivedAt: optimisticAt } : o))
    );
    try {
      const result = await customerMarkArrived(orderId);
      if (!result.success && !result.alreadyArrived) {
        // Revert the optimistic write — the button comes back so
        // the user can re-tap.
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, customerArrivedAt: null } : o))
        );
        return { success: false, error: result.error || 'Failed to notify store' };
      }
      // Replace the optimistic timestamp with the server-canonical
      // one when we have it (might be from a prior tap if
      // alreadyArrived is true).
      if (result.customerArrivedAt) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, customerArrivedAt: result.customerArrivedAt! } : o))
        );
      }
      return { success: true };
    } catch (err: any) {
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, customerArrivedAt: null } : o))
      );
      return { success: false, error: err?.message || 'Network error' };
    }
  }, []);

  return (
    <OrdersContext.Provider value={{ orders, loading, addOrder, cancelOrder, holdOrderForEdit, resumeHeldOrder, markArrived, refresh }}>
      {children}
    </OrdersContext.Provider>
  );
};

export const useOrders = () => {
  const ctx = useContext(OrdersContext);
  if (!ctx) throw new Error('useOrders must be used within OrdersProvider');
  return ctx;
};
