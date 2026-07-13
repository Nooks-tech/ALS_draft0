/**
 * SCAL-004 — Foodics order-dispatch worker (ALS side).
 * Source: GPT-5.6 scalability audit, finding SCAL-004.
 *
 * A dedicated Railway worker process (command: `node dist/workers/
 * orderDispatch.js`) that claims finalized-but-unrelayed paid orders from
 * the durable dispatch queue and drives each to the Foodics POS through
 * nooksweb's internal by-id relay — so a slow provider can never hold a
 * customer's checkout HTTP request or let a poison row starve healthy
 * paid orders.
 *
 * DISABLED BY DEFAULT. `startOrderDispatchWorker()` is a no-op unless
 * `ORDER_DISPATCH_WORKER_ENABLED === 'true'`, so shipping this file is
 * inert until a rollout enables it one merchant at a time. Until then the
 * inline /commit relay remains the single source of truth and every paid
 * order still relays inline exactly as before; the shadow-enqueue columns
 * on customer_orders merely make each order a claimable job for when the
 * worker is switched on.
 *
 * Money safety: on terminal failure the worker reuses the SAME idempotent
 * cancel/refund helper the inline relay-failure path uses
 * (refundOrderToWallet) — it invents no new money movement. The claim RPC
 * (claim_foodics_dispatch_jobs) uses FOR UPDATE SKIP LOCKED with a 2-minute
 * reclaim window and already excludes dead-lettered rows.
 */
import '../loadEnv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { captureError } from '../utils/sentryContext';
import {
  MAX_RELAY_ATTEMPTS,
  computeBackoffMs,
  decideOutcome,
  type DispatchOutcome,
} from './orderDispatchLogic';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOOKS_API_BASE_URL = (process.env.NOOKS_API_BASE_URL || process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

// Stable-ish worker identity for foodics_relay_claimed_by / logs. The RPC
// reclaims any row a dead worker left claimed after 2 minutes, so this only
// needs to be unique enough to attribute claims across replicas.
const WORKER_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'orderDispatch'}:${process.pid}`;

const CLAIM_LIMIT = 4; // concurrency — 4 jobs per claim, processed together
const POLL_BUSY_MS = 500; // poll cadence when the last claim found work
const POLL_IDLE_MS = 2_000; // poll cadence when the queue was empty
const DRAIN_TIMEOUT_MS = 30_000; // SIGTERM: stop claiming, finish in-flight jobs

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Row shape returned by claim_foodics_dispatch_jobs (subset the worker reads). */
export interface ClaimedOrder {
  id: string;
  merchant_id?: string | null;
  customer_id?: string | null;
  foodics_relay_attempts?: number | null;
  [key: string]: unknown;
}

/** Result of one call to nooksweb's internal by-id dispatch relay. */
export interface RelayResult {
  ok: boolean;
  foodicsOrderId?: string | null;
  error?: string;
  status?: number;
}

/**
 * CONTRACT (owned by nooksweb, built separately): POST the order id to the
 * internal by-id relay; success returns `{ foodics_order_id }`. Kept as a
 * standalone function and injected into processClaimedOrder so it can be
 * mocked in unit tests — the worker is never run against the live relay or
 * DB from tests.
 */
export async function callDispatchRelay(orderId: string): Promise<RelayResult> {
  if (!NOOKS_API_BASE_URL) return { ok: false, error: 'NOOKS_API_BASE_URL is not configured' };
  if (!NOOKS_INTERNAL_SECRET) return { ok: false, error: 'NOOKS_INTERNAL_SECRET is not configured' };
  try {
    const res = await fetch(`${NOOKS_API_BASE_URL}/api/internal/dispatch-relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
      },
      body: JSON.stringify({ order_id: orderId }),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data && data.error) || `dispatch relay HTTP ${res.status}` };
    }
    const foodicsOrderId =
      data && typeof data.foodics_order_id === 'string' && data.foodics_order_id.trim()
        ? data.foodics_order_id.trim()
        : null;
    if (!foodicsOrderId) {
      return { ok: false, status: res.status, error: 'dispatch relay returned ok without a foodics_order_id' };
    }
    return { ok: true, foodicsOrderId, status: res.status };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'dispatch relay request threw' };
  }
}

/** Injected dependencies for processClaimedOrder (all mocked in tests). */
export interface ProcessDeps {
  relay: (orderId: string) => Promise<RelayResult>;
  refund: (
    orderId: string,
    cancelledBy: 'system',
    reason: string,
  ) => Promise<{ ok: boolean; error?: string; status?: number }>;
  db: Pick<SupabaseClient, 'from'>;
  now: () => Date;
}

/**
 * Drive ONE claimed order through a single relay attempt and persist the
 * outcome. Pure IO is injected; the retry/backoff/dead-letter policy comes
 * from orderDispatchLogic. Returns the DispatchOutcome for observability.
 *
 *   ok          → foodics_order_id set, status Placed, relay 'ok'.
 *   retry       → attempts++, relay 'pending', claim cleared, next_attempt
 *                 scheduled at now + computeBackoffMs(attempts). Reclaimable.
 *   dead_letter → retries exhausted: run the idempotent cancel/refund, then
 *                 dead-letter the row (never re-enters the claim set) and
 *                 alert. A refund SUCCESS auto-cancels + refunds the order;
 *                 a refund FAILURE is money-stuck and escalates louder.
 */
export async function processClaimedOrder(
  order: ClaimedOrder,
  deps: ProcessDeps,
): Promise<DispatchOutcome> {
  const { relay, refund, db, now } = deps;
  const priorAttempts = Math.max(0, Math.floor(Number(order.foodics_relay_attempts ?? 0)));

  const relayResult = await relay(order.id);

  // ── Success ──────────────────────────────────────────────────────────
  if (relayResult.ok && relayResult.foodicsOrderId) {
    const outcome = decideOutcome({ ok: true, attempts: priorAttempts, refundOk: false });
    await db
      .from('customer_orders')
      .update({
        foodics_order_id: relayResult.foodicsOrderId,
        status: 'Placed',
        foodics_relay_status: 'ok',
        foodics_relay_error: null,
        foodics_relay_claimed_at: null,
        foodics_relay_last_attempt_at: now().toISOString(),
      })
      .eq('id', order.id);
    return outcome; // 'ok'
  }

  const attempts = priorAttempts + 1;
  const errorMsg = (relayResult.error || 'dispatch relay failed').slice(0, 300);

  // ── Retry (below the attempt ceiling) ────────────────────────────────
  if (decideOutcome({ ok: false, attempts, refundOk: false }) === 'retry') {
    const nextAttemptAt = new Date(now().getTime() + computeBackoffMs(attempts)).toISOString();
    await db
      .from('customer_orders')
      .update({
        foodics_relay_status: 'pending',
        foodics_relay_attempts: attempts,
        foodics_relay_error: errorMsg,
        foodics_relay_claimed_at: null, // release the claim so it is reclaimable
        foodics_relay_last_attempt_at: now().toISOString(),
        foodics_relay_next_attempt_at: nextAttemptAt,
      })
      .eq('id', order.id);
    return 'retry';
  }

  // ── Terminal: retries exhausted → compensating cancel/refund ─────────
  // Reuses the SAME idempotent helper the inline relay-failure path uses.
  let refundOk = false;
  try {
    const r = await refund(
      order.id,
      'system',
      `Foodics dispatch failed after ${attempts} attempts: ${errorMsg}`,
    );
    refundOk = !!r.ok;
    if (!refundOk) {
      captureError(new Error(`Dispatch compensating refund returned not-ok: ${r.error ?? 'unknown'}`), {
        component: 'orderDispatch.refund.notOk',
        orderId: order.id,
        merchantId: order.merchant_id ?? undefined,
        customerId: order.customer_id ?? undefined,
        extra: { attempts, refundStatus: r.status },
      });
    }
  } catch (err) {
    refundOk = false;
    captureError(err, {
      component: 'orderDispatch.refund.threw',
      orderId: order.id,
      merchantId: order.merchant_id ?? undefined,
      customerId: order.customer_id ?? undefined,
      extra: { attempts },
    });
  }

  const outcome = decideOutcome({ ok: false, attempts, refundOk }); // 'dead_letter'
  const deadLetterReason = (
    refundOk
      ? `max_attempts_exceeded:auto_cancelled_refunded:${errorMsg}`
      : `max_attempts_exceeded:refund_failed:${errorMsg}`
  ).slice(0, 300);

  await db
    .from('customer_orders')
    .update({
      // On refund success the helper already flipped status to 'Cancelled';
      // we do NOT touch status here. Dead-lettering (which the claim RPC
      // excludes) guarantees the row never re-enters the due set regardless.
      foodics_relay_status: refundOk ? 'cancelled' : 'failed',
      foodics_relay_attempts: attempts,
      foodics_relay_error: errorMsg,
      foodics_relay_claimed_at: null,
      foodics_relay_last_attempt_at: now().toISOString(),
      foodics_relay_dead_lettered_at: now().toISOString(),
      foodics_relay_dead_letter_reason: deadLetterReason,
    })
    .eq('id', order.id);

  captureError(
    new Error(
      refundOk
        ? `Foodics dispatch dead-lettered after ${attempts} attempts (auto-refunded): ${errorMsg}`
        : `Foodics dispatch dead-lettered after ${attempts} attempts AND refund FAILED: ${errorMsg}`,
    ),
    {
      component: refundOk ? 'orderDispatch.deadLetter.refunded' : 'orderDispatch.deadLetter.refundFailed',
      orderId: order.id,
      merchantId: order.merchant_id ?? undefined,
      customerId: order.customer_id ?? undefined,
      extra: { attempts, refundOk, reason: deadLetterReason },
    },
  );
  return outcome; // 'dead_letter'
}

// ── Worker loop / lifecycle ────────────────────────────────────────────

let running = true;
let inFlight = 0;

async function claimBatch(db: SupabaseClient): Promise<ClaimedOrder[]> {
  const { data, error } = await db.rpc('claim_foodics_dispatch_jobs', {
    p_worker: WORKER_ID,
    p_limit: CLAIM_LIMIT,
  });
  if (error) {
    captureError(error, { component: 'orderDispatch.claim' });
    return [];
  }
  return (data ?? []) as ClaimedOrder[];
}

async function runLoop(db: SupabaseClient): Promise<void> {
  // Bind the real cancel/refund lazily so importing this module for unit
  // tests does not eagerly load the (heavy) orders route module.
  const { refundOrderToWallet } = await import('../routes/orders');
  const deps: ProcessDeps = {
    relay: callDispatchRelay,
    refund: refundOrderToWallet,
    db,
    now: () => new Date(),
  };

  while (running) {
    let claimed: ClaimedOrder[] = [];
    try {
      claimed = await claimBatch(db);
    } catch (err) {
      captureError(err, { component: 'orderDispatch.claimThrew' });
    }

    if (claimed.length > 0) {
      inFlight = claimed.length;
      await Promise.allSettled(
        claimed.map(async (order) => {
          try {
            await processClaimedOrder(order, deps);
          } catch (err) {
            captureError(err, { component: 'orderDispatch.process', orderId: order.id });
          }
        }),
      );
      inFlight = 0;
      await sleep(POLL_BUSY_MS);
    } else {
      await sleep(POLL_IDLE_MS);
    }
  }
}

function installSignalHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`[OrderDispatch] ${signal} received — stop claiming, draining up to ${DRAIN_TIMEOUT_MS}ms`);
    running = false; // stop claiming NEW work immediately
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (inFlight > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    console.log(`[OrderDispatch] drain complete (inFlight=${inFlight}) — exiting`);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Entry point. No-op unless ORDER_DISPATCH_WORKER_ENABLED === 'true', so
 * deploying this worker is inert until a rollout explicitly enables it.
 */
export function startOrderDispatchWorker(): void {
  if (process.env.ORDER_DISPATCH_WORKER_ENABLED !== 'true') {
    console.log('[OrderDispatch] disabled — set ORDER_DISPATCH_WORKER_ENABLED=true to enable. Exiting no-op.');
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[OrderDispatch] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured — cannot start.');
    return;
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  installSignalHandlers();
  console.log(`[OrderDispatch] worker ${WORKER_ID} started (concurrency ${CLAIM_LIMIT}, busy ${POLL_BUSY_MS}ms / idle ${POLL_IDLE_MS}ms)`);
  runLoop(db).catch((err) => {
    captureError(err, { component: 'orderDispatch.loopCrashed' });
    console.error('[OrderDispatch] loop crashed:', err?.message);
    process.exit(1);
  });
}

// Auto-start only when invoked directly as the process entry
// (`node dist/workers/orderDispatch.js`), never on import.
if (require.main === module) {
  startOrderDispatchWorker();
}
