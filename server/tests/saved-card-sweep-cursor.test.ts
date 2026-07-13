// SCAL-013 — proves the saved-card sweep now has a DURABLE resume cursor:
// a run cut short by the wall-clock budget persists where it stopped, and
// the NEXT run resumes from that cursor instead of restarting at the head
// (the old bug: lastId was a local that reset to '' every 6-hour tick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_CURSOR,
  driveSweep,
  parseCursor,
  planSweepStep,
  type SweepCursor,
} from '../cron/savedCardSweepCursor';

// ---------------------------------------------------------------------------
// parseCursor — tolerate anything stored in the jsonb column.
// ---------------------------------------------------------------------------
test('parseCursor reads a valid {lastId}', () => {
  assert.deepEqual(parseCursor({ lastId: 'abc' }), { lastId: 'abc' });
});

test('parseCursor falls back to head on null/missing/malformed', () => {
  assert.deepEqual(parseCursor(null), EMPTY_CURSOR);
  assert.deepEqual(parseCursor(undefined), EMPTY_CURSOR);
  assert.deepEqual(parseCursor({}), EMPTY_CURSOR);
  assert.deepEqual(parseCursor({ lastId: 123 }), EMPTY_CURSOR);
  assert.deepEqual(parseCursor('nope'), EMPTY_CURSOR);
  assert.deepEqual(parseCursor([]), EMPTY_CURSOR);
});

// ---------------------------------------------------------------------------
// planSweepStep — the pure per-batch decision.
// ---------------------------------------------------------------------------
test('planSweepStep: empty page completes and resets to head', () => {
  const s = planSweepStep({ batchIds: [], batchLimit: 500, budgetExhausted: false });
  assert.equal(s.control, 'complete');
  assert.deepEqual(s.persistCursor, EMPTY_CURSOR);
});

test('planSweepStep: short page (drained tail) completes and resets even if budget spent', () => {
  const s = planSweepStep({ batchIds: ['x', 'y'], batchLimit: 500, budgetExhausted: true });
  assert.equal(s.control, 'complete');
  assert.deepEqual(s.persistCursor, EMPTY_CURSOR);
});

test('planSweepStep: full page with budget remaining advances the cursor and continues', () => {
  const s = planSweepStep({ batchIds: ['a', 'b', 'c'], batchLimit: 3, budgetExhausted: false });
  assert.equal(s.control, 'continue');
  assert.deepEqual(s.persistCursor, { lastId: 'c' });
});

test('planSweepStep: full page with budget spent persists cursor and resumes next tick', () => {
  const s = planSweepStep({ batchIds: ['a', 'b', 'c'], batchLimit: 3, budgetExhausted: true });
  assert.equal(s.control, 'resume-next-tick');
  assert.deepEqual(s.persistCursor, { lastId: 'c' });
});

// ---------------------------------------------------------------------------
// driveSweep — full paging harness across multiple runs (the report's test:
// "2-batch budget; assert run 2 starts after run 1's cursor").
// ---------------------------------------------------------------------------
function makeHarness(ids: string[], opts: { batchLimit: number; budgetMs: number; perRowMs: number }) {
  let stored: SweepCursor = EMPTY_CURSOR; // simulates the durable cron_cursors row
  let clock = 0;
  const firstFetchAfterId: (string | null)[] = [];
  let seenFirstFetchThisRun = false;

  const runOnce = async (processed: string[]) => {
    seenFirstFetchThisRun = false;
    const runStartClock = clock;
    return driveSweep<{ id: string }>({
      loadCursor: async () => stored,
      saveCursor: async (c) => {
        stored = c;
      },
      fetchBatch: async (afterId, limit) => {
        if (!seenFirstFetchThisRun) {
          firstFetchAfterId.push(afterId);
          seenFirstFetchThisRun = true;
        }
        return ids
          .filter((id) => (afterId ? id > afterId : true))
          .slice(0, limit)
          .map((id) => ({ id }));
      },
      processRow: async (row) => {
        processed.push(row.id);
      },
      now: () => clock,
      batchLimit: opts.batchLimit,
      budgetMs: opts.budgetMs,
      delay: async (ms) => {
        clock += ms; // advancing the clock inside the per-row delay burns budget
      },
      perRowDelayMs: opts.perRowMs,
    }).then((r) => {
      void runStartClock;
      return r;
    });
  };

  return {
    runOnce,
    get cursor() {
      return stored;
    },
    get firstFetchAfterId() {
      return firstFetchAfterId;
    },
  };
}

test('driveSweep resumes from the persisted cursor across budget-limited runs', async () => {
  // 5 cards, batch size 2, 100ms/card => 200ms/full-batch. Budget 150ms means
  // each run processes exactly one full batch before the budget check trips.
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const h = makeHarness(ids, { batchLimit: 2, budgetMs: 150, perRowMs: 100 });
  const processed: string[] = [];

  const r1 = await h.runOnce(processed);
  assert.equal(r1.completed, false, 'run 1 stops on budget, not drained');
  assert.deepEqual(r1.finalCursor, { lastId: 'b' }, 'run 1 persists cursor at last processed id');
  assert.deepEqual(processed, ['a', 'b']);

  const r2 = await h.runOnce(processed);
  assert.equal(h.firstFetchAfterId[1], 'b', 'run 2 first fetch starts AFTER run 1 cursor');
  assert.equal(r2.completed, false);
  assert.deepEqual(r2.finalCursor, { lastId: 'd' });
  assert.deepEqual(processed, ['a', 'b', 'c', 'd']);

  const r3 = await h.runOnce(processed);
  assert.equal(h.firstFetchAfterId[2], 'd', 'run 3 first fetch starts AFTER run 2 cursor');
  assert.equal(r3.completed, true, 'run 3 drains the tail');
  assert.deepEqual(r3.finalCursor, EMPTY_CURSOR, 'reaching the tail resets to head');
  assert.deepEqual(processed, ['a', 'b', 'c', 'd', 'e'], 'every card swept exactly once, in order, no skips/dupes');

  // A fourth run re-sweeps from the head (full cycle again).
  assert.deepEqual(h.cursor, EMPTY_CURSOR);
  const processed2: string[] = [];
  await h.runOnce(processed2);
  assert.equal(h.firstFetchAfterId[3], '', 'next full cycle starts from the head');
});

test('driveSweep completes in one run and resets when budget never trips', async () => {
  const ids = ['a', 'b', 'c'];
  const h = makeHarness(ids, { batchLimit: 500, budgetMs: 10 ** 9, perRowMs: 1 });
  const processed: string[] = [];
  const r = await h.runOnce(processed);
  assert.equal(r.completed, true);
  assert.deepEqual(r.finalCursor, EMPTY_CURSOR);
  assert.deepEqual(processed, ['a', 'b', 'c']);
  assert.equal(h.firstFetchAfterId[0], '', 'a fresh run starts at the head');
});

test('driveSweep leaves the cursor in place when a batch query fails', async () => {
  let stored: SweepCursor = { lastId: 'seed' };
  const r = await driveSweep<{ id: string }>({
    loadCursor: async () => stored,
    saveCursor: async (c) => {
      stored = c;
    },
    fetchBatch: async () => null, // simulate a query error
    processRow: async () => {
      throw new Error('should not process on query error');
    },
    now: () => 0,
    batchLimit: 500,
    budgetMs: 10 ** 9,
  });
  assert.equal(r.completed, false);
  assert.deepEqual(r.finalCursor, { lastId: 'seed' }, 'cursor untouched so next tick resumes here');
  assert.deepEqual(stored, { lastId: 'seed' });
});
