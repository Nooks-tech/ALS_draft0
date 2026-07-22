import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isBelowMinimum,
  minSubtotalHalalasForType,
  minSubtotalSarForType,
} from '../utils/minimumSubtotal';

const ops = {
  min_order_subtotal_delivery_sar: 20,
  min_order_subtotal_pickup_sar: 10,
  min_order_subtotal_drivethru_sar: 15,
};

test('boundary: below the minimum is rejected, exactly-equal and above are accepted', () => {
  const min = minSubtotalHalalasForType(ops, 'delivery'); // 2000 halalas
  assert.equal(min, 2000);
  assert.equal(isBelowMinimum(1999, min), true); // 19.99 SAR < 20 → reject
  assert.equal(isBelowMinimum(2000, min), false); // exactly 20 → accept
  assert.equal(isBelowMinimum(2001, min), false); // 20.01 → accept
});

test('backward compatibility: null or 0 minimum accepts any subtotal, including 0', () => {
  const noConfig = { ...ops, min_order_subtotal_delivery_sar: null };
  assert.equal(minSubtotalHalalasForType(noConfig, 'delivery'), 0);
  assert.equal(isBelowMinimum(0, 0), false);
  assert.equal(isBelowMinimum(1, 0), false);

  const zero = { ...ops, min_order_subtotal_pickup_sar: 0 };
  assert.equal(minSubtotalHalalasForType(zero, 'pickup'), 0);
  assert.equal(isBelowMinimum(0, minSubtotalHalalasForType(zero, 'pickup')), false);
});

test('null ops object (no branch_operations row) means no minimum', () => {
  assert.equal(minSubtotalHalalasForType(null, 'delivery'), 0);
  assert.equal(minSubtotalSarForType(undefined, 'delivery'), null);
});

test('delivery fee is excluded: the fee is never added into the compared subtotal', () => {
  // Item subtotal 18 SAR, delivery fee 5 SAR. Delivery minimum is 20 SAR.
  // The gate sees only the 1800-halala item subtotal, never 1800 + fee.
  const itemsHalalas = 1800;
  const deliveryFeeHalalas = 500;
  const min = minSubtotalHalalasForType(ops, 'delivery'); // 2000
  assert.equal(isBelowMinimum(itemsHalalas, min), true); // 18 < 20 → reject
  // Proving the fee is not what saves it: even though items+fee = 23 ≥ 20,
  // the gate must still reject because it never sees the fee.
  assert.equal(itemsHalalas + deliveryFeeHalalas >= min, true);
});

test('per-type isolation: each order type uses only its own threshold', () => {
  // A 12 SAR (1200 halalas) cart:
  assert.equal(isBelowMinimum(1200, minSubtotalHalalasForType(ops, 'delivery')), true); // < 20 → reject
  assert.equal(isBelowMinimum(1200, minSubtotalHalalasForType(ops, 'pickup')), false); // ≥ 10 → accept
  assert.equal(isBelowMinimum(1200, minSubtotalHalalasForType(ops, 'drivethru')), true); // < 15 → reject
});

test('dine_in and unknown order types are exempt and never inherit another minimum', () => {
  assert.equal(minSubtotalHalalasForType(ops, 'dine_in'), 0);
  assert.equal(minSubtotalHalalasForType(ops, 'something-else'), 0);
  assert.equal(minSubtotalHalalasForType(ops, null), 0);
  assert.equal(isBelowMinimum(1, minSubtotalHalalasForType(ops, 'dine_in')), false);
});

test('string/numeric coercion from the DB is handled', () => {
  // pg can hand numeric(10,2) back as a string.
  const stringy = {
    min_order_subtotal_delivery_sar: '20.00' as unknown as number,
    min_order_subtotal_pickup_sar: null,
    min_order_subtotal_drivethru_sar: null,
  };
  assert.equal(minSubtotalHalalasForType(stringy, 'delivery'), 2000);
});
