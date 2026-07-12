/**
 * Customer orders – persist to Supabase (customer_orders table) when user is logged in.
 */
import { api } from './client';
import { supabase } from './supabase';

function isCustomerOrdersMissing(message?: string) {
  const m = (message || '').toLowerCase();
  return m.includes('customer_orders') && (m.includes('does not exist') || m.includes('relation'));
}

function normalizeLegacy(row: Record<string, any>): OrderRow {
  return {
    ...row,
    cancellation_reason: row.cancellation_reason ?? null,
    cancelled_by: row.cancelled_by ?? null,
    refund_status: row.refund_status ?? null,
    refund_amount: row.refund_amount ?? null,
    refund_fee: row.refund_fee ?? null,
    refund_method: row.refund_method ?? null,
    delivery_fee: row.delivery_fee ?? null,
    payment_id: row.payment_id ?? null,
    payment_method: row.payment_method ?? null,
    moyasar_fee: row.moyasar_fee ?? null,
    branch_name: row.branch_name ?? null,
    branch_id: row.branch_id ?? null,
    merchant_id: row.merchant_id ?? null,
    delivery_address: row.delivery_address ?? null,
    delivery_lat: row.delivery_lat ?? null,
    delivery_lng: row.delivery_lng ?? null,
    delivery_city: row.delivery_city ?? null,
    oto_id: row.oto_id ?? null,
  } as OrderRow;
}

export type OrderRow = {
  id: string;
  merchant_id: string | null;
  branch_id: string | null;
  branch_name: string | null;
  customer_id: string;
  total_sar: number;
  status: string;
  items: unknown;
  order_type: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
  delivery_address: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_city: string | null;
  oto_id: number | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  refund_status: string | null;
  refund_amount: number | null;
  refund_fee: number | null;
  refund_method: string | null;
  delivery_fee: number | null;
  payment_id: string | null;
  payment_method: string | null;
  moyasar_fee: number | null;
  driver_name: string | null;
  driver_phone: string | null;
  created_at: string;
  updated_at: string;
  // Payment breakdown columns (added 2026-05-12 in migration
  // 20260512000000_order_payment_composition.sql). Populated by the
  // /commit endpoint from the client's walletAmountSar / cashbackAmountSar
  // / loyaltyDiscountSar fields. Optional because legacy rows from
  // before that migration may be null.
  wallet_paid_sar?: number | null;
  cashback_paid_sar?: number | null;
  card_paid_sar?: number | null;
  promo_discount_sar?: number | null;
  promo_code?: string | null;
  // Curbside arrival ping (added 2026-05-25 in
  // 20260525_customer_arrived_at.sql). Populated when the customer
  // taps "I've arrived" on the order card. foodics_order_id is
  // exposed so the customer app can gate the button on the order
  // actually having reached Foodics.
  customer_arrived_at?: string | null;
  foodics_order_id?: string | null;
};

export type OrderInsert = {
  id: string;
  merchant_id?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  customer_id: string;
  total_sar: number;
  status: string;
  items: unknown;
  order_type: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
  delivery_address?: string | null;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
  delivery_city?: string | null;
  oto_id?: number | null;
  delivery_fee?: number | null;
  payment_id?: string | null;
  payment_method?: string | null;
};

export type CommitOrderPayload = {
  id: string;
  merchantId: string;
  branchId: string;
  branchName?: string | null;
  totalSar: number;
  status: string;
  items: unknown;
  orderType: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
  deliveryAddress?: string | null;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  deliveryCity?: string | null;
  deliveryFee?: number | null;
  paymentId?: string | null;
  paymentMethod?: string | null;
  otoId?: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  promoCode?: string | null;
  promoDiscountSar?: number | null;
  promoScope?: 'total' | 'delivery' | 'order_total' | null;
  customerNote?: string | null;
  /**
   * Wallet credit applied to the order (in SAR). Server debits the
   * wallet for this amount during commit; the chosen payment method
   * (card / Apple Pay) covers the remainder. 0 / undefined = no
   * wallet credit. The order's total_sar is the FULL pre-wallet
   * total — wallet usage is read off the wallet ledger by joining
   * on order_id.
   */
  walletAmountSar?: number | null;
  /**
   * Cashback (in SAR) the customer redeemed for this order. Separate
   * from loyaltyDiscountSar so the server doesn't have to infer
   * loyaltyType. Server stores it in customer_orders.cashback_paid_sar
   * and on cancel re-credits the cashback balance.
   */
  cashbackAmountSar?: number | null;
  /**
   * Stamp milestones redeemed at checkout. Server stores them on the
   * order row so cancel can restore each milestone's stamps and clear
   * the redemption rows. Empty / omitted = no stamp redemption.
   */
  /**
   * Legacy: list of milestone ids redeemed at checkout. Kept on the
   * order payload so legacy clients still commit; Phase 1 backend
   * treats refunds against these as a no-op (the stamps table is gone).
   * Phase 2/3 will rebuild the milestone redemption path around points.
   */
  stampMilestoneIds?: string[];
  /** Legacy: SUM of points consumed per redeemed milestone. */
  stampsConsumed?: number | null;
  /**
   * Loyalty-discount SAR (cashback-as-discount or points discount).
   * Server uses this for Foodics line shrinking; for refund-time
   * cashback reversal use cashbackAmountSar (more explicit).
   */
  loyaltyDiscountSar?: number | null;
  /**
   * Car identifiers for curbside ("Receive from your car"). Required
   * shape: { plate_letters, plate_numbers, model, color }. Server
   * rejects orderType='drivethru' without all four non-empty.
   */
  carDetails?: {
    plate_letters: string;
    plate_numbers: string;
    model: string;
    color: string;
  } | null;
  /**
   * QR + dine-in attribution. Server is the source of truth: when
   * qrCodeId is supplied the server resolves branch_id +
   * foodics_table_id + foodics_table_name from the QR row and
   * ignores any client-supplied tableId/foodicsTableName values.
   * For dine_in orders, qrCodeId MUST resolve to an active QR
   * whose foodics_table_id is set, otherwise the commit 400s.
   */
  qrCodeId?: string | null;
  tableId?: string | null;
  foodicsTableName?: string | null;
  guests?: number | null;
  relayToNooks?: boolean;
};

export async function fetchOrdersForCustomer(
  customerId: string,
  merchantId: string,
): Promise<OrderRow[]> {
  if (!supabase) return [];
  // CRITICAL multi-tenant filter: same Supabase auth.uid is shared
  // across every merchant's app (one user can install Mafasa AND
  // GrindHouse and sign in with the same phone), so filtering only by
  // customer_id leaks every order this user ever placed across all
  // merchants. Filter by merchant_id too — the orders row already
  // carries it (set when the order was placed in this merchant's app).
  if (!merchantId) {
    console.warn('[Orders] fetchOrdersForCustomer called without merchantId — refusing to query (would leak across merchants)');
    return [];
  }
  // Visibility filter: orders without foodics_order_id never made it
  // to the merchant's POS. Surface them in the customer Orders tab
  // and the user sees a "Placed" record for an order the cashier
  // has no idea about. Causes:
  //   - Moyasar payment ended in `initiated` (customer abandoned 3DS)
  //   - Card was authorised but settled as failed post-auth
  //   - Foodics relay errored (bad modifier, branch closed) and the
  //     manual retry hasn't been run
  //   - Sweep cancelled it as "Abandoned payment"
  // All paths leave foodics_order_id NULL, so one filter covers them.
  // The optimistic local addOrder in OrdersContext still surfaces the
  // order the moment the customer places it; this filter only affects
  // server-fed refreshes / cold loads.
  const primary = await supabase
    .from('customer_orders')
    .select('*')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .not('foodics_order_id', 'is', null)
    .order('created_at', { ascending: false });
  if (primary.error && !isCustomerOrdersMissing(primary.error.message)) {
    console.warn('[Orders] Fetch error:', primary.error.message);
    return [];
  }
  if (!primary.error) return (primary.data ?? []) as OrderRow[];
  const fallback = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .order('created_at', { ascending: false });
  if (fallback.error) {
    console.warn('[Orders] Legacy fetch error:', fallback.error.message);
    return [];
  }
  return (fallback.data ?? []).map((r) => normalizeLegacy(r as Record<string, any>));
}

export async function fetchOrderById(
  orderId: string,
  merchantId: string,
): Promise<OrderRow | null> {
  if (!supabase || !orderId) return null;
  if (!merchantId) {
    console.warn('[Orders] fetchOrderById called without merchantId — refusing to query');
    return null;
  }
  const primary = await supabase
    .from('customer_orders')
    .select('*')
    .eq('id', orderId)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (primary.error && !isCustomerOrdersMissing(primary.error.message)) {
    console.warn('[Orders] Fetch by id error:', primary.error.message);
    return null;
  }
  if (!primary.error) return (primary.data as OrderRow | null) ?? null;
  const fallback = await supabase.from('orders').select('*').eq('id', orderId).eq('merchant_id', merchantId).maybeSingle();
  if (fallback.error) {
    console.warn('[Orders] Legacy fetch by id error:', fallback.error.message);
    return null;
  }
  return fallback.data ? normalizeLegacy(fallback.data as Record<string, any>) : null;
}

export async function insertOrder(row: OrderInsert): Promise<boolean> {
  if (!supabase) return false;
  const payload = {
    id: row.id,
    merchant_id: row.merchant_id ?? null,
    branch_id: row.branch_id ?? null,
    branch_name: row.branch_name ?? null,
    customer_id: row.customer_id,
    total_sar: row.total_sar,
    status: row.status,
    items: row.items,
    order_type: row.order_type,
    delivery_address: row.delivery_address ?? null,
    delivery_lat: row.delivery_lat ?? null,
    delivery_lng: row.delivery_lng ?? null,
    delivery_city: row.delivery_city ?? null,
    oto_id: row.oto_id ?? null,
    delivery_fee: row.delivery_fee ?? null,
    payment_id: row.payment_id ?? null,
    payment_method: row.payment_method ?? null,
  };
  const primary = await supabase.from('customer_orders').insert(payload);
  if (primary.error && !isCustomerOrdersMissing(primary.error.message)) {
    console.warn('[Orders] Insert error:', primary.error.message);
    return false;
  }
  if (primary.error && isCustomerOrdersMissing(primary.error.message)) {
    const fallback = await supabase.from('orders').insert(payload);
    if (fallback.error) {
      console.warn('[Orders] Legacy insert error:', fallback.error.message);
      return false;
    }
  }
  return true;
}

export type CommitOrderResponse = {
  success?: boolean;
  pending?: boolean;
  code?: string;
  retryAfterMs?: number;
  order?: { id: string; status: string; payment_id: string | null };
  [key: string]: unknown;
};

/** Thrown when the card payment is still settling after the retry budget. */
export class PaymentSettlingError extends Error {
  code = 'PAYMENT_SETTLING' as const;
  constructor() {
    super('Payment is still confirming');
    this.name = 'PaymentSettlingError';
  }
}

// SCAL-003: escalating client backoff that replaces the server's old fixed 2s
// sleep. Only a slow-settling payment waits, and only as long as it needs.
const SETTLING_RETRY_DELAYS_MS = [1000, 2000, 4000];

export async function commitOrder(payload: CommitOrderPayload): Promise<CommitOrderResponse> {
  // The final /commit verifies the card payment once server-side. If the
  // charge is still settling it responds 202 { pending: true }; we retry the
  // SAME payload — same order + payment id, so the server is idempotent and
  // NEVER creates a second charge — at 1s/2s/4s, then hand off to the
  // reconciliation path. Draft commits (relayToNooks:false) never return
  // pending, so they pass straight through. Every caller gets this for free.
  let attempt = 0;
  for (;;) {
    const res = await api.post<CommitOrderResponse>('/api/orders/commit', payload);
    if (!res?.pending) return res;
    if (attempt >= SETTLING_RETRY_DELAYS_MS.length) {
      throw new PaymentSettlingError();
    }
    const waitMs = Math.max(
      typeof res.retryAfterMs === 'number' ? res.retryAfterMs : 0,
      SETTLING_RETRY_DELAYS_MS[attempt],
    );
    await new Promise((r) => setTimeout(r, waitMs));
    attempt += 1;
  }
}

// customerCancelOrder() removed: end users cannot cancel orders per
// platform policy. The complaint flow is the single refund path. Any
// remaining UI button that referenced this function should now route to
// the complaint-submit screen instead.

export async function customerMarkReceived(orderId: string): Promise<{
  success: boolean;
  status?: string;
  error?: string;
  unlocksInMs?: number;
}> {
  return api.post<{ success: boolean; status?: string; error?: string; unlocksInMs?: number }>(
    `/api/orders/${orderId}/customer-received`,
    {},
  );
}

/**
 * Curbside arrival ping — fire when the customer parks at the
 * branch on a "receive from your car" order. Server validates the
 * order is drivethru + foodics-relayed + not already arrived, then
 * stamps customer_arrived_at and relays to nooksweb to push the
 * cashier device. Idempotent: a re-tap on the same order returns
 * `alreadyArrived: true` with the original timestamp instead of
 * 4xxing, so a flaky-network retry doesn't surface as an error.
 */
export async function customerMarkArrived(orderId: string): Promise<{
  success: boolean;
  customerArrivedAt?: string;
  alreadyArrived?: boolean;
  error?: string;
}> {
  return api.post<{ success: boolean; customerArrivedAt?: string; alreadyArrived?: boolean; error?: string }>(
    `/api/orders/${orderId}/customer-arrived`,
    {},
  );
}

export async function holdOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  return api.post<{ success: boolean; error?: string }>(`/api/orders/${orderId}/hold`, {});
}

export async function resumeOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  return api.post<{ success: boolean; error?: string }>(`/api/orders/${orderId}/resume`, {});
}

export async function getOrderStatus(orderId: string): Promise<{
  status: string;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  canCustomerCancel: boolean;
  cancelTimeRemaining: number;
}> {
  return api.get(`/api/orders/${orderId}/status`);
}

/* ── Complaints API ── */
export type ComplaintInsert = {
  complaint_type: 'missing_item' | 'wrong_item' | 'quality_issue' | 'other';
  description?: string;
  photo_urls?: string[];
  items?: { item_name: string; quantity: number; price: number }[];
  customer_id: string;
};

export type ComplaintRow = {
  id: string;
  order_id: string;
  complaint_type: string;
  description: string | null;
  photo_urls: string[];
  items: unknown;
  requested_refund_amount: number | null;
  approved_refund_amount: number | null;
  status: string;
  merchant_notes: string | null;
  created_at: string;
  resolved_at: string | null;
};

export async function submitComplaint(orderId: string, data: ComplaintInsert): Promise<{ success: boolean; complaint?: ComplaintRow; error?: string }> {
  return api.post(`/api/complaints/${orderId}`, data);
}

export async function getOrderComplaint(
  orderId: string,
  merchantId: string,
): Promise<ComplaintRow | null> {
  if (!supabase) return null;
  // Multi-tenant scope: order_complaints rows are keyed by
  // (order_id, merchant_id). Without the merchant_id filter a customer
  // could fetch a complaint row from a different merchant if order ids
  // ever collide. Refuse to query without it — log + return null so a
  // missed merchantId surfaces as "no complaint" instead of leaking.
  if (!merchantId) {
    console.warn('[Orders] getOrderComplaint called without merchantId — refusing to query');
    return null;
  }
  const { data } = await supabase
    .from('order_complaints')
    .select('*')
    .eq('order_id', orderId)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  return (data as ComplaintRow | null) ?? null;
}

// DB-1 (2026-07-10): subscribeToOrders — the persistent Supabase Realtime
// `postgres_changes` channel on customer_orders — was REMOVED. It is the
// platform's first scale wall: postgres_changes evaluates every WAL change
// against every subscriber's filter + RLS (O(subscribers) per change) and
// saturates at low-hundreds of concurrent sessions, well below the target.
// Order-status updates are covered without it by three paths that remain:
//   1. the server sends a push on every status transition (Foodics webhook →
//      sendLocalizedPushToCustomer) — the primary live channel, UNCHANGED;
//   2. an AppState 'active' refresh pulls fresh rows on foreground; and
//   3. a light 30s foreground poll in OrdersContext (cleared on background).
// NEEDS ON-DEVICE TESTING before the next OTA — see the matching comment in
// src/context/OrdersContext.tsx.
