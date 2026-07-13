/**
 * SCAL-004 — pure decision logic for the Foodics order-dispatch worker.
 * Source: GPT-5.6 scalability audit, finding SCAL-004.
 *
 * The worker (server/workers/orderDispatch.ts) claims finalized-but-
 * unrelayed paid orders and drives them to the Foodics POS through
 * nooksweb's internal by-id relay. This module holds ONLY the pure
 * functions that govern retry / backoff / dead-letter, with no DB, HTTP,
 * timers, Supabase, or process state — so they can be unit-tested in
 * isolation exactly the way the audit's Phase-1 test plan requires.
 *
 * SHADOW MODE: the inline /commit relay remains the single source of
 * truth. None of this runs against production until a rollout explicitly
 * sets ORDER_DISPATCH_WORKER_ENABLED=true, one merchant at a time.
 */

/**
 * Backoff schedule between failed relay attempts, in milliseconds.
 * Exactly the schedule specified by SCAL-004: 5s, 15s, 1m, 5m, 15m.
 */
export const RELAY_BACKOFF_MS: readonly number[] = [
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
];

/**
 * Relay attempts are retried up to this many failures. The MAX_RELAY_ATTEMPTS-th
 * failure triggers the compensating cancel/refund and terminal dead-letter
 * instead of another retry — a slow/poison provider row must never sit at
 * the head of the due queue forever.
 */
export const MAX_RELAY_ATTEMPTS = 5;

/**
 * Delay before the next relay attempt given the number of failures recorded
 * so far. Clamps to the last (longest) delay once the schedule is exhausted,
 * so a stuck row keeps a 15-minute cadence rather than hammering Foodics.
 *
 * Pure and exactly the SCAL-004 formula:
 *   `RELAY_BACKOFF_MS[min(attempts, len - 1)]`
 * (with a defensive floor/clamp of the index at 0 for non-integer or
 * negative inputs — the schedule for indices 0..4 is unaffected).
 */
export function computeBackoffMs(attempts: number): number {
  const idx = Math.min(
    Math.max(0, Math.floor(Number.isFinite(attempts) ? attempts : 0)),
    RELAY_BACKOFF_MS.length - 1,
  );
  return RELAY_BACKOFF_MS[idx];
}

export type DispatchOutcome = 'ok' | 'retry' | 'dead_letter';

/**
 * Classify one relay attempt into the action the worker must take.
 *
 *   - ok === true                            → 'ok'          (mark Placed/ok)
 *   - failed, attempts < MAX_RELAY_ATTEMPTS  → 'retry'       (reschedule w/ backoff)
 *   - failed, attempts >= MAX_RELAY_ATTEMPTS → 'dead_letter' (terminal)
 *
 * `refundOk` reports whether the worker's compensating cancel/refund (run
 * only once retries are exhausted) succeeded. It does NOT change the
 * retry-vs-terminal decision — a row that has failed the maximum number of
 * times is terminal and must leave the due queue either way — but the
 * worker consumes it to pick the dead-letter reason and alert severity:
 * a FAILED refund is a money-stuck row a human must resolve, while a
 * SUCCESSFUL refund means the customer was already made whole and the order
 * auto-cancelled.
 */
export function decideOutcome(params: {
  ok: boolean;
  attempts: number;
  refundOk: boolean;
}): DispatchOutcome {
  const { ok, attempts } = params;
  if (ok) return 'ok';
  if (attempts < MAX_RELAY_ATTEMPTS) return 'retry';
  return 'dead_letter';
}
