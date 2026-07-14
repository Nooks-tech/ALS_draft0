import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateSnapshotHash,
  expectedProviderAmountHalalas,
  PaymentProcessingCandidate,
  verifyMoyasarPayment,
} from '../utils/paymentProcessingReconciliation';

function candidate(overrides: Partial<PaymentProcessingCandidate> = {}): PaymentProcessingCandidate {
  return {
    id: 'order-123',
    merchant_id: 'merchant-123',
    payment_id: '11111111-1111-4111-8111-111111111111',
    status: 'Delivered',
    payment_method: 'visa',
    total_sar: '25.00',
    card_paid_sar: '20.00',
    wallet_paid_sar: '5.00',
    cashback_paid_sar: '0',
    payment_confirmed_at: '2026-07-14T12:00:00.000Z',
    refund_status: null,
    refund_amount: '0',
    refunded_at: null,
    commission_status: 'pending',
    commission_amount: '1',
    created_at: '2026-07-14T12:00:00.000Z',
    updated_at: '2026-07-14T12:05:00.000Z',
    environment: 'production',
    live_secret_key_enc: 'v1:iv:tag:cipher',
    test_secret_key_enc: null,
    ...overrides,
  };
}

test('expected amount uses the positive card component rather than the full mixed-tender total', () => {
  assert.equal(expectedProviderAmountHalalas(candidate()), 2_000);
});

test('paid payment verifies exact id, SAR amount, metadata, and Delivered state', () => {
  const row = candidate();
  const result = verifyMoyasarPayment(row, {
    id: row.payment_id,
    status: 'paid',
    amount: 2_000,
    currency: 'SAR',
    metadata: { order_id: row.id, merchant_id: row.merchant_id },
    source: { company: 'visa' },
  });
  assert.equal(result.providerStatus, 'paid');
  assert.equal(result.legacyMetadataException, false);
});

test('failed payment requires Cancelled + not_required + zero refund', () => {
  const row = candidate({
    status: 'Cancelled',
    refund_status: 'not_required',
    refund_amount: '0',
  });
  assert.doesNotThrow(() => verifyMoyasarPayment(row, {
    id: row.payment_id,
    status: 'failed',
    amount: 2_000,
    currency: 'SAR',
    metadata: { order_id: row.id, merchant_id: row.merchant_id },
  }));
  assert.throws(() => verifyMoyasarPayment({ ...row, refund_status: 'refunded' }, {
    id: row.payment_id,
    status: 'failed',
    amount: 2_000,
    currency: 'SAR',
    metadata: { order_id: row.id, merchant_id: row.merchant_id },
  }), /no-refund DB state/);
});

test('metadata mismatch and amount mismatch both fail closed', () => {
  const row = candidate();
  assert.throws(() => verifyMoyasarPayment(row, {
    id: row.payment_id,
    status: 'paid',
    amount: 2_000,
    currency: 'SAR',
    metadata: { order_id: 'other-order', merchant_id: row.merchant_id },
  }), /order_id mismatch/);
  assert.throws(() => verifyMoyasarPayment(row, {
    id: row.payment_id,
    status: 'paid',
    amount: 2_001,
    currency: 'SAR',
    metadata: { order_id: row.id, merchant_id: row.merchant_id },
  }), /amount mismatch/);
});

test('the one legacy no-metadata exception is narrow and timestamp-bound', () => {
  const row = candidate({
    id: 'old-order',
    status: 'Cancelled',
    total_sar: '249.00',
    card_paid_sar: '0',
    refund_status: 'refunded',
    refund_amount: '249.00',
    created_at: '2026-05-20T12:00:00.000Z',
    refunded_at: null,
    updated_at: '2026-05-20T12:10:01.000Z',
  });
  const verified = verifyMoyasarPayment(row, {
    id: row.payment_id,
    status: 'voided',
    amount: 24_900,
    currency: 'SAR',
    metadata: {},
    created_at: '2026-05-20T12:00:15.000Z',
    updated_at: '2026-05-20T12:10:00.000Z',
  });
  assert.equal(verified.legacyMetadataException, true);
  assert.throws(() => verifyMoyasarPayment({ ...row, total_sar: '250.00', refund_amount: '250.00' }, {
    id: row.payment_id,
    status: 'voided',
    amount: 25_000,
    currency: 'SAR',
    metadata: {},
    created_at: '2026-05-20T12:00:15.000Z',
    updated_at: '2026-05-20T12:10:00.000Z',
  }), /legacy exception/);
});

test('candidate snapshot hash is order-independent but changes with mutable state', () => {
  const first = candidate();
  const second = candidate({ id: 'order-456', payment_id: '22222222-2222-4222-8222-222222222222' });
  assert.equal(candidateSnapshotHash([first, second]), candidateSnapshotHash([second, first]));
  assert.notEqual(
    candidateSnapshotHash([first, second]),
    candidateSnapshotHash([{ ...first, commission_status: 'earned' }, second]),
  );
});
