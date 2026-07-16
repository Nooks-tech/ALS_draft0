/**
 * Canonical loyalty earn base for an order: net-of-loyalty spend.
 *
 * base = total_sar − wallet_paid_sar − cashback_paid_sar, clamped ≥ 0.
 *
 * total_sar is already net of promo + cashback DISCOUNTS but gross of the
 * wallet/card tender split, so subtracting the wallet- and cashback-PAID
 * portions leaves only the money the customer genuinely spent out of pocket —
 * the LOY-7/LOY-8/M15 rule that one physical purchase earns the same amount
 * regardless of which path (status cron, customer-received, internal /earn)
 * fires the earn. This used to exist as three separate copies (orders.ts,
 * the /earn route, and by-hand in callers), which is exactly how the audits'
 * "earn base inconsistent" findings happen; keep the ONE definition here.
 */
export function netOfLoyaltyEarnBase(order: {
  total_sar?: number | null;
  wallet_paid_sar?: number | null;
  cashback_paid_sar?: number | null;
}): number {
  const total = Number(order.total_sar ?? 0);
  const wallet = Number(order.wallet_paid_sar ?? 0);
  const cashback = Number(order.cashback_paid_sar ?? 0);
  return Math.max(0, Number((total - wallet - cashback).toFixed(2)));
}
