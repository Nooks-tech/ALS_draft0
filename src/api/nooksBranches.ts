/**
 * Nooks public API – branches for a merchant.
 * Used when EXPO_PUBLIC_NOOKS_API_BASE_URL is set so new merchants/branches appear without app changes.
 */
import Constants from 'expo-constants';
import { fetchWithTimeout } from '../lib/persistentCache';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type NooksBranch = {
  id: string;
  name: string;
  name_localized?: string;
  address?: string;
  distance?: string;
  /** OTO pickup location code – used for delivery dispatch */
  oto_warehouse_id?: string;
  latitude?: number;
  longitude?: number;
  open_from?: string;
  open_till?: string;
  pickup_promising_time?: number;
  delivery_promising_time?: number;
  [key: string]: unknown;
};

export async function fetchNooksBranches(merchantId: string): Promise<NooksBranch[]> {
  if (!BASE_URL.trim() || !merchantId.trim()) return [];
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/branches`;
  // Wrap with timeout + try/catch so offline / captive-portal fetches
  // resolve quickly to [] instead of hanging the menu screen forever.
  let data: NooksBranch[] | { branches?: NooksBranch[] };
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    data = (await res.json()) as NooksBranch[] | { branches?: NooksBranch[] };
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data?.branches ?? [];
  return list.map((b) => ({
    id: String(b.id),
    name: String(b.name ?? ''),
    name_localized: typeof b.name_localized === 'string' ? b.name_localized : undefined,
    address: b.address,
    distance: b.distance,
    oto_warehouse_id: b.oto_warehouse_id,
    latitude: typeof b.latitude === 'number' ? b.latitude : undefined,
    longitude: typeof b.longitude === 'number' ? b.longitude : undefined,
    open_from: typeof b.open_from === 'string' ? b.open_from : undefined,
    open_till: typeof b.open_till === 'string' ? b.open_till : undefined,
    pickup_promising_time: typeof b.pickup_promising_time === 'number' ? b.pickup_promising_time : undefined,
    delivery_promising_time: typeof b.delivery_promising_time === 'number' ? b.delivery_promising_time : undefined,
  }));
}
