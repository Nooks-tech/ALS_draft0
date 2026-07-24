// 2026-07-24 legal review, Tier 1 finding #1: privacy policy promises
// 30-day OTP retention but no purge job existed. Covers the purge's
// cutoff filtering and its LIMIT-batched delete loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeOtpsOlderThan } from '../cron/otpPurge';

type OtpRow = { id: string; created_at: string };

// Fake supabase admin mimicking the exact chain purgeOtpsOlderThan
// issues: .from('sms_otp').select('id').lt('created_at', cutoff).limit(n)
// for the read side, and .from('sms_otp').delete().in('id', ids) for the
// write side. Mutates an in-memory row array so assertions can check
// what survived.
function fakeOtpAdmin(initialRows: OtpRow[]) {
  let rows = [...initialRows];
  const deleteBatches: string[][] = [];
  return {
    rowsRemaining: () => rows,
    deleteBatches,
    from(table: string) {
      assert.equal(table, 'sms_otp');
      let cutoff = '';
      const chain: any = {
        select(_cols: string) {
          return chain;
        },
        delete() {
          return chain;
        },
        lt(field: string, value: string) {
          assert.equal(field, 'created_at');
          cutoff = value;
          return chain;
        },
        limit(n: number) {
          const matched = rows.filter((r) => r.created_at < cutoff).slice(0, n);
          return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
        },
        in(field: string, ids: string[]) {
          assert.equal(field, 'id');
          deleteBatches.push(ids);
          rows = rows.filter((r) => !ids.includes(r.id));
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  } as any;
}

test('deletes only rows older than the cutoff, leaving newer rows untouched', async () => {
  const cutoff = new Date('2026-06-24T00:00:00.000Z').toISOString();
  const admin = fakeOtpAdmin([
    { id: 'old-1', created_at: '2026-06-01T00:00:00.000Z' },
    { id: 'old-2', created_at: '2026-06-20T00:00:00.000Z' },
    { id: 'new-1', created_at: '2026-07-01T00:00:00.000Z' },
    { id: 'new-2', created_at: '2026-07-24T00:00:00.000Z' },
  ]);

  const result = await purgeOtpsOlderThan(admin, cutoff);

  assert.equal(result.deleted, 2);
  assert.equal(result.cappedOut, false);
  const remainingIds = admin.rowsRemaining().map((r: OtpRow) => r.id).sort();
  assert.deepEqual(remainingIds, ['new-1', 'new-2']);
});

test('batches deletes across multiple LIMIT pages', async () => {
  const cutoff = new Date('2026-07-24T00:00:00.000Z').toISOString();
  const rows: OtpRow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `row-${i}`,
    created_at: '2026-06-01T00:00:00.000Z',
  }));
  const admin = fakeOtpAdmin(rows);

  const result = await purgeOtpsOlderThan(admin, cutoff, { batchLimit: 2 });

  assert.equal(result.deleted, 5);
  assert.equal(result.batches, 3); // 2 + 2 + 1
  assert.equal(admin.rowsRemaining().length, 0);
});

test('stops at maxBatches and reports cappedOut, leaving the rest for next tick', async () => {
  const cutoff = new Date('2026-07-24T00:00:00.000Z').toISOString();
  const rows: OtpRow[] = Array.from({ length: 10 }, (_, i) => ({
    id: `row-${i}`,
    created_at: '2026-06-01T00:00:00.000Z',
  }));
  const admin = fakeOtpAdmin(rows);

  const result = await purgeOtpsOlderThan(admin, cutoff, { batchLimit: 2, maxBatches: 3 });

  assert.equal(result.batches, 3);
  assert.equal(result.deleted, 6); // 3 batches * 2 rows
  assert.equal(result.cappedOut, true);
  assert.equal(admin.rowsRemaining().length, 4); // deferred to the next tick
});

test('a clean table (nothing older than cutoff) is a no-op', async () => {
  const cutoff = new Date('2026-06-01T00:00:00.000Z').toISOString();
  const admin = fakeOtpAdmin([{ id: 'new-1', created_at: '2026-07-24T00:00:00.000Z' }]);

  const result = await purgeOtpsOlderThan(admin, cutoff);

  assert.deepEqual(result, { deleted: 0, batches: 0, cappedOut: false });
  assert.equal(admin.rowsRemaining().length, 1);
});
