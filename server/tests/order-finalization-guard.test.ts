import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFinalSettlementProof,
  guardOrderFinalizationRequest,
  hasRewardBearingOrderItems,
} from '../utils/orderFinalizationGuard';

test('malformed reward-prefixed item is still classified as reward-bearing', () => {
  assert.equal(hasRewardBearingOrderItems([{ uniqueId: 'reward-junk' }]), true);
  assert.equal(hasRewardBearingOrderItems([{ uniqueId: 'regular-item' }]), false);
});

test('non-final card drafts remain compatible without a payment id', () => {
  assert.deepEqual(
    guardOrderFinalizationRequest({
      isFinalCommit: false,
      submittedPaymentId: null,
      paymentMethod: 'saved_card',
      cardPortionHalalas: 5_000,
      walletAppliedHalalas: 0,
      hasRewardBearingItems: false,
    }),
    { ok: true, stage: 'draft', tender: 'draft' },
  );
});

for (const paymentId of ['wallet:client', 'reward:client', 'cashback:client', 'WALLET:CLIENT']) {
  test(`client-authored reserved sentinel ${paymentId} is rejected even on a draft`, () => {
    const decision = guardOrderFinalizationRequest({
      isFinalCommit: false,
      submittedPaymentId: paymentId,
      paymentMethod: 'wallet',
      cardPortionHalalas: 0,
      walletAppliedHalalas: 1_000,
      hasRewardBearingItems: false,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 409);
      assert.equal(decision.code, 'CLIENT_PAYMENT_SENTINEL_FORBIDDEN');
    }
  });
}

test('reward-bearing final orders return the stable Phase A 409 contract', () => {
  const decision = guardOrderFinalizationRequest({
    isFinalCommit: true,
    submittedPaymentId: 'reward:legacy-client-order',
    paymentMethod: 'reward',
    cardPortionHalalas: 0,
    walletAppliedHalalas: 0,
    hasRewardBearingItems: true,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.status, 409);
    assert.equal(decision.code, 'REWARD_CHECKOUT_TEMPORARILY_DISABLED');
  }
});

test('reward-bearing saved-card drafts are rejected before token-pay can charge', () => {
  const decision = guardOrderFinalizationRequest({
    isFinalCommit: false,
    submittedPaymentId: null,
    paymentMethod: 'saved_card',
    cardPortionHalalas: 3_000,
    walletAppliedHalalas: 0,
    hasRewardBearingItems: true,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.status, 409);
    assert.equal(decision.code, 'REWARD_CHECKOUT_TEMPORARILY_DISABLED');
    assert.equal(decision.providerPaymentIdToReverse, undefined);
  }
});

for (const isFinalCommit of [false, true]) {
  test(`charged reward-bearing ${isFinalCommit ? 'final' : 'first'} commit exposes only a bind-before-reversal provider candidate`, () => {
    const decision = guardOrderFinalizationRequest({
      isFinalCommit,
      submittedPaymentId: 'pay_real_bound_candidate',
      paymentMethod: 'apple_pay',
      cardPortionHalalas: 3_000,
      walletAppliedHalalas: 0,
      hasRewardBearingItems: true,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 409);
      assert.equal(decision.code, 'REWARD_CHECKOUT_TEMPORARILY_DISABLED');
      assert.equal(decision.providerPaymentIdToReverse, 'pay_real_bound_candidate');
    }
  });
}

test('fully cashback-funded zero-charge finals fail closed without authoritative ledger proof', () => {
  const decision = guardOrderFinalizationRequest({
    isFinalCommit: true,
    submittedPaymentId: null,
    paymentMethod: 'credit_card',
    cardPortionHalalas: 0,
    walletAppliedHalalas: 0,
    hasRewardBearingItems: false,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.status, 409);
    assert.equal(decision.code, 'SETTLEMENT_PROOF_REQUIRED');
  }
});

test('card-like final commits require a real provider id', () => {
  const missing = guardOrderFinalizationRequest({
    isFinalCommit: true,
    submittedPaymentId: null,
    paymentMethod: 'apple_pay',
    cardPortionHalalas: 2_500,
    walletAppliedHalalas: 0,
    hasRewardBearingItems: false,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'PAYMENT_ID_REQUIRED');

  assert.deepEqual(
    guardOrderFinalizationRequest({
      isFinalCommit: true,
      submittedPaymentId: 'pay_real_123',
      paymentMethod: 'apple_pay',
      cardPortionHalalas: 2_500,
      walletAppliedHalalas: 0,
      hasRewardBearingItems: false,
    }),
    { ok: true, stage: 'final', tender: 'provider' },
  );
});

test('wallet finalization is proven only by the server debit transaction id', () => {
  const unproven = deriveFinalSettlementProof({
    isFinalCommit: true,
    providerPaymentId: null,
    providerPaymentMethod: 'wallet',
    providerVerified: false,
    cardPortionHalalas: 0,
    walletAppliedHalalas: 4_200,
    walletDebitTransactionId: null,
  });
  assert.equal(unproven.settled, false);
  if (!unproven.settled) assert.equal(unproven.reason, 'wallet-debit-not-proven');

  assert.deepEqual(
    deriveFinalSettlementProof({
      isFinalCommit: true,
      providerPaymentId: null,
      providerPaymentMethod: 'wallet',
      providerVerified: false,
      cardPortionHalalas: 0,
      walletAppliedHalalas: 4_200,
      walletDebitTransactionId: 'txn_server_123',
    }),
    {
      settled: true,
      paymentId: 'wallet:txn_server_123',
      paymentMethod: 'wallet',
      tender: 'wallet',
    },
  );
});

test('mixed finalization uses the verified resolved provider id plus wallet debit proof', () => {
  assert.deepEqual(
    deriveFinalSettlementProof({
      isFinalCommit: true,
      providerPaymentId: 'pay_resolved',
      providerPaymentMethod: 'saved_card',
      providerVerified: true,
      cardPortionHalalas: 1_500,
      walletAppliedHalalas: 500,
      walletDebitTransactionId: 'txn_wallet',
    }),
    {
      settled: true,
      paymentId: 'pay_resolved',
      paymentMethod: 'saved_card',
      tender: 'mixed',
    },
  );
});

test('an unrecognized payment method still exposes the captured charge for reversal', () => {
  // Regression (proven live 2026-07-16): providerPaymentIdToReverse used to be
  // gated on CARD_LIKE_PAYMENT_METHODS, which made it mutually exclusive with
  // the PAYMENT_METHOD_INVALID branch that fires when the label ISN'T card-like.
  // A real captured charge submitted with a stray label ('creditcard' instead of
  // 'credit_card') was rejected with no reversal candidate, so the charge sat
  // paid with no order — the exact stranding class this guard exists to prevent.
  // The label is untrusted client input; the caller's strict order+amount
  // binding is what makes the reversal safe.
  const decision = guardOrderFinalizationRequest({
    isFinalCommit: true,
    submittedPaymentId: 'pay_captured_real',
    paymentMethod: 'creditcard',
    cardPortionHalalas: 19_500,
    walletAppliedHalalas: 2_000,
    hasRewardBearingItems: false,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, 'PAYMENT_METHOD_INVALID');
  assert.equal(decision.providerPaymentIdToReverse, 'pay_captured_real');
});

test('reserved sentinels are never offered as a reversal candidate', () => {
  // The reversal candidate widened to ignore the method label, so re-pin the
  // boundary that actually matters: a wallet/reward/cashback sentinel is not a
  // provider payment and must never reach a provider mutation.
  const decision = guardOrderFinalizationRequest({
    isFinalCommit: true,
    submittedPaymentId: 'wallet:txn_123',
    paymentMethod: 'nonsense_label',
    cardPortionHalalas: 19_500,
    walletAppliedHalalas: 0,
    hasRewardBearingItems: false,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.providerPaymentIdToReverse, undefined);
});
