/**
 * Promo code validation – checks Supabase only.
 * Merchants create codes in the Nooks dashboard (Marketing Studio); they're stored in
 * the `als_promo_codes` table per merchant. No hardcoded fallback codes.
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

  return { valid: false, code, discountAmount: 0 };
}
