/**
 * Promo code validation – checks Supabase (or falls back to hardcoded for demo).
 * Restaurant owner creates codes via Supabase Studio / Retool / Rowy.
 * App calculates discount and sends to Foodics with the order.
 */
import { supabase } from './supabase';

export type PromoType = 'percentage' | 'amount';

export interface PromoResult {
  valid: boolean;
  code: string;
  type?: PromoType;
  value?: number;
  name?: string;
  discountAmount: number;
}

// Fallback codes when Supabase is not configured (for local dev / demo)
const FALLBACK_PROMOS: Record<string, { type: PromoType; value: number; name: string }> = {
  TEST2026: { type: 'percentage', value: 0.15, name: 'Test 15% off' },
  SAVE15: { type: 'percentage', value: 0.15, name: '15% off' },
  FLAT10: { type: 'amount', value: 10, name: '10 SAR off' },
};

function calculateDiscount(
  type: PromoType,
  value: number,
  subtotal: number
): number {
  if (type === 'percentage') {
    return Math.round(Math.min(subtotal * value, subtotal) * 100) / 100;
  }
  return Math.min(value, subtotal);
}

/**
 * Validate a promo code and compute discount for the given subtotal.
 */
export async function validatePromoCode(
  inputCode: string,
  subtotal: number
): Promise<PromoResult> {
  const code = inputCode.trim().toUpperCase();
  if (!code || subtotal <= 0) {
    return { valid: false, code, discountAmount: 0 };
  }

  // Try Supabase first (ALS-owned table; avoids conflict with Nooks promo_codes)
  if (supabase) {
    const { data, error } = await supabase
      .from('als_promo_codes')
      .select('code, type, value, name, max_uses, uses_count, valid_from, valid_until')
      .ilike('code', code)
      .eq('active', true)
      .maybeSingle();

    if (!error && data) {
      const now = new Date().toISOString();
      if (data.valid_from && data.valid_from > now) {
        return { valid: false, code, discountAmount: 0 };
      }
      if (data.valid_until && data.valid_until < now) {
        return { valid: false, code, discountAmount: 0 };
      }
      if (data.max_uses != null && (data.uses_count || 0) >= data.max_uses) {
        return { valid: false, code, discountAmount: 0 };
      }

      const type = (data.type as PromoType) || 'percentage';
      const value = Number(data.value) || 0;
      const discountAmount = calculateDiscount(type, value, subtotal);

      return {
        valid: true,
        code: data.code,
        type,
        value,
        name: data.name || undefined,
        discountAmount,
      };
    }
  }

  // Fallback to hardcoded promos when Supabase is not configured
  const fallback = FALLBACK_PROMOS[code];
  if (fallback) {
    const discountAmount = calculateDiscount(fallback.type, fallback.value, subtotal);
    return {
      valid: true,
      code,
      type: fallback.type,
      value: fallback.value,
      name: fallback.name,
      discountAmount,
    };
  }

  return { valid: false, code, discountAmount: 0 };
}
