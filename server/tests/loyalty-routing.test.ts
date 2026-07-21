import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseInitialLoyaltyMode, shouldKeepExistingLoyaltyMode } from '../utils/loyaltyRouting';

test('cashback customer keeps cashback after merchant changes to points', () => {
  assert.equal(shouldKeepExistingLoyaltyMode({ merchantMode: 'points', customerMode: 'cashback', existingBalance: 11 }), true);
});

test('customer switches after the old balance reaches zero', () => {
  assert.equal(shouldKeepExistingLoyaltyMode({ merchantMode: 'points', customerMode: 'cashback', existingBalance: 0 }), false);
});

test('legacy profile without an active type preserves its sole old balance', () => {
  assert.equal(chooseInitialLoyaltyMode({ merchantMode: 'points', pointsBalance: 0, cashbackBalance: 11 }), 'cashback');
  assert.equal(chooseInitialLoyaltyMode({ merchantMode: 'cashback', pointsBalance: 25, cashbackBalance: 0 }), 'points');
});

test('brand-new customer starts on the merchant current loyalty mode', () => {
  assert.equal(chooseInitialLoyaltyMode({ merchantMode: 'points', pointsBalance: 0, cashbackBalance: 0 }), 'points');
});
