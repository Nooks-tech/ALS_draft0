/**
 * Customer orders – persist to Supabase (customer_orders table) when user is logged in.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
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
  order_type: 'delivery' | 'pickup';
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
  order_type: 'delivery' | 'pickup';
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
  orderType: 'delivery' | 'pickup';
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
  promoScope?: 'total' | 'delivery' | null;
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
  stampMilestoneIds?: string[];
  /** SUM of milestone.stamp_number for each redeemed milestone. */
  stampsConsumed?: number | null;
  /**
   * Loyalty-discount SAR (cashback-as-discount or points discount).
   * Server uses this for Foodics line shrinking; for refund-time
   * cashback reversal use cashbackAmountSar (more explicit).
   */
  loyaltyDiscountSar?: number | null;
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
  const primary = await supabase
    .from('customer_orders')
    .select('*')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
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

export async function commitOrder(payload: CommitOrderPayload) {
  return api.post<{ success: boolean; order: { id: string; status: string; payment_id: string | null } }>(
    '/api/orders/commit',
    payload
  );
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

export function subscribeToOrders(
  customerId: string,
  merchantId: string,
  onInsert: (row: OrderRow) => void,
  onUpdate: (row: OrderRow) => void
): RealtimeChannel | null {
  if (!supabase) return null;
  if (!merchantId) {
    console.warn('[Orders] subscribeToOrders called without merchantId — skipping realtime');
    return null;
  }
  const table = 'customer_orders';
  // Supabase Realtime postgres_changes filter only supports a single
  // column equality. Filter on customer_id at the wire level (so
  // we get fewer events than nothing), then drop rows whose
  // merchant_id doesn't match in the callback. Without this guard,
  // a parallel order placed by the same auth.uid on a DIFFERENT
  // merchant's app would push into THIS app's order list.
  const channel = supabase
    .channel(`${table}:${customerId}:${merchantId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table,
        filter: `customer_id=eq.${customerId}`,
      },
      (payload) => {
        const row = payload.new as OrderRow;
        if (row.merchant_id !== merchantId) return;
        onInsert(row);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table,
        filter: `customer_id=eq.${customerId}`,
      },
      (payload) => {
        const row = payload.new as OrderRow;
        if (row.merchant_id !== merchantId) return;
        onUpdate(row);
      }
    )
    .subscribe();
  return channel;
}
