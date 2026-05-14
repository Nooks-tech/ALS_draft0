/**
 * Nooks public API – promo codes (Marketing Studio).
 * GET {NOOKS_BASE}/api/public/merchants/{merchantId}/promos
 * Used in Offers tab and at checkout; each promo has name (display; may equal code).
 * Returns [] when EXPO_PUBLIC_NOOKS_API_BASE_URL is not set or endpoint fails.
 */
import Constants from 'expo-constants';
import { fetchWithTimeout } from '../lib/persistentCache';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type NooksPromoScope = 'total' | 'delivery';

export type NooksPromo = {
  id: string;
  code: string;
  name: string; // display name; may equal code
  type?: 'percentage' | 'amount' | 'percent' | 'fixed';
  value?: number;
  /** What the discount applies to. Defaults to 'total' (subtotal of products). */
  scope?: NooksPromoScope;
  valid_from?: string;
  valid_until?: string;
  description?: string;
  image_url?: string | null;
  imageUrl?: string | null;
};

export async function fetchNooksPromos(merchantId: string): Promise<NooksPromo[]> {
  if (!BASE_URL.trim() || !merchantId.trim()) return [];
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/promos`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const data = (await res.json()) as NooksPromo[] | { promos?: NooksPromo[] };
    if (Array.isArray(data)) return data;
    if (data && Array.isArray((data as { promos?: NooksPromo[] }).promos)) return (data as { promos: NooksPromo[] }).promos;
    return [];
  } catch {
    return [];
  }
}

export type NooksPromoValidationResult =
  | {
      valid: true;
      code: string;
      type: 'percent' | 'fixed';
      value: number;
      scope: 'total' | 'delivery';
      discountAmount: number;
      newTotal: number;
    }
  | { valid: false; error: string };

/**
 * Hits the nooksweb /promos/validate endpoint with customer_id so
 * the per-customer usage cap is enforced AT APPLY-TIME (not just
 * commit-time). This is the customer's first feedback when entering
 * a code — if they've already used it, they see the error inline
 * instead of after pressing Pay.
 *
 * Server-side redeem_promo at commit-time is the FINAL gate; this
 * function gives the merchant good UX by catching invalid codes
 * before the payment sheet opens.
 */
export async function validateNooksPromo(params: {
  merchantId: string;
  code: string;
  subtotal: number;
  deliveryFee?: number;
  customerId?: string | null;
}): Promise<NooksPromoValidationResult> {
  const { merchantId, code, subtotal, deliveryFee = 0, customerId } = params;
  if (!BASE_URL.trim() || !merchantId.trim() || !code.trim()) {
    return { valid: false, error: 'invalid input' };
  }
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/promos/validate`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        subtotal,
        delivery_fee: deliveryFee,
        ...(customerId ? { customer_id: customerId } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { valid: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    }
    if (data.valid !== true) {
      return { valid: false, error: typeof data.error === 'string' ? data.error : 'Invalid code' };
    }
    return {
      valid: true,
      code: String(data.code ?? code),
      type: (data.type as 'percent' | 'fixed') ?? 'fixed',
      value: Number(data.value ?? 0),
      scope: (data.scope as 'total' | 'delivery') ?? 'total',
      discountAmount: Number(data.discount_amount ?? 0),
      newTotal: Number(data.new_total ?? 0),
    };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function consumeNooksPromo(merchantId: string, code: string): Promise<void> {
  if (!BASE_URL.trim() || !merchantId.trim() || !code.trim()) return;
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/promos/use`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      console.warn('[Nooks] Promo usage increment failed:', res.status, msg);
    }
  } catch {
    // Best-effort analytics counter; don't block checkout.
  }
}

/**
 * Compute the discount amount for a Nooks promo.
 *
 * The discount base depends on the promo's scope:
 *   - 'total'    (default) → applies to `subtotal` (products only, NOT delivery)
 *   - 'delivery'           → applies to `deliveryFee` only
 *
 * The caller is responsible for deducting the returned amount from the order grand total.
 */
export function calculateNooksPromoDiscount(
  promo: NooksPromo,
  subtotal: number,
  deliveryFee: number = 0,
): number {
  const rawType = String(promo.type ?? '').toLowerCase();
  const value = Number(promo.value ?? 0);
  const scope: NooksPromoScope = promo.scope === 'delivery' ? 'delivery' : 'total';
  const base = scope === 'delivery' ? deliveryFee : subtotal;
  if (value <= 0 || base <= 0) return 0;
  if (rawType === 'percentage' || rawType === 'percent') {
    return Math.round(Math.min(base * (value / 100), base) * 100) / 100;
  }
  return Math.min(value, base);
}
