import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCardReversal, temporaryRefundStatus } from '../utils/refundDecision';

for (const method of ['unknown', 'failed'] as const) {
  test(`${method} card reversal never converts the card portion into wallet value`, () => {
    const decision = decideCardReversal({
      method,
      cardAmountSar: 75,
      actualWalletPaidSar: 12.34,
    });
    assert.equal(decision.walletCreditSar, 12.34);
    assert.equal(decision.cardReturnedToCustomer, false);
    assert.equal(decision.providerState, method);
  });
}

test('void/refund read-back counts as returned and not_required counts as nothing owed', () => {
  assert.equal(
    decideCardReversal({ method: 'void', cardAmountSar: 20, actualWalletPaidSar: 0 }).providerState,
    'returned',
  );
  assert.equal(
    decideCardReversal({ method: 'refund', cardAmountSar: 20, actualWalletPaidSar: 0 }).cardReturnedToCustomer,
    true,
  );
  assert.equal(
    decideCardReversal({ method: 'not_required', cardAmountSar: 20, actualWalletPaidSar: 0 }).cardNothingOwed,
    true,
  );
});

test('temporary refund status preserves provider unknown/failed over local restoration', () => {
  assert.equal(temporaryRefundStatus('unknown', true), 'provider_unknown');
  assert.equal(temporaryRefundStatus('failed', true), 'refund_failed');
  assert.equal(temporaryRefundStatus('returned', false), 'refunded');
  assert.equal(temporaryRefundStatus('not_applicable', true), 'refunded');
  assert.equal(temporaryRefundStatus('nothing_owed', false), 'not_required');
});
