// SCAL-003 — locks the 202(settling)-vs-402(terminal) boundary for the
// single-verify checkout path. Getting this wrong either strands paid orders
// (declining a settling payment) or spins the client forever (retrying a
// terminal decline), so the classification is worth a dedicated test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaymentStillSettling } from '../utils/paymentSettling';

test('initiated / pending are still settling → retry (202)', () => {
  assert.equal(isPaymentStillSettling('initiated', false), true);
  assert.equal(isPaymentStillSettling('pending', false), true);
  assert.equal(isPaymentStillSettling('INITIATED', false), true); // case-insensitive
  assert.equal(isPaymentStillSettling('  pending  ', false), true); // trims
});

test('a retryable/transient verify error is treated as settling regardless of status', () => {
  assert.equal(isPaymentStillSettling('failed', true), true);
  assert.equal(isPaymentStillSettling(null, true), true);
  assert.equal(isPaymentStillSettling(undefined, true), true);
});

test('terminal statuses are NOT settling → decline (402)', () => {
  assert.equal(isPaymentStillSettling('failed', false), false);
  assert.equal(isPaymentStillSettling('voided', false), false);
  assert.equal(isPaymentStillSettling('refunded', false), false);
  assert.equal(isPaymentStillSettling('paid', false), false); // paid means ok anyway
  assert.equal(isPaymentStillSettling(null, false), false);
  assert.equal(isPaymentStillSettling('', false), false);
  assert.equal(isPaymentStillSettling('amount_mismatch', false), false);
});
