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

export type NooksOperations = {
  store_status: StoreStatus;
  prep_time_minutes: number;
  delivery_mode: DeliveryMode;
};

export async function fetchNooksOperations(merchantId: string): Promise<NooksOperations | null> {
  if (!BASE_URL.trim() || !merchantId.trim()) return null;
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/operations`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as NooksOperations | Record<string, unknown>;
  if (!data || typeof data !== 'object') return null;
  const store_status = (data.store_status as StoreStatus) ?? 'open';
  const prep_time_minutes = typeof data.prep_time_minutes === 'number' ? data.prep_time_minutes : 0;
  const delivery_mode = (data.delivery_mode as DeliveryMode) ?? 'delivery_and_pickup';
  return { store_status, prep_time_minutes, delivery_mode };
}
