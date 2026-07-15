// Server-authoritative order-total reconciliation (Fable-reviewed 2026-07-15).
//
// The mobile app charges via Moyasar FIRST (client-computed amount) then calls
// /api/orders/commit. This module recomputes the authoritative order total from
// server-known inputs and compares it to the client-sent total_sar, so a
// tampered client cannot charge itself a fraction of the real total.
//
// Design rules (all load-bearing — see the Fable review):
//   * Pure integer-halala arithmetic. All source prices are 2dp so
//     `Math.round(x*100)` is exact. Sum integers, compare integers, never round
//     per line (the client does a single terminal round, so per-line rounding
//     would manufacture drift).
//   * No VAT math. Every input (item price, delivery fee, promo, cashback) is
//     VAT-INCLUSIVE SAR; the reconciliation is pure inclusive arithmetic.
//   * Stage-wise clamps mirror the client exactly:
//       expected = max(0, max(0, items + delivery - promo) - cashback)
//     (a single-clamp formula diverges when a delivery-scope promo exceeds a
//     tiny cart, and expected must legitimately reach 0 for wallet/cashback/
//     free-reward orders).
//   * One-sided enforcement: reject only when the client claims LESS than the
//     server total (`total < expected - TOL`). The client's promo discount is
//     frozen at apply-time, so a customer who adds items after applying a promo
//     legitimately sends MORE than a fresh recompute — an upper bound would
//     false-reject that. Over-claims are logged (warn), never rejected.
//   * Percent promos are recomputed against the server scope base — otherwise
//     an attacker applies any live % code and claims an arbitrary discount,
//     which collapses `expected` and defeats the whole check.

export const RECONCILE_TOLERANCE_HALALAS = 10; // 0.10 SAR — ~5x modeled worst-case drift.
export const MAX_DELIVERY_FEE_HALALAS = 100 * 100; // 100 SAR sanity ceiling on a client-sent fee.

export type PromoScope = 'total' | 'delivery' | 'order_total';

export function sarToHalalas(sar: number): number {
  return Math.round(Number(sar) * 100);
}

/**
 * Server-authoritative promo discount ceiling in halalas.
 * - fixed promos: the configured discount_fixed (a pure server value).
 * - percent promos: percent × the scope base (items / delivery / items+delivery).
 * The claimed discount is then bounded by this ceiling (+ tolerance). This makes
 * BOTH promo types server-authoritative.
 */
export function promoCapHalalas(
  promo: { discount_percent?: number | null; discount_fixed?: number | null } | null,
  scope: PromoScope,
  itemsHalalas: number,
  deliveryHalalas: number,
): number {
  if (!promo) return 0;
  const hasFixed = promo.discount_fixed !== null && promo.discount_fixed !== undefined;
  const hasPercent = promo.discount_percent !== null && promo.discount_percent !== undefined;
  if (hasFixed) {
    return Math.max(0, sarToHalalas(Number(promo.discount_fixed)));
  }
  if (hasPercent) {
    const base =
      scope === 'delivery'
        ? deliveryHalalas
        : scope === 'order_total'
          ? itemsHalalas + deliveryHalalas
          : itemsHalalas;
    const pct = Number(promo.discount_percent);
    if (!Number.isFinite(pct) || pct < 0) return 0;
    // Integer-halala percent: round(base * pct / 100).
    return Math.max(0, Math.round((Math.max(0, base) * pct) / 100));
  }
  return 0;
}

export interface ReconcileInputs {
  itemsHalalas: number; // server-authoritative items subtotal (reward items = 0), VAT-inclusive
  deliveryHalalas: number; // clamped; 0 for non-delivery
  claimedPromoHalalas: number; // client-claimed promo discount
  promoCapHalalas: number; // server ceiling for the promo (see promoCapHalalas)
  validatedCashbackHalalas: number; // already matched to the ledger redemption
  clientTotalHalalas: number; // total_sar the client sent
  tolerance?: number;
}

export interface ReconcileResult {
  expectedHalalas: number;
  effectivePromoHalalas: number;
  deltaHalalas: number; // client - expected
  underclaim: boolean; // client claimed too little => tampering
  overclaim: boolean; // client claimed too much => warn only
}

export function reconcileOrderTotal(input: ReconcileInputs): ReconcileResult {
  const tol = input.tolerance ?? RECONCILE_TOLERANCE_HALALAS;
  // Bound the claimed promo by the server ceiling (+ tolerance). Never trust a
  // claim above what the promo can legally yield.
  const effectivePromoHalalas = Math.max(
    0,
    Math.min(input.claimedPromoHalalas, input.promoCapHalalas + tol),
  );
  const afterPromo = Math.max(0, input.itemsHalalas + input.deliveryHalalas - effectivePromoHalalas);
  const expectedHalalas = Math.max(0, afterPromo - input.validatedCashbackHalalas);
  const deltaHalalas = input.clientTotalHalalas - expectedHalalas;
  return {
    expectedHalalas,
    effectivePromoHalalas,
    deltaHalalas,
    underclaim: input.clientTotalHalalas < expectedHalalas - tol,
    overclaim: input.clientTotalHalalas > expectedHalalas + tol,
  };
}

export function clampDeliveryHalalas(orderType: string, clientDeliverySar: unknown): number {
  if (orderType !== 'delivery') return 0;
  const h = sarToHalalas(Number(clientDeliverySar) || 0);
  return Math.max(0, Math.min(h, MAX_DELIVERY_FEE_HALALAS));
}
