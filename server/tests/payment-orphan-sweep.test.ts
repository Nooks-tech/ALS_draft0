import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminalOrphanBindingFailure,
  orderAlreadyLanded,
} from '../cron/paymentOrphanSweep';

test('terminalizes deterministic binding failures after an authoritative paid read', () => {
  assert.equal(
    isTerminalOrphanBindingFailure({ retryable: false, providerStatus: 'paid' }),
    true,
  );
  assert.equal(
    isTerminalOrphanBindingFailure({ retryable: false, providerStatus: 'CAPTURED' }),
    true,
  );
});

test('keeps transient and unavailable provider reads retryable', () => {
  assert.equal(
    isTerminalOrphanBindingFailure({ retryable: true, providerStatus: 'paid' }),
    false,
  );
  assert.equal(
    isTerminalOrphanBindingFailure({ retryable: false, providerStatus: 'unknown' }),
    false,
  );
  assert.equal(
    isTerminalOrphanBindingFailure({ retryable: false }),
    false,
  );
});

test('terminalizes an authoritative provider 404 so fake UUIDs cannot hot-loop', () => {
  assert.equal(
    isTerminalOrphanBindingFailure({
      retryable: false,
      providerStatus: 'unknown',
      reason: 'Moyasar HTTP 404',
    }),
    true,
  );
  assert.equal(
    isTerminalOrphanBindingFailure({
      retryable: false,
      providerStatus: 'unknown',
      reason: 'Moyasar secret key not configured',
    }),
    true,
  );
});

function orderLookupAdmin(
  rows: Array<Record<string, unknown>>,
) {
  return {
    from(table: string) {
      assert.equal(table, 'customer_orders');
      const filters = new Map<string, unknown>();
      const chain = {
        select() {
          return chain;
        },
        eq(field: string, value: unknown) {
          filters.set(field, value);
          return chain;
        },
        limit() {
          return chain;
        },
        async maybeSingle() {
          const data =
            rows.find((row) =>
              Array.from(filters).every(([field, value]) => row[field] === value),
            ) ?? null;
          return { data, error: null };
        },
      };
      return chain;
    },
  } as any;
}

test('an order-id collision belonging to another customer does not close the candidate', async () => {
  const candidate = {
    payment_id: 'payment-new',
    merchant_id: 'merchant-1',
    amount_halalas: 1_000,
    metadata_order_id: 'order-1730000000000',
    metadata_customer_id: 'customer-new',
    first_seen_at: new Date().toISOString(),
    attempts: 0,
  };
  const otherCustomerOrder = {
    id: candidate.metadata_order_id,
    merchant_id: candidate.merchant_id,
    customer_id: 'customer-other',
    payment_id: 'payment-other',
  };

  assert.deepEqual(
    await orderAlreadyLanded(orderLookupAdmin([otherCustomerOrder]), candidate),
    { found: false },
  );
  assert.deepEqual(
    await orderAlreadyLanded(
      orderLookupAdmin([
        { ...otherCustomerOrder, customer_id: candidate.metadata_customer_id },
      ]),
      candidate,
    ),
    { found: true },
  );
});
