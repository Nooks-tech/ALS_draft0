/**
 * SCAL-003: classify a FAILED Moyasar verification on the single-verify
 * checkout path.
 *
 * The final /commit verifies the card payment exactly once (the fixed 2s
 * server sleep is gone). When that verify comes back not-ok we must decide:
 * is the charge still SETTLING (so the client should retry the same commit —
 * same order + payment id, no new charge), or is it TERMINALLY declined?
 *
 *   - Moyasar 'initiated' / 'pending'  → still settling (3DS just authorized,
 *     capture not landed yet). The old 2s sleep existed exactly to wait this
 *     out; we now return 202 and let the client retry at 1s/2s/4s.
 *   - A transient/ retryable verify error (429/5xx/timeout/network) → the
 *     payment may well be paid; treat as settling and retry rather than
 *     402-declining a possibly-paid order.
 *   - Anything else ('failed', 'voided', wrong amount, …) → terminal → 402.
 *
 * Pure and dependency-free so the exact 202-vs-402 boundary is unit-tested.
 */
export function isPaymentStillSettling(
  status: string | null | undefined,
  retryable: boolean,
): boolean {
  if (retryable) return true;
  const s = (status ?? '').trim().toLowerCase();
  return s === 'initiated' || s === 'pending';
}
