/**
 * Nooks public API – merchant operations (store status, prep time, delivery mode).
 * GET {NOOKS_BASE}/api/public/merchants/{merchantId}/operations
 * Poll this (or use Supabase Realtime on app_config when Nooks supports it) so the app
 * reflects when the merchant changes store status, prep time, or delivery in the dashboard.
 * See docs/MESSAGE_FROM_NOOKS_AND_ALS_RESPONSE.md.
 */
import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type StoreStatus = 'open' | 'busy' | 'closed';
export type DeliveryMode = 'delivery_and_pickup' | 'pickup_only';
export type ClosedReason = 'billing' | 'manual' | 'busy' | 'outside_hours';

export type NooksOperations = {
  store_status: StoreStatus;
  prep_time_minutes: number;
  delivery_mode: DeliveryMode;
  // Per-order-type enable flags. Server returns booleans for any
  // branch that has the migration applied; default to true for
  // pre-migration rows so the customer app doesn't accidentally
  // hide types the merchant never disabled.
  delivery_enabled?: boolean;
  pickup_enabled?: boolean;
  drivethru_enabled?: boolean;
  busy_started_at?: string | null;
  busy_seconds_left?: number | null;
  // Unified server-computed closed state (absent on old servers —
  // fall back to store_status). closed_reason explains WHY and
  // reopens_at says when the closed state ends on its own (busy
  // timer / next scheduled opening); null for manual/billing.
  effective_status?: 'open' | 'closed' | null;
  closed_reason?: ClosedReason | null;
  reopens_at?: string | null;
  busy_until?: string | null;
  // Per-order-type minimum item subtotal (SAR, VAT-inclusive, delivery fee
  // excluded). null = no minimum. Display-only hint; the server enforces it at
  // commit. Absent on branches without the migration → parsed as null.
  min_order_subtotal_delivery_sar?: number | null;
  min_order_subtotal_pickup_sar?: number | null;
  min_order_subtotal_drivethru_sar?: number | null;
};

export async function fetchNooksOperations(merchantId: string, branchId?: string | null): Promise<NooksOperations | null> {
  if (!BASE_URL.trim() || !merchantId.trim()) return null;
  const qs = branchId?.trim() ? `?branch_id=${encodeURIComponent(branchId.trim())}` : '';
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/operations${qs}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as NooksOperations | Record<string, unknown>;
  if (!data || typeof data !== 'object') return null;
  const store_status = (data.store_status as StoreStatus) ?? 'open';
  const prep_time_minutes = typeof data.prep_time_minutes === 'number' ? data.prep_time_minutes : 0;
  const delivery_mode = (data.delivery_mode as DeliveryMode) ?? 'delivery_and_pickup';
  const delivery_enabled =
    typeof data.delivery_enabled === 'boolean' ? data.delivery_enabled : delivery_mode !== 'pickup_only';
  const pickup_enabled = typeof data.pickup_enabled === 'boolean' ? data.pickup_enabled : true;
  const drivethru_enabled = typeof data.drivethru_enabled === 'boolean' ? data.drivethru_enabled : true;
  const busy_started_at = typeof data.busy_started_at === 'string' ? data.busy_started_at : null;
  const busy_seconds_left = typeof data.busy_seconds_left === 'number' ? data.busy_seconds_left : null;
  const effective_status =
    data.effective_status === 'open' || data.effective_status === 'closed' ? data.effective_status : null;
  const closed_reason =
    data.closed_reason === 'billing' ||
    data.closed_reason === 'manual' ||
    data.closed_reason === 'busy' ||
    data.closed_reason === 'outside_hours'
      ? data.closed_reason
      : null;
  const reopens_at = typeof data.reopens_at === 'string' ? data.reopens_at : null;
  const busy_until = typeof data.busy_until === 'string' ? data.busy_until : null;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const min_order_subtotal_delivery_sar = num(data.min_order_subtotal_delivery_sar);
  const min_order_subtotal_pickup_sar = num(data.min_order_subtotal_pickup_sar);
  const min_order_subtotal_drivethru_sar = num(data.min_order_subtotal_drivethru_sar);
  return {
    store_status,
    prep_time_minutes,
    delivery_mode,
    delivery_enabled,
    pickup_enabled,
    drivethru_enabled,
    busy_started_at,
    busy_seconds_left,
    effective_status,
    closed_reason,
    reopens_at,
    busy_until,
    min_order_subtotal_delivery_sar,
    min_order_subtotal_pickup_sar,
    min_order_subtotal_drivethru_sar,
  };
}
