/**
 * Payment-orphan sweep cron — runs every 5 minutes.
 *
 * Closes the Apple Pay / saved-card money-safety gap: those checkout paths
 * capture the card CLIENT-SIDE before POST /api/orders/commit is ever sent
 * (see app/checkout.tsx's PaymentConfig + commitOrder). If the app crashes,
 * the network drops, or the user kills the app in the window between the
 * Apple Pay sheet completing and the commit request landing, NO SERVER CODE
 * RUNS — the customer is charged and no customer_orders row is ever
 * created. Every other sweep in this codebase (savedCardSweep,
 * paymentProcessingHealth, /internal/sweep-abandoned-payments) filters on
 * an EXISTING customer_orders row, so a payment whose order never landed is
 * invisible to all of them.
 *
 * nooksweb's Moyasar webhook (app/api/webhooks/moyasar/route.ts,
 * accruePlatformFee's orphan branch) is the one place that reliably learns
 * "Moyasar says this payment is paid" independently of the commit flow. It
 * now records a row here (supabase/migrations/20260716050000_payment_
 * orphan_candidates.sql) instead of only auditing its own lost platform
 * fee — but it deliberately does NOT refund inline, because "paid with no
 * order row yet" is the NORMAL transient state of every healthy in-flight
 * order. This cron is the delayed, safe half of that design: only after a
 * grace window comfortably longer than any legitimate commit/settling path
 * do we treat a candidate as a real orphan and reverse it.
 *
 * GRACE_WINDOW_MS = 30 minutes. Evidence for "comfortably longer than any
 * legitimate path": the mobile API client hard-aborts every request at 15s
 * (src/api/client.ts REQUEST_TIMEOUT_MS), and the one place the server
 * asks the client to wait out a still-settling charge is capped at 1s+2s+4s
 * of retries (src/api/orders.ts SETTLING_RETRY_DELAYS_MS) before it gives
 * up client-side — there is no background/offline queue that resumes a
 * commit later. So a HEALTHY order's payment→commit gap is realistically
 * sub-30-second, not sub-30-minute. 30 minutes is intentionally generous
 * padding on top of that (clock skew between client/server/Moyasar, a cron
 * outage, the webhook's own delivery lag) — it is a safety margin, not a
 * measurement of the real settling path. Named + commented so it's an easy
 * knob if 30 minutes proves too conservative (customer money sits
 * un-refunded for up to this long) or not conservative enough.
 *
 * Reversal machinery is NOT new: this reuses the exact strict-binding
 * verify-then-cancel orchestration orders.ts already uses for a rejected
 * first-commit charge (voidChargeOnRejectedCommit ->
 * reverseStrictlyBoundRejectedPayment, server/utils/rejectedFinalPayment.ts).
 * Binding is provable the same way: the payment's own Moyasar metadata
 * carries metadata.order_id (app/checkout.tsx's PaymentConfig sets it), so
 * verifyPaidPayment's requireOrderBinding check proves THIS payment belongs
 * to THIS candidate's order id before any provider mutation is attempted —
 * an attacker-supplied or unrelated payment_id can never be voided/refunded
 * through this path.
 *
 * Concurrency / idempotency (verified in code, not assumed):
 *   - tryClaimCronTick keeps at most one replica's tick alive at a time, so
 *     there is no true concurrent execution of this cron against itself.
 *   - The realistic double-processing case is a tick that reverses a
 *     payment successfully but crashes/restarts before persisting
 *     resolved_at — the next tick re-fetches the SAME still-unresolved row.
 *     cancelPayment (server/services/payment.ts) re-reads Moyasar's LIVE
 *     payment state before writing anything: a payment already 'voided' or
 *     fully refunded short-circuits to method:'void'/'refund' WITHOUT
 *     issuing a second provider write. So a second pass over an
 *     already-reversed payment classifies as completed/'reversed' again —
 *     not a double-refund.
 *   - Arriving to find the payment ALREADY reversed is the COMMON case, not
 *     an edge: /commit's own rejection paths void the charge inline, while
 *     the webhook records the candidate a moment earlier, when the payment
 *     is still 'paid'. verifyPaidPayment only passes on 'paid'/'captured',
 *     so binding can never verify for those and they'd all land in
 *     'manual_review' — a permanent flag plus a Sentry error on every retry,
 *     for payments that are perfectly fine. So a candidate whose provider
 *     status is already 'voided'/'refunded'/'failed' resolves terminally as
 *     'not_paid' (nothing owed) and leaves the queue. The same applies to
 *     the narrower crash-between-cancel-and-persist case. Only a genuinely
 *     unprovable binding earns 'manual_review' — which stays NON-terminal so
 *     a transient cause can still self-heal on a later pass.
 *   - cancelPayment's ambiguous-write outcome (method:'unknown', Moyasar
 *     429/5xx/timeout on the void/refund call itself) is also safe to
 *     retry: the next tick's fresh read-back tells us whether the
 *     ambiguous write actually landed (now 'voided'/'refunded' -> resolves
 *     clean) or didn't (still 'paid'/'captured' -> retries the write) —
 *     never a blind second charge/refund.
 */
import { createClient } from '@supabase/supabase-js';
import { runWithHeartbeat } from '../utils/cronHeartbeat';
import { captureError } from '../utils/sentryContext';
import { writeAudit } from '../utils/auditLog';
import { verifyPaidPayment, cancelPayment } from '../services/payment';
import { reverseStrictlyBoundRejectedPayment } from '../utils/rejectedFinalPayment';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes — see header for why this needn't be tighter
// GRACE WINDOW: see header comment. Must exceed the longest legitimate
// settling window (realistically sub-30s per the client-timeout evidence
// above) with a wide safety margin, since crossing it triggers an
// irreversible provider-side void/refund of real customer money.
const GRACE_WINDOW_MS = 30 * 60 * 1000;
const BATCH_LIMIT = 50; // capped per tick; logged (not silently dropped) when there's more
// Wall-clock budget for a single tick. Each candidate can cost up to 2
// sequential Moyasar round-trips (verify + cancel), each with its own
// 5-8s timeout deep in payment.ts — a full 50-row batch's worst case can
// exceed the 5-minute poll interval. Stop issuing new reversals once the
// deadline passes and leave the remainder for the next tick (same
// oldest-first query re-picks them — nothing is skipped, only deferred).
const PROCESS_DEADLINE_MS = 4 * 60 * 1000;
// Cron-lock TTL must cover the worst-case tick duration (PROCESS_DEADLINE_MS
// plus the final in-flight candidate's own worst-case latency) so a slow
// tick doesn't get its lock stolen mid-run by another replica.
const CRON_LOCK_TTL_SECONDS = 5 * 60;

type OrphanCandidateRow = {
  payment_id: string;
  merchant_id: string;
  amount_halalas: number;
  metadata_order_id: string | null;
  metadata_customer_id: string | null;
  first_seen_at: string;
  attempts: number;
};

/**
 * Did the order actually land late? Checked BOTH ways — by the payment_id
 * the candidate was recorded under, and by the order id carried in the
 * payment's own metadata — because either one landing means the order is
 * healthy and nothing should be reversed. Scoped to merchant_id as a
 * tenant-safety belt (Moyasar payment/order ids are already globally
 * unique in practice, but this costs nothing and matches how the rest of
 * this codebase scopes lookups).
 */
async function orderAlreadyLanded(
  admin: NonNullable<typeof supabaseAdmin>,
  candidate: OrphanCandidateRow,
): Promise<{ found: boolean; queryError?: string }> {
  const byPaymentId = await admin
    .from('customer_orders')
    .select('id')
    .eq('merchant_id', candidate.merchant_id)
    .eq('payment_id', candidate.payment_id)
    .limit(1)
    .maybeSingle();
  if (byPaymentId.error) return { found: false, queryError: byPaymentId.error.message };
  if (byPaymentId.data) return { found: true };

  if (candidate.metadata_order_id) {
    const byOrderId = await admin
      .from('customer_orders')
      .select('id')
      .eq('merchant_id', candidate.merchant_id)
      .eq('id', candidate.metadata_order_id)
      .limit(1)
      .maybeSingle();
    if (byOrderId.error) return { found: false, queryError: byOrderId.error.message };
    if (byOrderId.data) return { found: true };
  }
  return { found: false };
}

async function markResolved(
  admin: NonNullable<typeof supabaseAdmin>,
  paymentId: string,
  resolution: 'order_found' | 'reversed',
): Promise<void> {
  // .is('resolved_at', null) guard: belt-and-suspenders against ever
  // clobbering an already-resolved row (tryClaimCronTick already rules out
  // concurrent ticks, but this is free).
  const { error } = await admin
    .from('payment_orphan_candidates')
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('payment_id', paymentId)
    .is('resolved_at', null);
  if (error) {
    console.warn('[paymentOrphanSweep] failed to persist resolution', { paymentId, resolution, error: error.message });
    captureError(new Error(`paymentOrphanSweep resolve-persist failed: ${error.message}`), {
      component: 'cron.paymentOrphanSweep.persist',
      paymentId,
      extra: { resolution },
    });
  }
}

/**
 * Provider states that mean "this capture is already reversed, or was never
 * money we hold" — nothing is owed and the candidate is done. Anything outside
 * this set is genuinely ambiguous and earns a human.
 */
const ALREADY_SETTLED_PROVIDER_STATUSES = new Set(['voided', 'refunded', 'failed']);

async function markNotPaid(
  admin: NonNullable<typeof supabaseAdmin>,
  paymentId: string,
  providerStatus: string,
): Promise<void> {
  const { error } = await admin
    .from('payment_orphan_candidates')
    .update({
      resolved_at: new Date().toISOString(),
      resolution: 'not_paid',
      last_error: `provider status: ${providerStatus}`,
    })
    .eq('payment_id', paymentId)
    .is('resolved_at', null);
  if (error) {
    console.warn('[paymentOrphanSweep] failed to persist not_paid', { paymentId, error: error.message });
  }
}

async function markManualReview(
  admin: NonNullable<typeof supabaseAdmin>,
  candidate: OrphanCandidateRow,
  reason: string,
): Promise<void> {
  // Deliberately does NOT set resolved_at — see the migration's
  // payment_orphan_candidates_resolution_shape check + this file's header:
  // manual_review stays in the retry queue so a transient cause can
  // self-heal on a later pass instead of getting silently stuck forever.
  const { error } = await admin
    .from('payment_orphan_candidates')
    .update({
      resolution: 'manual_review',
      attempts: candidate.attempts + 1,
      last_error: reason.slice(0, 1000),
    })
    .eq('payment_id', candidate.payment_id)
    .is('resolved_at', null);
  if (error) {
    console.warn('[paymentOrphanSweep] failed to persist manual_review', {
      paymentId: candidate.payment_id,
      error: error.message,
    });
  }
}

type CandidateOutcome = 'order_found' | 'reversed' | 'manual_review' | 'not_paid' | 'deferred';

async function processCandidate(
  admin: NonNullable<typeof supabaseAdmin>,
  candidate: OrphanCandidateRow,
): Promise<CandidateOutcome> {
  const landed = await orderAlreadyLanded(admin, candidate);
  if (landed.queryError) {
    // Inconclusive read — do NOT proceed to a reversal on an unproven
    // "no order" state. Leave the row untouched; the next tick re-checks.
    console.warn('[paymentOrphanSweep] order-lookup failed, deferring to next tick', {
      paymentId: candidate.payment_id,
      error: landed.queryError,
    });
    return 'deferred';
  }
  if (landed.found) {
    await markResolved(admin, candidate.payment_id, 'order_found');
    console.log('[paymentOrphanSweep] order landed late — closing candidate', { paymentId: candidate.payment_id });
    return 'order_found';
  }

  if (!candidate.metadata_order_id) {
    // No order_id metadata on the payment at all: reverseStrictlyBoundRejectedPayment
    // requires a non-empty orderId to bind against (an empty/missing binding
    // would otherwise skip the order-match check entirely inside
    // verifyPaidPayment and defeat the whole point of "strict" binding). This
    // should be rare — every ALS payment-init path stamps metadata.order_id —
    // but if it ever happens there is no safe automated path: flag for a human
    // instead of guessing.
    await markManualReview(
      admin,
      candidate,
      'payment carries no metadata.order_id — cannot strictly bind for automated reversal',
    );
    await writeAudit({
      merchant_id: candidate.merchant_id,
      action: 'payment.orphan_manual_review',
      payload: {
        payment_id: candidate.payment_id,
        amount_halalas: candidate.amount_halalas,
        reason: 'missing_order_id_metadata',
      },
    });
    return 'manual_review';
  }

  const cleanup = await reverseStrictlyBoundRejectedPayment(
    {
      submittedPaymentId: candidate.payment_id,
      expectedAmountHalalas: candidate.amount_halalas,
      merchantId: candidate.merchant_id,
      orderId: candidate.metadata_order_id,
    },
    { verify: verifyPaidPayment, cancel: cancelPayment },
  );

  if (!cleanup.bindingVerified) {
    // A candidate whose payment is ALREADY voided/refunded/failed is the
    // healthy end state, not a problem: /commit's own rejection paths reverse
    // the charge inline, and the webhook records the candidate while the
    // payment is still 'paid' — so the reversal routinely wins the race and
    // this cron arrives to find nothing owed. Binding can never verify then
    // (verifyPaidPayment only passes on paid/captured), so without this the
    // most COMMON outcome would be a permanent manual-review flag plus a
    // Sentry error on every retry — noise that trains everyone to ignore the
    // one alarm that means real money is stuck. Close those as 'not_paid'.
    if (ALREADY_SETTLED_PROVIDER_STATUSES.has((cleanup.providerStatus ?? '').toLowerCase())) {
      await markNotPaid(admin, candidate.payment_id, cleanup.providerStatus ?? 'unknown');
      console.log('[paymentOrphanSweep] candidate already reversed at the provider — closing', {
        paymentId: candidate.payment_id,
        providerStatus: cleanup.providerStatus,
      });
      return 'not_paid';
    }
    await markManualReview(admin, candidate, cleanup.reason);
    await writeAudit({
      merchant_id: candidate.merchant_id,
      action: 'payment.orphan_manual_review',
      payload: {
        payment_id: candidate.payment_id,
        amount_halalas: candidate.amount_halalas,
        reason: cleanup.reason,
        retryable: cleanup.retryable,
        stage: 'binding_verification',
      },
    });
    captureError(new Error(`paymentOrphanSweep binding unverified: ${cleanup.reason}`), {
      component: 'cron.paymentOrphanSweep.bindingRejected',
      merchantId: candidate.merchant_id,
      paymentId: candidate.payment_id,
      extra: { retryable: cleanup.retryable },
    });
    return 'manual_review';
  }

  const { disposition, reversal, resolvedPaymentId } = cleanup;
  if (disposition.completed) {
    await markResolved(admin, candidate.payment_id, 'reversed');
    await writeAudit({
      merchant_id: candidate.merchant_id,
      action: 'payment.orphan_reversed',
      payload: {
        payment_id: resolvedPaymentId,
        amount_halalas: candidate.amount_halalas,
        reversal_method: reversal.method,
        refund_status: disposition.refundStatus,
      },
    });
    console.log('[paymentOrphanSweep] reversed orphan charge', {
      paymentId: resolvedPaymentId,
      method: reversal.method,
    });
    return 'reversed';
  }

  // disposition.pending (provider write outcome unknown) or
  // disposition.manualReview (a definite void/refund failure) both land
  // here — neither is safe to call "done".
  const reason = reversal.error || `provider reversal ${reversal.method}`;
  await markManualReview(admin, candidate, reason);
  await writeAudit({
    merchant_id: candidate.merchant_id,
    action: 'payment.orphan_manual_review',
    payload: {
      payment_id: resolvedPaymentId,
      amount_halalas: candidate.amount_halalas,
      reversal_method: reversal.method,
      refund_status: disposition.refundStatus,
      reason,
      stage: 'provider_reversal',
    },
  });
  captureError(new Error(`paymentOrphanSweep reversal needs review: ${reason}`), {
    component: disposition.pending
      ? 'cron.paymentOrphanSweep.providerUnknown'
      : 'cron.paymentOrphanSweep.reversalFailed',
    merchantId: candidate.merchant_id,
    paymentId: resolvedPaymentId,
    extra: { method: reversal.method },
  });
  return 'manual_review';
}

async function runSweep(): Promise<{ scanned: number; reversed: number; manualReview: number; orderFound: number }> {
  if (!supabaseAdmin) return { scanned: 0, reversed: 0, manualReview: 0, orderFound: 0 };
  const admin = supabaseAdmin;

  const cutoff = new Date(Date.now() - GRACE_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from('payment_orphan_candidates')
    .select('payment_id, merchant_id, amount_halalas, metadata_order_id, metadata_customer_id, first_seen_at, attempts')
    .is('resolved_at', null)
    .lt('first_seen_at', cutoff)
    .order('first_seen_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.warn('[paymentOrphanSweep] candidate query failed:', error.message);
    captureError(new Error(`paymentOrphanSweep query failed: ${error.message}`), {
      component: 'cron.paymentOrphanSweep.query',
    });
    return { scanned: 0, reversed: 0, manualReview: 0, orderFound: 0 };
  }

  const rows = (data ?? []) as OrphanCandidateRow[];
  if (rows.length === 0) return { scanned: 0, reversed: 0, manualReview: 0, orderFound: 0 };

  // No silent truncation: if this batch is exactly at the cap, find out
  // whether more are waiting and say so loudly (still safe — the
  // oldest-first ordering means the backlog drains in order over
  // subsequent ticks, it just takes more than one tick).
  if (rows.length === BATCH_LIMIT) {
    const { count, error: countError } = await admin
      .from('payment_orphan_candidates')
      .select('payment_id', { head: true, count: 'exact' })
      .is('resolved_at', null)
      .lt('first_seen_at', cutoff);
    if (!countError && typeof count === 'number' && count > BATCH_LIMIT) {
      console.warn(
        `[paymentOrphanSweep] batch capped at ${BATCH_LIMIT} — ${count} total eligible candidates outstanding, ${count - BATCH_LIMIT} deferred to later ticks`,
      );
    }
  }

  let reversed = 0;
  let manualReview = 0;
  let orderFound = 0;
  const deadlineAt = Date.now() + PROCESS_DEADLINE_MS;
  let processed = 0;
  for (const candidate of rows) {
    if (Date.now() >= deadlineAt) {
      console.warn(
        `[paymentOrphanSweep] wall-clock deadline (${PROCESS_DEADLINE_MS}ms) reached — deferring ${rows.length - processed} candidate(s) to next tick`,
      );
      break;
    }
    processed += 1;
    try {
      const outcome = await processCandidate(admin, candidate);
      if (outcome === 'order_found') orderFound += 1;
      else if (outcome === 'reversed') reversed += 1;
      else if (outcome === 'manual_review') manualReview += 1;
      // 'deferred' (inconclusive order-lookup read) intentionally isn't
      // tallied as any of the three outcomes — it's neither resolved nor a
      // review flag, just a skip for this tick.
    } catch (err: any) {
      // Never let one candidate's unexpected throw abort the batch. Leave
      // it unresolved (no partial write happened) — next tick re-picks it.
      console.error('[paymentOrphanSweep] candidate processing threw', {
        paymentId: candidate.payment_id,
        error: err?.message,
      });
      captureError(err, {
        component: 'cron.paymentOrphanSweep.candidateThrew',
        merchantId: candidate.merchant_id,
        paymentId: candidate.payment_id,
      });
      continue;
    }
  }

  return { scanned: rows.length, reversed, manualReview, orderFound };
}

let tickInFlight = false;

async function tick() {
  if (!supabaseAdmin) return;
  if (tickInFlight) {
    console.warn('[paymentOrphanSweep] previous tick still running in this process — skipping this interval');
    return;
  }
  tickInFlight = true;
  try {
    const { tryClaimCronTick } = await import('../utils/cronLock');
    if (!(await tryClaimCronTick('paymentOrphanSweep', CRON_LOCK_TTL_SECONDS))) {
      console.log('[paymentOrphanSweep] tick claimed by another replica — skipping');
      return;
    }
    await runWithHeartbeat('paymentOrphanSweep', async () => {
      const result = await runSweep();
      if (result.scanned > 0) {
        console.log('[paymentOrphanSweep] tick summary', result);
      }
      return result;
    });
  } catch (err: any) {
    console.warn('[paymentOrphanSweep] tick error (heartbeat captured):', err?.message);
  } finally {
    tickInFlight = false;
  }
}

export function startPaymentOrphanSweepCron() {
  if (!supabaseAdmin) {
    console.warn('[paymentOrphanSweep] supabase not configured — cron disabled.');
    return;
  }
  // First run 3 min after startup (after the DB warms up and other boot
  // crons have settled), then every POLL_INTERVAL_MS.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, 3 * 60 * 1000);
}
