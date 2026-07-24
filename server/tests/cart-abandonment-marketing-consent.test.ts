// 2026-07-24 legal review, Tier 1 finding #1: cart-abandonment nudges are
// marketing content and must only fire for customers with a confirmed
// customer_merchant_profiles.marketing_opt_in = true row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchMarketingOptedInSet } from '../cron/cartAbandonment';

// Fake admin mimicking .from('customer_merchant_profiles').select(...)
// .in('merchant_id', ...).in('customer_id', ...).eq('marketing_opt_in', true)
function fakeProfilesAdmin(
  rows: Array<{ merchant_id: string; customer_id: string; marketing_opt_in: boolean }>,
  opts: { error?: string } = {},
) {
  return {
    from(table: string) {
      assert.equal(table, 'customer_merchant_profiles');
      let merchantIds: string[] = [];
      let customerIds: string[] = [];
      let optInOnly = false;
      const chain: any = {
        select(_cols: string) {
          return chain;
        },
        in(field: string, values: string[]) {
          if (field === 'merchant_id') merchantIds = values;
          else if (field === 'customer_id') customerIds = values;
          return chain;
        },
        eq(field: string, value: unknown) {
          if (field === 'marketing_opt_in' && value === true) optInOnly = true;
          return chain;
        },
        then(resolve: any) {
          if (opts.error) {
            resolve({ data: null, error: { message: opts.error } });
            return;
          }
          const matched = rows.filter(
            (r) =>
              merchantIds.includes(r.merchant_id) &&
              customerIds.includes(r.customer_id) &&
              (!optInOnly || r.marketing_opt_in === true),
          );
          resolve({ data: matched, error: null });
        },
      };
      return chain;
    },
  } as any;
}

test('excludes a customer with no marketing_opt_in row (default false)', async () => {
  const admin = fakeProfilesAdmin([
    { merchant_id: 'm1', customer_id: 'opted-in', marketing_opt_in: true },
    // 'not-opted-in' has no row at all
  ]);
  const optedIn = await fetchMarketingOptedInSet(admin, [
    { m: 'm1', c: 'opted-in' },
    { m: 'm1', c: 'not-opted-in' },
  ]);
  assert.equal(optedIn.has('m1:opted-in'), true);
  assert.equal(optedIn.has('m1:not-opted-in'), false);
});

test('excludes a customer whose profile row has marketing_opt_in = false', async () => {
  const admin = fakeProfilesAdmin([
    { merchant_id: 'm1', customer_id: 'declined', marketing_opt_in: false },
  ]);
  const optedIn = await fetchMarketingOptedInSet(admin, [{ m: 'm1', c: 'declined' }]);
  assert.equal(optedIn.has('m1:declined'), false);
});

test('opt-in is scoped per merchant — opted in at one merchant does not leak to another', async () => {
  const admin = fakeProfilesAdmin([
    { merchant_id: 'm1', customer_id: 'c1', marketing_opt_in: true },
  ]);
  const optedIn = await fetchMarketingOptedInSet(admin, [
    { m: 'm1', c: 'c1' },
    { m: 'm2', c: 'c1' },
  ]);
  assert.equal(optedIn.has('m1:c1'), true);
  assert.equal(optedIn.has('m2:c1'), false);
});

test('fails CLOSED on a query error — nobody is treated as opted in', async () => {
  const admin = fakeProfilesAdmin([], { error: 'schema drift' });
  const optedIn = await fetchMarketingOptedInSet(admin, [{ m: 'm1', c: 'c1' }]);
  assert.equal(optedIn.size, 0);
});

test('an empty batch short-circuits without querying', async () => {
  const optedIn = await fetchMarketingOptedInSet({} as any, []);
  assert.equal(optedIn.size, 0);
});

// Wiring check: the opted-out branch must run BEFORE the push is sent,
// and before the cooldown stamp — text-based per this codebase's
// convention for asserting ordering inside a large function (see
// payment-orphan-wiring.test.ts) rather than driving the full cron
// end-to-end through a mocked Supabase client + Expo push endpoint.
const cartAbandonmentSource = readFileSync('cron/cartAbandonment.ts', 'utf8');

test('processNotifyBatch gates on optedIn before calling sendLocalizedPushScoped', () => {
  const optedInCheckIndex = cartAbandonmentSource.indexOf(
    "if (!optedIn.has(`${row.merchant_id}:${row.customer_id}`)) {",
  );
  const sendIndex = cartAbandonmentSource.indexOf('sendLocalizedPushScoped({');
  assert.ok(optedInCheckIndex >= 0, 'opt-in gate not found');
  assert.ok(sendIndex > optedInCheckIndex, 'opt-in gate must run before the push send');
  assert.match(
    cartAbandonmentSource,
    /notification_suppressed_no_marketing_consent/,
  );
});
