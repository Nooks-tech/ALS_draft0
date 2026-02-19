/**
 * Nooks public API – branches for a merchant.
 * Used when EXPO_PUBLIC_NOOKS_API_BASE_URL is set so new merchants/branches appear without app changes.
 */
import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type NooksBranch = {
  id: string;
  name: string;
  address?: string;
  distance?: string;
  /** When Nooks exposes it – used for OTO request-delivery */
  oto_warehouse_id?: string;
  [key: string]: unknown;
};

export async function fetchNooksBranches(merchantId: string): Promise<NooksBranch[]> {
  if (!BASE_URL.trim() || !merchantId.trim()) return [];
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/branches`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as NooksBranch[] | { branches?: NooksBranch[] };
  const list = Array.isArray(data) ? data : data?.branches ?? [];
  return list.map((b) => ({
    id: String(b.id),
    name: String(b.name ?? ''),
    address: b.address,
    distance: b.distance,
    oto_warehouse_id: b.oto_warehouse_id,
  }));
}
