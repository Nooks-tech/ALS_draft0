import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPaidPayment } from '../services/payment';
import { reverseStrictlyBoundRejectedPayment } from '../utils/rejectedFinalPayment';

function paidPaymentResponse(orderId?: string, customerId?: string): Response {
  return new Response(JSON.stringify({
    id: 'pay_bound_1',
    status: 'paid',
    amount: 3_000,
    currency: 'SAR',
    ...(orderId === undefined && customerId === undefined
      ? {}
      : {
          metadata: {
            ...(orderId === undefined ? {} : { order_id: orderId }),
            ...(customerId === undefined ? {} : { customer_id: customerId }),
          },
        }),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function runStrictCleanup(
  providerOrderId?: string,
  providerCustomerId: string | null = 'customer_expected',
) {
  let cancelCalls = 0;
  let verifyCalls = 0;
  const fetchImpl = (async () =>
    paidPaymentResponse(
      providerOrderId,
      providerCustomerId ?? undefined,
    )) as typeof fetch;

  const result = await reverseStrictlyBoundRejectedPayment(
    {
      submittedPaymentId: 'pay_bound_1',
      expectedAmountHalalas: 3_000,
      merchantId: 'merchant_1',
      orderId: 'order_expected',
      customerId: 'customer_expected',
    },
    {
      verify: async (paymentId, amount, merchantId, orderId, options) => {
        verifyCalls += 1;
        return verifyPaidPayment(paymentId, amount, merchantId, orderId, {
          ...options,
          fetchImpl,
          secretKey: 'test_secret',
        });
      },
      cancel: async (paymentId) => {
        cancelCalls += 1;
        return { method: 'void', fee: 0, moyasarId: paymentId };
      },
    },
  );

  return { result, verifyCalls, cancelCalls };
}

test('missing provider order binding returns before cancel', async () => {
  const { result, verifyCalls, cancelCalls } = await runStrictCleanup();

  assert.equal(verifyCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(result.bindingVerified, false);
  assert.equal(result.providerMutationAttempted, false);
  if (!result.bindingVerified) {
    assert.match(result.reason, /missing required order_id binding/i);
  }
});

test('mismatched provider order binding returns before cancel', async () => {
  const { result, verifyCalls, cancelCalls } = await runStrictCleanup('order_other');

  assert.equal(verifyCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(result.bindingVerified, false);
  assert.equal(result.providerMutationAttempted, false);
  if (!result.bindingVerified) assert.match(result.reason, /order mismatch/i);
});

test('matching provider order binding permits exactly one cancel call', async () => {
  const { result, verifyCalls, cancelCalls } = await runStrictCleanup('order_expected');

  assert.equal(verifyCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(result.bindingVerified, true);
  assert.equal(result.providerMutationAttempted, true);
  if (result.bindingVerified) {
    assert.equal(result.resolvedPaymentId, 'pay_bound_1');
    assert.equal(result.reversal.method, 'void');
    assert.equal(result.disposition.refundStatus, 'refunded');
  }
});

test('missing or mismatched provider customer binding returns before cancel', async () => {
  for (const providerCustomerId of [null, 'customer_other']) {
    const { result, cancelCalls } = await runStrictCleanup(
      'order_expected',
      providerCustomerId,
    );
    assert.equal(cancelCalls, 0);
    assert.equal(result.bindingVerified, false);
    if (!result.bindingVerified) {
      assert.match(result.reason, /customer_id binding|customer mismatch/i);
    }
  }
});
