import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPhaseCFeatureConfiguration,
  createPhaseCValueCommands,
  readPhaseCFeatureConfiguration,
  type PhaseCRpcClient,
} from '../utils/phaseCValueCommands';

test('Phase C server feature flags are off by default', () => {
  const config = readPhaseCFeatureConfiguration({});
  assert.deepEqual(config, {
    walletCommands: false,
    loyaltyCommands: false,
    promoCommands: false,
    rewardReservations: false,
    checkoutCommit: false,
    reservationExpiryWorker: false,
    foodicsType2Rewards: false,
    foodicsType2SandboxContractProven: false,
  });
  assert.doesNotThrow(() => assertPhaseCFeatureConfiguration(config));
});

test('Foodics Type 2 cannot enable without exact-product reservation and sandbox proof', () => {
  const base = readPhaseCFeatureConfiguration({});
  assert.throws(
    () =>
      assertPhaseCFeatureConfiguration({
        ...base,
        foodicsType2Rewards: true,
      }),
    /authenticated sandbox contract proof/,
  );
  assert.doesNotThrow(() =>
    assertPhaseCFeatureConfiguration({
      ...base,
      rewardReservations: true,
      foodicsType2Rewards: true,
      foodicsType2SandboxContractProven: true,
    }),
  );
});
test('checkout cutover requires all local value command families', () => {
  const base = readPhaseCFeatureConfiguration({});
  assert.throws(
    () => assertPhaseCFeatureConfiguration({ ...base, checkoutCommit: true }),
    /requires wallet, loyalty, and promo commands/,
  );
});

test('narrow RPC adapter never sends merchant, customer, price, total, or amount', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db: PhaseCRpcClient = {
    async rpc<T>(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: 'reservation-id' as T, error: null };
    },
  };
  const commands = createPhaseCValueCommands(db);

  await commands.reserveWallet({
    paymentAttemptId: 'attempt',
    paymentComponentId: 'component',
    idempotencyKey: 'idem-0001',
  });
  await commands.reserveCashback({
    paymentAttemptId: 'attempt',
    paymentComponentId: 'component-2',
    idempotencyKey: 'idem-0002',
  });
  await commands.reserveExactProductReward({
    paymentAttemptId: 'attempt',
    quoteLineId: 'quote-line',
    milestoneProductId: 'configured-product',
    quantity: 1,
    idempotencyKey: 'idem-0003',
  });

  for (const { args } of calls) {
    for (const forbidden of [
      'merchant',
      'customer',
      'amount',
      'price',
      'total',
      'sar',
      'halala',
      'points_cost',
    ]) {
      assert.equal(
        Object.keys(args).some((key) => key.toLowerCase().includes(forbidden)),
        false,
        `forbidden authoritative field leaked into RPC args: ${forbidden}`,
      );
    }
  }
});

test('RPC errors fail closed', async () => {
  const commands = createPhaseCValueCommands({
    async rpc<T>() {
      return { data: null as T | null, error: { message: 'database rejected binding' } };
    },
  });
  await assert.rejects(
    commands.commitCheckout({
      quoteId: 'quote',
      paymentAttemptId: 'attempt',
      orderId: 'order',
      idempotencyKey: 'idem-0004',
    }),
    /database rejected binding/,
  );
});
