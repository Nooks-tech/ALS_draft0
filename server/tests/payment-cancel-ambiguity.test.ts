import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelPayment, verifyPaidPayment } from '../services/payment';

type FetchCall = { url: string; method: string };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(
  handlers: Array<(call: FetchCall) => Response | Promise<Response>>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: String(init?.method ?? 'GET').toUpperCase(),
    };
    calls.push(call);
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`Unexpected fetch call ${calls.length}: ${call.method} ${call.url}`);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const paidReadback = () => jsonResponse(200, { id: 'pay_1', status: 'paid', amount: 1_000, refunded: 0 });

test('an ownership fence that fails after read-back prevents every provider write', async () => {
  const fake = fakeFetch([paidReadback]);
  const fencedOperations: string[] = [];
  const result = await cancelPayment('pay_1', undefined, null, {
    fetchImpl: fake.fetchImpl,
    secretKey: 'test_secret',
    beforeProviderWrite: async (operation) => {
      fencedOperations.push(operation);
      return false;
    },
  });

  assert.equal(result.method, 'unknown');
  assert.deepEqual(fencedOperations, ['void']);
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET']);
});

test('void network ambiguity returns unknown immediately and never writes a refund', async () => {
  const fake = fakeFetch([
    paidReadback,
    async () => { throw new Error('socket closed after write'); },
  ]);
  const result = await cancelPayment('pay_1', undefined, null, {
    fetchImpl: fake.fetchImpl,
    secretKey: 'test_secret',
  });

  assert.equal(result.method, 'unknown');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST']);
  assert.equal(fake.calls.some((call) => call.url.endsWith('/refund')), false);
});

for (const scenario of [
  { name: 'HTTP 429', response: () => jsonResponse(429, { message: 'slow down' }) },
  { name: 'HTTP 500', response: () => jsonResponse(500, { message: 'upstream failed' }) },
  { name: 'ambiguous 2xx', response: () => jsonResponse(200, { id: 'pay_1', status: 'paid' }) },
]) {
  test(`void ${scenario.name} stops after one provider write`, async () => {
    const fake = fakeFetch([paidReadback, scenario.response]);
    const result = await cancelPayment('pay_1', undefined, null, {
      fetchImpl: fake.fetchImpl,
      secretKey: 'test_secret',
    });

    assert.equal(result.method, 'unknown');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(fake.calls.some((call) => call.url.endsWith('/refund')), false);
  });
}

test('a deterministic void 4xx may fall back to one clearly confirmed refund', async () => {
  const fake = fakeFetch([
    paidReadback,
    () => jsonResponse(400, { message: 'cannot void a settled payment' }),
    () => jsonResponse(200, { id: 'pay_1', status: 'refunded', amount: 1_000, refunded: 1_000 }),
  ]);
  const result = await cancelPayment('pay_1', undefined, null, {
    fetchImpl: fake.fetchImpl,
    secretKey: 'test_secret',
  });

  assert.equal(result.method, 'refund');
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST', 'POST']);
});

test('void-to-refund fallback rechecks ownership before the second provider write', async () => {
  const fake = fakeFetch([
    paidReadback,
    () => jsonResponse(400, { message: 'cannot void a settled payment' }),
  ]);
  const fencedOperations: string[] = [];
  const result = await cancelPayment('pay_1', undefined, null, {
    fetchImpl: fake.fetchImpl,
    secretKey: 'test_secret',
    beforeProviderWrite: async (operation) => {
      fencedOperations.push(operation);
      return operation === 'void';
    },
  });

  assert.equal(result.method, 'unknown');
  assert.deepEqual(fencedOperations, ['void', 'refund']);
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST']);
});

test('provider read-back reports already-voided and already-refunded as returned', async () => {
  const voided = fakeFetch([
    () => jsonResponse(200, { id: 'pay_voided', status: 'voided', amount: 1_000, refunded: 0 }),
  ]);
  const voidedResult = await cancelPayment('pay_voided', undefined, null, {
    fetchImpl: voided.fetchImpl,
    secretKey: 'test_secret',
  });
  assert.equal(voidedResult.method, 'void');
  assert.equal(voided.calls.length, 1);

  const refunded = fakeFetch([
    () => jsonResponse(200, { id: 'pay_refunded', status: 'refunded', amount: 1_000, refunded: 1_000 }),
  ]);
  const refundedResult = await cancelPayment('pay_refunded', undefined, null, {
    fetchImpl: refunded.fetchImpl,
    secretKey: 'test_secret',
  });
  assert.equal(refundedResult.method, 'refund');
  assert.equal(refunded.calls.length, 1);
});

test('partial refund network ambiguity is unknown after its single write', async () => {
  const fake = fakeFetch([
    paidReadback,
    async () => { throw new Error('timeout'); },
  ]);
  const result = await cancelPayment('pay_1', 500, null, {
    fetchImpl: fake.fetchImpl,
    secretKey: 'test_secret',
  });

  assert.equal(result.method, 'unknown');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1);
});

for (const scenario of [
  { name: 'HTTP 429', response: () => jsonResponse(429, { message: 'slow down' }) },
  { name: 'HTTP 500', response: () => jsonResponse(500, { message: 'upstream failed' }) },
  { name: 'ambiguous 2xx', response: () => jsonResponse(200, { id: 'pay_1', status: 'paid', refunded: 0 }) },
]) {
  test(`refund ${scenario.name} returns unknown after its only provider write`, async () => {
    const fake = fakeFetch([paidReadback, scenario.response]);
    const result = await cancelPayment('pay_1', 500, null, {
      fetchImpl: fake.fetchImpl,
      secretKey: 'test_secret',
    });

    assert.equal(result.method, 'unknown');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1);
  });
}

test('partial refund 2xx must prove a delta beyond the prior refunded amount', async () => {
  const fake = fakeFetch([
    () => jsonResponse(200, { id: 'pay_1', status: 'paid', amount: 2_000, refunded: 500 }),
    () => jsonResponse(200, { id: 'pay_1', status: 'paid', amount: 2_000, refunded: 500 }),
  ]);
  const result = await cancelPayment('pay_1', 500, null, {
    fetchImpl: fake.fetchImpl,
    secretKey: 'test_secret',
  });

  assert.equal(result.method, 'unknown');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1);
});

test('strict reversal verification requires the provider payment to be bound to this order', async () => {
  for (const [name, metadata, expectedOk] of [
    ['matching binding', { order_id: 'order_expected' }, true],
    ['missing binding', {}, false],
    ['different binding', { order_id: 'order_other' }, false],
  ] as const) {
    const fake = fakeFetch([
      () => jsonResponse(200, {
        id: `pay_${name.replace(/\s/g, '_')}`,
        status: 'paid',
        amount: 1_000,
        currency: 'SAR',
        metadata,
      }),
    ]);
    const result = await verifyPaidPayment('pay_candidate', 1_000, null, 'order_expected', {
      requireOrderBinding: true,
      fetchImpl: fake.fetchImpl,
      secretKey: 'test_secret',
    });
    assert.equal(result.ok, expectedOk, name);
    assert.equal(fake.calls.length, 1, name);
  }
});
