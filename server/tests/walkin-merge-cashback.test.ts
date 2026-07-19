// LOY-14 — walk-in profile merge must migrate loyalty_cashback_balances the
// same way it already migrates loyalty_points. Before this fix a cashback
// balance earned as a walk-in (kiosk claim, no auth user yet) stranded
// permanently on the walk-in's synthetic customer_id the moment the person
// signed in to the app — mergeWalkInProfiles rewrote member profiles,
// transactions and points, but never touched loyalty_cashback_balances.
//
// mergeWalkInProfiles(supabase, ...) takes its Supabase client as a
// parameter (server/services/walkInMerge.ts:53-56) — that's the mockable
// seam used here, same shape as ProcessDeps.db in
// server/workers/orderDispatch.ts. No live DB / network is touched; this
// fake implements just enough of the postgrest-js chain that walkInMerge.ts
// actually calls (select/update/delete/insert + eq/or/maybeSingle/then)
// against a small in-memory table map.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mergeWalkInProfiles } from '../services/walkInMerge';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

function parseOrClause(clause: string): { col: string; op: string; val: string } {
  const [col, op, val] = clause.split('.');
  return { col, op, val };
}

function makeFakeSupabase(tables: Tables): SupabaseClient {
  function from(table: string) {
    const store = () => (tables[table] ??= []);
    let mode: 'select' | 'update' | 'delete' | 'insert' | null = null;
    let payload: Row | null = null;
    const eqFilters: Array<{ col: string; val: unknown }> = [];
    let orClause: string | null = null;
    let single = false;

    function matchesEq(row: Row) {
      return eqFilters.every((f) => row[f.col] === f.val);
    }
    function matchesOr(row: Row) {
      if (!orClause) return true;
      return orClause.split(',').some((raw) => {
        const { col, op, val } = parseOrClause(raw);
        if (op === 'is' && val === 'null') return row[col] === null || row[col] === undefined;
        if (op === 'eq') return String(row[col]) === val;
        return false;
      });
    }
    function selected() {
      return store().filter((r) => matchesEq(r) && matchesOr(r));
    }

    function execute(): Promise<{ data: any; error: null }> {
      if (mode === 'update') {
        const matched = selected();
        matched.forEach((r) => Object.assign(r, payload));
        return Promise.resolve({ data: matched, error: null });
      }
      if (mode === 'delete') {
        const matched = selected();
        tables[table] = store().filter((r) => !matched.includes(r));
        return Promise.resolve({ data: matched, error: null });
      }
      if (mode === 'insert') {
        const row = { ...payload };
        store().push(row);
        return Promise.resolve({ data: [row], error: null });
      }
      // select (default)
      const matched = selected();
      if (single) return Promise.resolve({ data: matched[0] ?? null, error: null });
      return Promise.resolve({ data: matched, error: null });
    }

    const api: any = {
      select(_cols?: string) {
        if (mode === null) mode = 'select';
        return api;
      },
      update(p: Row) {
        mode = 'update';
        payload = p;
        return api;
      },
      delete() {
        mode = 'delete';
        return api;
      },
      insert(p: Row) {
        mode = 'insert';
        payload = p;
        return api;
      },
      eq(col: string, val: unknown) {
        eqFilters.push({ col, val });
        return api;
      },
      or(clause: string) {
        orClause = clause;
        return api;
      },
      maybeSingle() {
        single = true;
        return execute();
      },
      then(onFulfilled: any, onRejected?: any) {
        return execute().then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  return { from } as unknown as SupabaseClient;
}

const AUTH_USER = 'auth-user-1';
const WALKIN_ID = 'walkin-profile-1';
const MERCHANT = 'merchant-1';
const PHONE_RAW = '0501234567';

function baseProfileRow(overrides: Partial<Row> = {}): Row {
  return {
    id: WALKIN_ID,
    merchant_id: MERCHANT,
    customer_id: null,
    phone_number: '+966501234567',
    ...overrides,
  };
}

test('walk-in cashback balance migrates to the auth user when no destination row exists', async () => {
  const tables: Tables = {
    loyalty_member_profiles: [baseProfileRow()],
    loyalty_cashback_balances: [
      { merchant_id: MERCHANT, customer_id: WALKIN_ID, balance_sar: 12.5, config_version: 1 },
    ],
  };
  const supabase = makeFakeSupabase(tables);

  const result = await mergeWalkInProfiles(supabase, AUTH_USER, PHONE_RAW);

  assert.equal(result.merged, 1);
  assert.deepEqual(result.merchantIds, [MERCHANT]);

  const cashbackRows = tables.loyalty_cashback_balances;
  assert.equal(cashbackRows.length, 1, 'the walk-in row is rewritten in place, not duplicated');
  assert.equal(cashbackRows[0].customer_id, AUTH_USER);
  assert.equal(cashbackRows[0].balance_sar, 12.5);
  assert.equal(cashbackRows[0].config_version, 1);
});

test('walk-in cashback balance is summed into an existing auth-user balance at the same config_version, and the walk-in row is deleted', async () => {
  const tables: Tables = {
    loyalty_member_profiles: [baseProfileRow()],
    loyalty_cashback_balances: [
      { merchant_id: MERCHANT, customer_id: WALKIN_ID, balance_sar: 12.5, config_version: 1 },
      { merchant_id: MERCHANT, customer_id: AUTH_USER, balance_sar: 5, config_version: 1 },
    ],
  };
  const supabase = makeFakeSupabase(tables);

  const result = await mergeWalkInProfiles(supabase, AUTH_USER, PHONE_RAW);

  assert.equal(result.merged, 1);
  const cashbackRows = tables.loyalty_cashback_balances;
  assert.equal(cashbackRows.length, 1, 'the walk-in row must be deleted after its balance is folded in');
  assert.equal(cashbackRows[0].customer_id, AUTH_USER);
  assert.equal(cashbackRows[0].balance_sar, 17.5);
});

test('multiple config_version rows on the walk-in migrate independently (rewrite vs merge per version)', async () => {
  const tables: Tables = {
    loyalty_member_profiles: [baseProfileRow()],
    loyalty_cashback_balances: [
      // v1 collides with an existing auth-user row -> sum + delete walk-in row.
      { merchant_id: MERCHANT, customer_id: WALKIN_ID, balance_sar: 10, config_version: 1 },
      { merchant_id: MERCHANT, customer_id: AUTH_USER, balance_sar: 3, config_version: 1 },
      // v2 has no auth-user row yet -> rewrite customer_id in place.
      { merchant_id: MERCHANT, customer_id: WALKIN_ID, balance_sar: 7, config_version: 2 },
    ],
  };
  const supabase = makeFakeSupabase(tables);

  await mergeWalkInProfiles(supabase, AUTH_USER, PHONE_RAW);

  const cashbackRows = tables.loyalty_cashback_balances
    .slice()
    .sort((a, b) => a.config_version - b.config_version);
  assert.equal(cashbackRows.length, 2, 'one row per config_version survives, no walk-in rows left behind');
  assert.equal(cashbackRows[0].config_version, 1);
  assert.equal(cashbackRows[0].customer_id, AUTH_USER);
  assert.equal(cashbackRows[0].balance_sar, 13);
  assert.equal(cashbackRows[1].config_version, 2);
  assert.equal(cashbackRows[1].customer_id, AUTH_USER);
  assert.equal(cashbackRows[1].balance_sar, 7);
});

test('a walk-in with no cashback rows at all is a no-op for that table (points-only merchant)', async () => {
  const tables: Tables = {
    loyalty_member_profiles: [baseProfileRow()],
    loyalty_cashback_balances: [],
  };
  const supabase = makeFakeSupabase(tables);

  const result = await mergeWalkInProfiles(supabase, AUTH_USER, PHONE_RAW);

  assert.equal(result.merged, 1, 'profile merge still proceeds normally');
  assert.equal(tables.loyalty_cashback_balances.length, 0);
});
