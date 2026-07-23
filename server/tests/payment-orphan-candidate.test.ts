import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommitPaymentOrphanCandidate,
  insertTerminalPaymentOrphanManualReview,
  markPaymentOrphanCandidateOrderFound,
  markPaymentOrphanCandidateManualReview,
  paymentOrphanManualReviewUpdate,
  PaymentOrphanCandidateCapacityError,
  PaymentOrphanCandidateConflictError,
  releasePaymentOrphanLease,
  renewPaymentOrphanLease,
  type PaymentOrphanCandidate,
  upsertPaymentOrphanCandidate,
} from '../utils/paymentOrphanCandidate';

const PAYMENT_ID = 'ea13b297-6381-491b-85f2-debec023b05c';

function candidate(): PaymentOrphanCandidate {
  return {
    payment_id: PAYMENT_ID,
    merchant_id: 'merchant-123',
    amount_halalas: 20_000,
    metadata_order_id: 'order-123',
    metadata_customer_id: 'customer-123',
  };
}

function mockAdmin(params: {
  initial?: Record<string, unknown> | null;
  upsertError?: string;
  insertError?: string;
  readError?: string;
}) {
  let stored = params.initial ?? null;
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    get stored() {
      return stored;
    },
    client: {
      from(table: string) {
        assert.equal(table, 'payment_orphan_candidates');
        return {
          async upsert(payload: PaymentOrphanCandidate, options: unknown) {
            calls.push({ op: 'upsert', payload, options });
            if (params.upsertError) {
              return { error: { message: params.upsertError } };
            }
            if (!stored) {
              stored = {
                ...payload,
                resolved_at: null,
                resolution: null,
                processing_owner: null,
                processing_token: null,
                processing_until: null,
              };
            }
            return { error: null };
          },
          insert(payload: Record<string, unknown>) {
            calls.push({ op: 'insert', payload });
            const chain = {
              select() {
                return chain;
              },
              async single() {
                if (params.insertError) {
                  return { data: null, error: { message: params.insertError } };
                }
                stored = { ...payload };
                return { data: stored, error: null };
              },
            };
            return chain;
          },
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    if (params.readError) {
                      return { data: null, error: { message: params.readError } };
                    }
                    return { data: stored, error: null };
                  },
                };
              },
            };
          },
          update(payload: Record<string, unknown>) {
            calls.push({ op: 'update', payload });
            const filters: Array<
              | { kind: 'eq'; field: string; value: unknown }
              | { kind: 'is'; field: string; value: unknown }
              | { kind: 'gt'; field: string; value: string }
            > = [];
            let orFilter: string | null = null;
            const matches = () => {
              if (!stored) return false;
              for (const filter of filters) {
                const value = stored[filter.field];
                if (filter.kind === 'eq' && value !== filter.value) return false;
                if (filter.kind === 'is' && value !== filter.value) return false;
                if (
                  filter.kind === 'gt' &&
                  !(
                    typeof value === 'string' &&
                    Date.parse(value) > Date.parse(filter.value)
                  )
                ) {
                  return false;
                }
              }
              if (orFilter) {
                const alternatives = orFilter.split(',');
                const matched = alternatives.some((alternative) => {
                  const isNull = alternative.match(/^([a-z_]+)\.is\.null$/);
                  if (isNull) return stored?.[isNull[1]] == null;
                  const lt = alternative.match(/^([a-z_]+)\.lt\.(.+)$/);
                  if (lt) {
                    const value = stored?.[lt[1]];
                    return (
                      typeof value === 'string' &&
                      Date.parse(value) < Date.parse(lt[2])
                    );
                  }
                  return false;
                });
                if (!matched) return false;
              }
              return true;
            };
            const applyUpdate = () => {
              if (matches() && stored) stored = { ...stored, ...payload };
            };
            const chain = {
              eq(field: string, value: unknown) {
                filters.push({ kind: 'eq', field, value });
                return chain;
              },
              is(field: string, value: unknown) {
                filters.push({ kind: 'is', field, value });
                return chain;
              },
              gt(field: string, value: string) {
                filters.push({ kind: 'gt', field, value });
                return chain;
              },
              or(value: string) {
                orFilter = value;
                return chain;
              },
              select() {
                return chain;
              },
              async maybeSingle() {
                if (!matches()) return { data: null, error: null };
                applyUpdate();
                return { data: stored, error: null };
              },
              then(resolve: (result: { error: null }) => void) {
                applyUpdate();
                resolve({ error: null });
              },
            };
            return chain;
          },
        };
      },
    } as any,
  };
}

test('builds a strictly attributed candidate for the card portion', () => {
  assert.deepEqual(
    buildCommitPaymentOrphanCandidate({
      paymentId: PAYMENT_ID,
      merchantId: 'merchant-123',
      orderId: 'order-123',
      customerId: 'customer-123',
      totalSar: 220,
      paymentMethod: 'apple_pay',
      walletAmountSar: 20,
    }),
    candidate(),
  );
});

test('rejects non-UUID, reserved, malformed, wallet-only, and non-positive candidates', () => {
  const base = {
    paymentId: PAYMENT_ID,
    merchantId: 'merchant-123',
    orderId: 'order-123',
    customerId: 'customer-123',
    totalSar: 10,
    paymentMethod: 'apple_pay',
    walletAmountSar: 0,
  };
  assert.equal(buildCommitPaymentOrphanCandidate({ ...base, paymentId: 'payment-123' }), null);
  assert.equal(buildCommitPaymentOrphanCandidate({ ...base, paymentId: 'wallet:123' }), null);
  assert.equal(buildCommitPaymentOrphanCandidate({ ...base, orderId: 'bad order' }), null);
  assert.equal(buildCommitPaymentOrphanCandidate({ ...base, paymentMethod: 'wallet' }), null);
  assert.equal(buildCommitPaymentOrphanCandidate({ ...base, totalSar: 0 }), null);
  assert.equal(buildCommitPaymentOrphanCandidate({ ...base, walletAmountSar: 10 }), null);
});

test('upsert reads back an exact active row before reporting durable recovery', async () => {
  const mock = mockAdmin({});
  const registration = await upsertPaymentOrphanCandidate(mock.client, candidate());
  assert.equal(registration.status, 'active');
  assert.match(
    registration.status === 'active' ? registration.leaseToken : '',
    /^[0-9a-f-]{36}$/i,
  );
  assert.deepEqual(mock.calls[0], {
    op: 'upsert',
    payload: candidate(),
    options: { onConflict: 'payment_id', ignoreDuplicates: true },
  });
  assert.equal('first_seen_at' in candidate(), false);
});

test('fails closed when a conflicting webhook row lacks authoritative metadata', async () => {
  const expected = candidate();
  const mock = mockAdmin({
    initial: {
      ...expected,
      metadata_order_id: null,
      metadata_customer_id: null,
      resolved_at: null,
      resolution: null,
    },
  });
  await assert.rejects(
    () => upsertPaymentOrphanCandidate(mock.client, expected),
    (error: unknown) =>
      error instanceof PaymentOrphanCandidateConflictError &&
      /conflicts with existing attribution/.test(error.message),
  );
});

test('does not race a sweep that already holds the candidate lease', async () => {
  const expected = candidate();
  const mock = mockAdmin({
    initial: {
      ...expected,
      resolved_at: null,
      resolution: null,
      processing_owner: 'sweep',
      processing_token: '11111111-1111-4111-8111-111111111111',
      processing_until: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.deepEqual(
    await upsertPaymentOrphanCandidate(mock.client, expected),
    { status: 'in_progress' },
  );
});

test('does not let a second commit share an active commit lease', async () => {
  const expected = candidate();
  const mock = mockAdmin({});
  const first = await upsertPaymentOrphanCandidate(mock.client, expected);
  assert.equal(first.status, 'active');
  assert.deepEqual(
    await upsertPaymentOrphanCandidate(mock.client, expected),
    { status: 'in_progress' },
  );
});

test('accepts only order_found as an already-terminal idempotent result', async () => {
  const expected = candidate();
  const found = mockAdmin({
    initial: {
      ...expected,
      resolved_at: '2026-07-23T12:00:00.000Z',
      resolution: 'order_found',
    },
  });
  assert.deepEqual(
    await upsertPaymentOrphanCandidate(found.client, expected),
    { status: 'order_found' },
  );

  const reversed = mockAdmin({
    initial: {
      ...expected,
      resolved_at: '2026-07-23T12:00:00.000Z',
      resolution: 'reversed',
    },
  });
  await assert.rejects(
    () => upsertPaymentOrphanCandidate(reversed.client, expected),
    /already terminal \(reversed\)/,
  );
});

test('rejects conflict/no-op attribution and all persistence read errors', async () => {
  const expected = candidate();
  const conflicting = mockAdmin({
    initial: {
      ...expected,
      merchant_id: 'other-merchant',
      resolved_at: null,
      resolution: null,
    },
  });
  await assert.rejects(
    () => upsertPaymentOrphanCandidate(conflicting.client, expected),
    (error: unknown) => error instanceof PaymentOrphanCandidateConflictError,
  );

  const writeFailure = mockAdmin({ upsertError: 'write failed' });
  await assert.rejects(
    () => upsertPaymentOrphanCandidate(writeFailure.client, expected),
    /write failed/,
  );
  const readFailure = mockAdmin({ readError: 'read failed' });
  await assert.rejects(
    () => upsertPaymentOrphanCandidate(readFailure.client, expected),
    /read-back failed: read failed/,
  );
});

test('classifies the unresolved-customer cap and persists a terminal fallback row', async () => {
  const capped = mockAdmin({
    upsertError: 'too many unresolved payment recovery candidates',
  });
  await assert.rejects(
    () => upsertPaymentOrphanCandidate(capped.client, candidate()),
    (error: unknown) => error instanceof PaymentOrphanCandidateCapacityError,
  );

  const fallback = mockAdmin({});
  await insertTerminalPaymentOrphanManualReview(
    fallback.client,
    candidate(),
    'customer recovery cap exceeded',
  );
  assert.equal(fallback.stored?.resolution, 'manual_review');
  assert.equal(typeof fallback.stored?.resolved_at, 'string');
  assert.equal(fallback.stored?.processing_token, null);
});

test('only deterministic manual review leaves the hot retry queue', () => {
  const now = '2026-07-23T12:00:00.000Z';
  assert.deepEqual(
    paymentOrphanManualReviewUpdate(4, 'missing metadata', true, now),
    {
      resolution: 'manual_review',
      attempts: 5,
      last_error: 'missing metadata',
      processing_owner: null,
      processing_token: null,
      processing_until: null,
      resolved_at: now,
    },
  );
  assert.deepEqual(
    paymentOrphanManualReviewUpdate(4, 'provider timeout', false, now),
    {
      resolution: 'manual_review',
      attempts: 5,
      last_error: 'provider timeout',
      processing_owner: null,
      processing_token: null,
      processing_until: null,
    },
  );
});

test('lease renewal, release, and order close are token-CAS guarded', async () => {
  const mock = mockAdmin({});
  const registration = await upsertPaymentOrphanCandidate(mock.client, candidate());
  assert.equal(registration.status, 'active');
  if (registration.status !== 'active') return;

  const wrongToken = '22222222-2222-4222-8222-222222222222';
  assert.equal(
    await renewPaymentOrphanLease(
      mock.client,
      PAYMENT_ID,
      'commit',
      wrongToken,
      60_000,
    ),
    false,
  );
  assert.equal(
    await renewPaymentOrphanLease(
      mock.client,
      PAYMENT_ID,
      'commit',
      registration.leaseToken,
      60_000,
    ),
    true,
  );
  assert.equal(
    await releasePaymentOrphanLease(
      mock.client,
      PAYMENT_ID,
      'commit',
      wrongToken,
    ),
    false,
  );
  await assert.rejects(
    () =>
      markPaymentOrphanCandidateOrderFound(
        mock.client,
        PAYMENT_ID,
        wrongToken,
      ),
    /lost commit lease ownership/,
  );
  await markPaymentOrphanCandidateOrderFound(
    mock.client,
    PAYMENT_ID,
    registration.leaseToken,
  );
  assert.equal(mock.stored?.resolution, 'order_found');
  assert.equal(mock.stored?.processing_token, null);
});

test('commit-owned admission failures can be durably terminalized without a provider mutation', async () => {
  const mock = mockAdmin({});
  const registration = await upsertPaymentOrphanCandidate(mock.client, candidate());
  assert.equal(registration.status, 'active');
  if (registration.status !== 'active') return;

  await markPaymentOrphanCandidateManualReview(
    mock.client,
    PAYMENT_ID,
    registration.leaseToken,
    'merchant credentials unavailable',
    true,
  );
  assert.equal(mock.stored?.resolution, 'manual_review');
  assert.equal(typeof mock.stored?.resolved_at, 'string');
  assert.equal(mock.stored?.processing_owner, null);
  assert.equal(mock.stored?.processing_token, null);
});
