import { sarToHalalas } from './orderTotalReconciliation';

/**
 * Merchant-configurable minimum item subtotal per order type.
 *
 * The minimum is compared against the ITEM subtotal only (VAT-inclusive SAR),
 * with the delivery fee explicitly excluded — the fee is never part of the
 * subtotal the caller passes in. NULL or 0 means "no minimum" (backward
 * compatible with branches that never configured one).
 *
 * dine_in and any unknown order type are exempt: they have no configured
 * minimum and must never fall through to another type's value.
 */

export type MinOrderType = 'delivery' | 'pickup' | 'drivethru';

export interface BranchMinSubtotalRow {
  min_order_subtotal_delivery_sar: number | null;
  min_order_subtotal_pickup_sar: number | null;
  min_order_subtotal_drivethru_sar: number | null;
}

/** The configured minimum in SAR for an order type, or null when none applies. */
export function minSubtotalSarForType(
  ops: Partial<BranchMinSubtotalRow> | null | undefined,
  orderType: string | null | undefined,
): number | null {
  if (!ops) return null;
  const raw =
    orderType === 'delivery'
      ? ops.min_order_subtotal_delivery_sar
      : orderType === 'pickup'
        ? ops.min_order_subtotal_pickup_sar
        : orderType === 'drivethru'
          ? ops.min_order_subtotal_drivethru_sar
          : null; // dine_in / unknown → exempt
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** The configured minimum in integer halalas for an order type (0 = no minimum). */
export function minSubtotalHalalasForType(
  ops: Partial<BranchMinSubtotalRow> | null | undefined,
  orderType: string | null | undefined,
): number {
  const sar = minSubtotalSarForType(ops, orderType);
  return sar === null ? 0 : sarToHalalas(sar);
}

/**
 * True when an order must be rejected for failing its minimum.
 * A zero minimum is never enforced, so an empty/free cart with no minimum passes.
 */
export function isBelowMinimum(itemsHalalas: number, minHalalas: number): boolean {
  return minHalalas > 0 && itemsHalalas < minHalalas;
}
