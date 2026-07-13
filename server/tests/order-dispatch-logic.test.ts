// SCAL-004 — proves the Foodics order-dispatch worker's pure retry/backoff/
// dead-letter policy, and (with the relay + supabase fully mocked) that the
// worker wires that policy into the correct customer_orders column writes.
// The worker is never run against the live relay or DB here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RELAY_ATTEMPTS,
  RELAY_BACKOFF_MS,
  computeBackoffMs,
  decideOutcome,
} from '../workers/orderDispatchLogic';
import {
  processClaimedOrder,
  type ProcessDeps,
  type RelayResult,
} from '../workers/orderDispatch';

// ---------------------------------------------------------------------------
// computeBackoffMs — exact SCAL-004 schedule + clamp past the last index.
// ---------------------------------------------------------------------------
test('computeBackoffMs returns the exact SCAL-004 schedule for indices 0..4', () => {
  assert.equal(computeBackoffMs(0), 5_000);
  assert.equal(computeBackoffMs(1), 15_000);
  assert.equal(computeBackoffMs(2), 60_000);
  assert.equal(computeBackoffMs(3), 300_000);
  assert.equal(computeBackoffMs(4), 900_000);
});

test('computeBackoffMs clamps to the last (15m) delay past index 4', () => {
  assert.equal(computeBackoffMs(5), 900_000);
  assert.equal(computeBackoffMs(6), 900_000);
  assert.equal(computeBackoffMs(100), 900_000);
});

test('computeBackoffMs matches RELAY_BACKOFF_MS element-for-element', () => {
  assert.deepEqual([...RELAY_BACKOFF_MS], [5_000, 15_000, 60_000, 300_000, 900_000]);
  RELAY_BACKOFF_MS.forEach((ms, i) => assert.equal(computeBackoffMs(i), ms));
});

test('computeBackoffMs floors non-integers and clamps negatives to index 0', () => {
  assert.equal(computeBackoffMs(2.9), 60_000); // floor(2.9) = 2
  assert.equal(computeBackoffMs(-1), 5_000);
  assert.equal(computeBackoffMs(Number.NaN), 5_000);
});

// ---------------------------------------------------------------------------
// decideOutcome — ok / retry / dead_letter classifier.
// ---------------------------------------------------------------------------
test('decideOutcome: a successful relay is ok (any attempts)', () => {
  assert.equal(decideOutcome({ ok: true, attempts: 0, refundOk: false }), 'ok');
  assert.equal(decideOutcome({ ok: true, attempts: 9, refundOk: true }), 'ok');
});

test('decideOutcome: a failure below the attempt ceiling retries', () => {
  for (let a = 1; a < MAX_RELAY_ATTEMPTS; a += 1) {
    assert.equal(
      decideOutcome({ ok: false, attempts: a, refundOk: false }),
      'retry',
      `attempts=${a} should retry`,
    );
  }
});

test('decideOutcome: dead_letter after MAX_RELAY_ATTEMPTS failures even when the refund succeeded', () => {
  assert.equal(decideOutcome({ ok: false, attempts: MAX_RELAY_ATTEMPTS, refundOk: true }), 'dead_letter');
  assert.equal(decideOutcome({ ok: false, attempts: MAX_RELAY_ATTEMPTS + 4, refundOk: true }), 'dead_letter');
});

test('decideOutcome: dead_letter after MAX_RELAY_ATTEMPTS failures when the refund fails', () => {
  assert.equal(decideOutcome({ ok: false, attempts: MAX_RELAY_ATTEMPTS, refundOk: false }), 'dead_letter');
});

// ---------------------------------------------------------------------------
// processClaimedOrder — relay + supabase mocked (never touches live systems).
// Asserts the worker maps each outcome to the right column writes.
// ---------------------------------------------------------------------------
interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  eq: [string, unknown];
}

function makeDeps(opts: {
  relayResult: RelayResult;
  refundOk?: boolean;
  refundThrows?: boolean;
}): { deps: ProcessDeps; updates: RecordedUpdate[]; counter: { refund: number } } {
  const updates: RecordedUpdate[] = [];
  const counter = { refund: 0 }; // live reference so tests see mock invocations
  const NOW = new Date('2026-07-13T00:00:00.000Z');

  const db = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              updates.push({ table, payload, eq: [col, val] });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };

  const deps: ProcessDeps = {
    relay: async () => opts.relayResult,
    refund: async () => {
      counter.refund += 1;
      if (opts.refundThrows) throw new Error('refund helper threw');
      return { ok: opts.refundOk ?? false };
    },
    db: db as unknown as ProcessDeps['db'],
    now: () => NOW,
  };

  return { deps, updates, counter };
}

test('processClaimedOrder: successful relay marks Placed/ok and clears the claim', async () => {
  const { deps, updates } = makeDeps({ relayResult: { ok: true, foodicsOrderId: 'fo_123' } });
  const outcome = await processClaimedOrder({ id: 'ord_1', foodics_relay_attempts: 0 }, deps);

  assert.equal(outcome, 'ok');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].eq, ['id', 'ord_1']);
  assert.equal(updates[0].payload.foodics_order_id, 'fo_123');
  assert.equal(updates[0].payload.status, 'Placed');
  assert.equal(updates[0].payload.foodics_relay_status, 'ok');
  assert.equal(updates[0].payload.foodics_relay_claimed_at, null);
});

test('processClaimedOrder: a failure below the ceiling reschedules with backoff and stays reclaimable', async () => {
  // priorAttempts=1 → attempts becomes 2 → still < 5 → retry, backoff index 2 = 60s.
  const { deps, updates, counter } = makeDeps({ relayResult: { ok: false, error: 'boom', status: 500 } });
  const outcome = await processClaimedOrder({ id: 'ord_2', foodics_relay_attempts: 1 }, deps);

  assert.equal(outcome, 'retry');
  assert.equal(counter.refund, 0, 'no refund below the attempt ceiling');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.foodics_relay_status, 'pending');
  assert.equal(updates[0].payload.foodics_relay_attempts, 2);
  assert.equal(updates[0].payload.foodics_relay_claimed_at, null);
  assert.equal(updates[0].payload.foodics_relay_error, 'boom');
  assert.equal(
    updates[0].payload.foodics_relay_next_attempt_at,
    new Date(Date.parse('2026-07-13T00:00:00.000Z') + computeBackoffMs(2)).toISOString(),
  );
  assert.equal(updates[0].payload.foodics_relay_dead_lettered_at, undefined);
});

test('processClaimedOrder: exhausted retries + successful refund auto-cancels and dead-letters', async () => {
  // priorAttempts=4 → attempts becomes 5 → terminal. Refund succeeds.
  const { deps, updates, counter } = makeDeps({
    relayResult: { ok: false, error: 'still failing' },
    refundOk: true,
  });
  const outcome = await processClaimedOrder({ id: 'ord_3', foodics_relay_attempts: 4 }, deps);

  assert.equal(outcome, 'dead_letter');
  assert.equal(counter.refund, 1, 'compensating refund runs exactly once at the ceiling');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.foodics_relay_status, 'cancelled');
  assert.equal(updates[0].payload.foodics_relay_attempts, 5);
  assert.ok(typeof updates[0].payload.foodics_relay_dead_lettered_at === 'string');
  assert.match(String(updates[0].payload.foodics_relay_dead_letter_reason), /auto_cancelled_refunded/);
  // status is NOT overwritten here — the refund helper already set 'Cancelled'.
  assert.equal(updates[0].payload.status, undefined);
});

test('processClaimedOrder: exhausted retries + FAILED refund dead-letters as money-stuck', async () => {
  const { deps, updates, counter } = makeDeps({
    relayResult: { ok: false, error: 'still failing' },
    refundOk: false,
  });
  const outcome = await processClaimedOrder({ id: 'ord_4', foodics_relay_attempts: 4 }, deps);

  assert.equal(outcome, 'dead_letter');
  assert.equal(counter.refund, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.foodics_relay_status, 'failed');
  assert.ok(typeof updates[0].payload.foodics_relay_dead_lettered_at === 'string');
  assert.match(String(updates[0].payload.foodics_relay_dead_letter_reason), /refund_failed/);
});

test('processClaimedOrder: a throwing refund helper is treated as a failed refund and still dead-letters', async () => {
  const { deps, updates } = makeDeps({
    relayResult: { ok: false, error: 'still failing' },
    refundThrows: true,
  });
  const outcome = await processClaimedOrder({ id: 'ord_5', foodics_relay_attempts: 4 }, deps);

  assert.equal(outcome, 'dead_letter');
  assert.equal(updates[0].payload.foodics_relay_status, 'failed');
  assert.match(String(updates[0].payload.foodics_relay_dead_letter_reason), /refund_failed/);
});
