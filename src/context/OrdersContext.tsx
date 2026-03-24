import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { customerCancelOrder, fetchOrdersForCustomer, holdOrder, insertOrder, resumeOrder, subscribeToOrders, type OrderRow } from '../api/orders';
import { submitOrderToNooks } from '../api/nooksOrders';
import { notifyOrderStatusUpdate } from '../utils/orderNotifications';
import type { CartItem } from './CartContext';
import { useAuth } from './AuthContext';

const ORDER_STATUSES = ['Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled', 'On Hold'] as const;
const MAX_HISTORY_ORDERS = 30;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type PlacedOrder = {
  id: string;
  status: OrderStatus;
  total: number;
  date: string;
  items: CartItem[];
  orderType: 'delivery' | 'pickup';
  merchantId?: string;
  branchName?: string;
  branchId?: string;
  deliveryAddress?: string;
  deliveryLat?: number;
  deliveryLng?: number;
  otoId?: number;
  cancellationReason?: string;
  cancelledBy?: string;
  refundStatus?: string;
  refundAmount?: number;
  refundFee?: number;
  refundMethod?: string;
  createdAt?: string;
  deliveryFee?: number;
  paymentId?: string;
  paymentMethod?: string;
  promoCode?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  otoDispatchStatus?: 'success' | 'failed';
  otoDispatchError?: string;
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
    },
    generatedId?: string,
    initialStatus?: OrderStatus
  ) => void;
  cancelOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  holdOrderForEdit: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  resumeHeldOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>;
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
    deliveryFee: row.delivery_fee ?? undefined,
    paymentId: row.payment_id ?? undefined,
    paymentMethod: row.payment_method ?? undefined,
  };
}

function mergeOrderHistory(primary: PlacedOrder[], secondary: PlacedOrder[]): PlacedOrder[] {
  const byId = new Map<string, PlacedOrder>();
  for (const order of [...primary, ...secondary]) {
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
  const [orders, setOrders] = useState<PlacedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const customerId = user?.id ?? null;
  const cacheKey = `@als_orders_${customerId ?? 'guest'}`;

  const persistOrdersCache = useCallback((nextOrders: PlacedOrder[]) => {
    const capped = nextOrders.slice(0, MAX_HISTORY_ORDERS);
    AsyncStorage.setItem(cacheKey, JSON.stringify(capped)).catch(() => {});
  }, [cacheKey]);

  // Reset orders when user changes
  const prevCustomerRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevCustomerRef.current !== null && prevCustomerRef.current !== (customerId ?? 'guest')) {
      setOrders([]);
    }
    prevCustomerRef.current = customerId ?? 'guest';
  }, [customerId]);

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
    if (!customerId) {
      setLoading(false);
      return;
    }
    fetchOrdersForCustomer(customerId).then((rows) => {
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
  }, [customerId, initialized, authLoading, cacheKey, persistOrdersCache]);

  useEffect(() => {
    persistOrdersCache(orders);
  }, [orders, persistOrdersCache]);

  useEffect(() => {
    if (!customerId) return;
    channelRef.current = subscribeToOrders(
      customerId,
      (row) => setOrders((prev) => [rowToOrder(row), ...prev.filter((o) => o.id !== row.id)]),
      (row) => {
        setOrders((prev) => prev.map((o) => (o.id === row.id ? rowToOrder(row) : o)));
        notifyOrderStatusUpdate(row.id, row.status);
      }
    );
    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [customerId]);

  const addOrder = useCallback(
    (
      order: Omit<PlacedOrder, 'id' | 'date' | 'status'> & {
        otoId?: number;
        deliveryFee?: number;
        paymentId?: string;
        promoCode?: string;
        otoDispatchStatus?: 'success' | 'failed';
        otoDispatchError?: string;
      },
      generatedId?: string,
      initialStatus: OrderStatus = 'Preparing'
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
        const next = [placed, ...prev];
        persistOrdersCache(next);
        return next;
      });

      if (order.merchantId && order.branchId) {
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

  const cancelOrder = useCallback(async (orderId: string) => {
    try {
      const result = await customerCancelOrder(orderId);
      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'Cancelled' as OrderStatus, cancelledBy: 'customer', cancellationReason: 'Cancelled by customer', refundStatus: result.refundStatus } : o))
        );
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to cancel' };
    }
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

  return (
    <OrdersContext.Provider value={{ orders, loading, addOrder, cancelOrder, holdOrderForEdit, resumeHeldOrder }}>
      {children}
    </OrdersContext.Provider>
  );
};

export const useOrders = () => {
  const ctx = useContext(OrdersContext);
  if (!ctx) throw new Error('useOrders must be used within OrdersProvider');
  return ctx;
};
