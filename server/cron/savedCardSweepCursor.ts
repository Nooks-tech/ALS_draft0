/**
 * SCAL-013 — durable resume cursor for the saved-card sweep.
 * Source: GPT-5.6 scalability audit, finding SCAL-013.
 *
 * The sweep already keyset-pages by id within a single run, but the
 * `lastId` lived only in a local variable that reset to '' every 6-hour
 * tick. If a run hit the 2-hour wall-clock budget mid-sweep it logged
 * "resuming next tick" but the NEXT tick actually restarted at the head,
 * so cards past the budget cut-off were never reliably swept.
 *
 * This module holds the pure cursor/paging/budget logic so it can be
 * unit-tested in isolation from Supabase and Moyasar. `driveSweep`
 * loads the persisted cursor, keyset-pages from it, persists progress
 * after each batch, and on reaching the tail resets to {lastId:''} so
 * the following tick re-sweeps the whole set from the head. A run cut
 * short by the budget leaves the cursor at the last processed id, so
 * the next tick RESUMES instead of restarting.
 *
 * Deletions between runs are safe: `id > lastId` never skips a row that
 * still exists, it just no longer matches ids that were removed.
 */

/** Persisted in cron_cursors.cursor as jsonb: {"lastId": "<uuid or empty>"}. */
export interface SweepCursor {
  lastId: string;
}

/** The name key used in the shared cron_cursors table. */
export const CURSOR_NAME = 'savedCardSweep';

/** Head-of-set cursor — a fresh full sweep starts here. */
export const EMPTY_CURSOR: SweepCursor = { lastId: '' };

/**
 * Coerce whatever is stored in cron_cursors.cursor into a SweepCursor.
 * Tolerates null/missing/malformed rows by falling back to the head.
 */
export function parseCursor(raw: unknown): SweepCursor {
  if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as { lastId?: unknown }).lastId === 'string'
  ) {
    return { lastId: (raw as { lastId: string }).lastId };
  }
  return { lastId: '' };
}

/** What the sweep loop should do after processing one batch. */
export type SweepControl = 'continue' | 'resume-next-tick' | 'complete';

export interface SweepStep {
  /** Cursor value to persist to cron_cursors right now. */
  persistCursor: SweepCursor;
  /** What the driver loop should do next. */
  control: SweepControl;
}

/**
 * Pure decision for one batch: given the ids returned, the page size,
 * and whether the wall-clock budget is spent, decide what cursor to
 * persist and whether to keep paging.
 *
 * Precedence matches the original loop: a drained tail (short/empty
 * page) completes the cycle and resets the cursor even if the budget
 * is also spent; only a FULL page with budget spent resumes next tick.
 */
export function planSweepStep(params: {
  batchIds: string[];
  batchLimit: number;
  budgetExhausted: boolean;
}): SweepStep {
  const { batchIds, batchLimit, budgetExhausted } = params;

  // Empty page: we are at (or past) the tail — full cycle done, reset.
  if (batchIds.length === 0) {
    return { persistCursor: EMPTY_CURSOR, control: 'complete' };
  }

  const nextLastId = batchIds[batchIds.length - 1];
  const drained = batchIds.length < batchLimit;

  // Short page: this was the last batch. Reset so the next tick starts
  // a fresh full sweep from the head.
  if (drained) {
    return { persistCursor: EMPTY_CURSOR, control: 'complete' };
  }

  // Full page but out of budget: persist where we stopped so the next
  // tick RESUMES here instead of restarting at the head.
  if (budgetExhausted) {
    return { persistCursor: { lastId: nextLastId }, control: 'resume-next-tick' };
  }

  // Full page, budget remaining: advance the cursor and keep paging.
  return { persistCursor: { lastId: nextLastId }, control: 'continue' };
}

/** Row shape the driver needs; the real query selects more columns. */
export interface SweepRow {
  id: string;
}

export interface DriveSweepDeps<Row extends SweepRow> {
  /** Load the persisted cursor (or EMPTY_CURSOR on first run / read error). */
  loadCursor: () => Promise<SweepCursor>;
  /** Durably persist the cursor after a batch. Best-effort; may swallow errors. */
  saveCursor: (cursor: SweepCursor) => Promise<void>;
  /** Fetch up to `limit` rows with id > afterId, ordered by id ascending. */
  fetchBatch: (afterId: string, limit: number) => Promise<Row[] | null>;
  /** Process one row (probe Moyasar, delete dead cards, etc.). */
  processRow: (row: Row) => Promise<void>;
  /** Monotonic clock (Date.now in prod, injectable in tests). */
  now: () => number;
  batchLimit: number;
  budgetMs: number;
  /** Optional inter-row delay (rate limiting). No-op by default. */
  delay?: (ms: number) => Promise<unknown>;
  perRowDelayMs?: number;
  /** Optional structured logging hook. */
  onLog?: (msg: string) => void;
}

export interface DriveSweepResult {
  checked: number;
  finalCursor: SweepCursor;
  /** true = reached the tail (cursor reset); false = stopped early (query error / budget). */
  completed: boolean;
}

/**
 * The full sweep driver: durable-cursor keyset paging with a wall-clock
 * budget. Kept dependency-injected so the entire resume-across-runs
 * behaviour is unit-testable without a DB or provider.
 */
export async function driveSweep<Row extends SweepRow>(
  deps: DriveSweepDeps<Row>,
): Promise<DriveSweepResult> {
  const {
    loadCursor,
    saveCursor,
    fetchBatch,
    processRow,
    now,
    batchLimit,
    budgetMs,
    delay,
    perRowDelayMs = 0,
    onLog,
  } = deps;

  const log = (m: string) => onLog?.(m);
  const startedAt = now();
  let cursor = await loadCursor();
  if (cursor.lastId) log(`resuming from cursor lastId=${cursor.lastId}`);
  let checked = 0;

  for (;;) {
    const data = await fetchBatch(cursor.lastId, batchLimit);
    if (data === null) {
      // Query failed — leave the cursor untouched so the next tick
      // resumes from the same point. Do NOT reset.
      log('list query failed — leaving cursor in place for next tick');
      return { checked, finalCursor: cursor, completed: false };
    }

    if (data.length) {
      log(`checking batch of ${data.length} (total so far: ${checked})`);
      for (const row of data) {
        await processRow(row);
        checked += 1;
        if (delay && perRowDelayMs > 0) await delay(perRowDelayMs);
      }
    }

    const budgetExhausted = now() - startedAt > budgetMs;
    const step = planSweepStep({
      batchIds: data.map((r) => String(r.id)),
      batchLimit,
      budgetExhausted,
    });
    cursor = step.persistCursor;
    await saveCursor(step.persistCursor);

    if (step.control === 'complete') {
      log(`sweep complete — ${checked} cards checked (cursor reset to head)`);
      return { checked, finalCursor: cursor, completed: true };
    }
    if (step.control === 'resume-next-tick') {
      log(`budget exhausted after ${checked} cards — cursor persisted at ${step.persistCursor.lastId}, resuming next tick`);
      return { checked, finalCursor: cursor, completed: false };
    }
    // 'continue' — page again from the advanced cursor.
  }
}
