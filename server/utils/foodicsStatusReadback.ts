/**
 * Credentialed Foodics order-status read-back, via nooksweb (which holds the
 * per-merchant Foodics OAuth token; ALS's own services/foodics.ts is deprecated
 * and global-token). Shared by the order-status cron and the /commit sweep.
 *
 * WHY (2026-07-15): the Foodics webhook never reaches Nooks — registration is
 * blocked by Foodics permissions and unsigned deliveries are quarantined by the
 * Phase A containment. So a cashier tapping Accept/Close was invisible: the
 * app's status froze at "Placed" AND the no-accept sweep cancelled+refunded
 * orders the store had already accepted (observed live). This read-back is the
 * reliable substitute; nooksweb writes the fresh status to customer_orders so
 * the app's direct-Supabase poll sees it.
 *
 * Best-effort by construction: never throws, short timeout. Callers MUST treat
 * a failed read as UNKNOWN — never as permission to cancel.
 */

const NOOKS_API_BASE_URL = (process.env.NOOKS_API_BASE_URL || '').trim().replace(/\/+$/, '');
const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

export interface FoodicsStatusReadbackInput {
  merchantId: string;
  internalOrderId: string;
  foodicsOrderId: string;
}

export interface FoodicsStatusReadbackResult {
  ok: boolean;
  synced?: boolean;
  from?: string | null;
  to?: string | null;
  accepted?: boolean;
  reason?: string;
}

export async function readBackFoodicsStatusViaNooks(
  input: FoodicsStatusReadbackInput,
): Promise<FoodicsStatusReadbackResult> {
  if (!NOOKS_API_BASE_URL || !NOOKS_INTERNAL_SECRET) {
    return { ok: false, reason: 'nooks internal relay not configured' };
  }
  try {
    const response = await fetch(`${NOOKS_API_BASE_URL}/api/internal/foodics-order-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, reason: data?.error || `status read-back HTTP ${response.status}` };
    }
    return { ok: true, ...(data ?? {}) };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'status read-back threw' };
  }
}
