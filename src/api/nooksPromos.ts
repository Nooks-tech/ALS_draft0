/**
 * Nooks public API – promo codes (Marketing Studio).
 * GET {NOOKS_BASE}/api/public/merchants/{merchantId}/promos
 * Used in Offers tab and at checkout; each promo has name (display; may equal code).
 * Returns [] when EXPO_PUBLIC_NOOKS_API_BASE_URL is not set or endpoint fails.
 */
import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type NooksPromo = {
  id: string;
  code: string;
  name: string; // display name; may equal code
  type?: 'percentage' | 'amount' | 'percent' | 'fixed';
  value?: number;
  valid_from?: string;
  valid_until?: string;
  description?: string;
};

export async function fetchNooksPromos(merchantId: string): Promise<NooksPromo[]> {
  if (!BASE_URL.trim() || !merchantId.trim()) return [];
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/promos`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as NooksPromo[] | { promos?: NooksPromo[] };
    if (Array.isArray(data)) return data;
    if (data && Array.isArray((data as { promos?: NooksPromo[] }).promos)) return (data as { promos: NooksPromo[] }).promos;
    return [];
  } catch {
    return [];
  }
}

export function calculateNooksPromoDiscount(promo: NooksPromo, subtotal: number): number {
  const rawType = String(promo.type ?? '').toLowerCase();
  const value = Number(promo.value ?? 0);
  if (value <= 0 || subtotal <= 0) return 0;
  if (rawType === 'percentage' || rawType === 'percent') {
    return Math.round(Math.min(subtotal * (value / 100), subtotal) * 100) / 100;
  }
  return Math.min(value, subtotal);
}
