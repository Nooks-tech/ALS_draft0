export type PromoDiscountScope = 'total' | 'delivery' | 'order_total';

export interface PromoDiscountConfig {
  discount_percent: number | null | undefined;
  discount_fixed: number | null | undefined;
}

/**
 * Legacy-path promo discount magnitude guard.
 *
 * Context (2026-07-15 audit, finding R1): redeem_promo's p_discount_sar is
 * caller-supplied and was only ever checked for ELIGIBILITY (expiry, usage
 * limits) — never against the promo's own configured value. The DIRECT money
 * impact of an inflated promo discount is already bounded by the legacy
 * MAX_DISCOUNT_RATIO (95%-of-menu-floor) check, so this is primarily a
 * reporting-integrity gap (a fake discount amount recorded in
 * promo_redemptions and shown to Foodics), not a drain vector.
 *
 * We deliberately guard ONLY the case that is provably safe to enforce in the
 * legacy path (no false-rejection risk):
 *
 *   - FIXED promos ('X SAR off'): a legitimate client always sends
 *     min(base, discount_fixed) <= discount_fixed. Because discount_fixed is a
 *     pure server-configured value, `claimed <= discount_fixed` can never
 *     reject a legitimate order, and it catches the concrete tampering case
 *     (a 5-SAR promo claimed as 50 SAR).
 *
 *   - PERCENT promos: the legitimate maximum is (subtotal * percent), and the
 *     legacy commit path has no server-authoritative modifier-inclusive
 *     subtotal to compute that against (computedItemFloor is a deliberate
 *     LOWER bound that can exclude paid modifiers). Enforcing against it would
 *     false-reject legitimate orders on carts with modifiers. The precise
 *     percent-magnitude check therefore belongs in the Phase B canonical quote
 *     (lib/checkout/pricing.ts::pricePromo already bounds the discount with
 *     Math.min(base, discount) against a server-authoritative subtotal), and
 *     is intentionally NOT enforced here.
 */
export interface PromoDiscountCheckResult {
  ok: boolean;
  /** The configured ceiling that was enforced, or null when the type was not checked here. */
  maxLegalDiscountSar: number | null;
  /** 'fixed' when enforced, 'percent_deferred' when intentionally not enforced in the legacy path. */
  mode: 'fixed' | 'percent_deferred' | 'unconfigured';
}

export function checkLegacyPromoDiscountMagnitude(
  claimedDiscountSar: number,
  promo: PromoDiscountConfig,
): PromoDiscountCheckResult {
  const hasFixed = promo.discount_fixed !== null && promo.discount_fixed !== undefined;
  const hasPercent = promo.discount_percent !== null && promo.discount_percent !== undefined;

  // Exactly-one-type is expected; if the row defines a fixed amount, enforce it.
  if (hasFixed) {
    const maxLegalDiscountSar = Math.max(0, Number(promo.discount_fixed));
    return {
      ok: Number(claimedDiscountSar) <= maxLegalDiscountSar + 0.01,
      maxLegalDiscountSar,
      mode: 'fixed',
    };
  }

  if (hasPercent) {
    // Deferred to the canonical quote — see doc comment. Never reject here.
    return { ok: true, maxLegalDiscountSar: null, mode: 'percent_deferred' };
  }

  // Neither configured: a promo with no discount type is malformed, but the
  // legacy path already validated eligibility via redeem_promo; treat an
  // unconfigured row as not-enforceable-here rather than rejecting.
  return { ok: true, maxLegalDiscountSar: null, mode: 'unconfigured' };
}
