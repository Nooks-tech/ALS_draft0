import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampDeliveryHalalas,
  promoCapHalalas,
  reconcileOrderTotal,
  sarToHalalas,
  RECONCILE_TOLERANCE_HALALAS,
} from '../utils/orderTotalReconciliation';

test('a clean order reconciles exactly (no discounts)', () => {
  // 2 items @ 25.00 = 50.00, no delivery/promo/cashback, client claims 50.00.
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(50),
    deliveryHalalas: 0,
    claimedPromoHalalas: 0,
    promoCapHalalas: 0,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(50),
  });
  assert.equal(r.expectedHalalas, 5000);
  assert.equal(r.underclaim, false);
  assert.equal(r.overclaim, false);
});

test('THE EXPLOIT: client charges 5% of the real total with no discounts -> underclaim rejected', () => {
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(200),
    deliveryHalalas: 0,
    claimedPromoHalalas: 0,
    promoCapHalalas: 0,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(10), // claims 10 SAR for a 200 SAR cart
  });
  assert.equal(r.expectedHalalas, 20000);
  assert.equal(r.underclaim, true);
});

test('within 0.10 SAR tolerance is accepted (rounding drift)', () => {
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(99.99),
    deliveryHalalas: 0,
    claimedPromoHalalas: 0,
    promoCapHalalas: 0,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(99.9), // 9 halalas under
  });
  assert.equal(r.underclaim, false, 'a 0.09 SAR drift must not reject');
});

test('11 halalas under IS rejected (just beyond tolerance)', () => {
  const r = reconcileOrderTotal({
    itemsHalalas: 10000,
    deliveryHalalas: 0,
    claimedPromoHalalas: 0,
    promoCapHalalas: 0,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: 10000 - (RECONCILE_TOLERANCE_HALALAS + 1),
  });
  assert.equal(r.underclaim, true);
});

test('overclaim (frozen promo + added items) is warned, NOT rejected', () => {
  // Customer applied a promo, then added items; client total is higher than a
  // fresh server recompute. Must not reject.
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(50),
    deliveryHalalas: 0,
    claimedPromoHalalas: 0,
    promoCapHalalas: 0,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(60),
  });
  assert.equal(r.underclaim, false);
  assert.equal(r.overclaim, true);
});

test('PERCENT PROMO: claimed discount is capped at percent x server base', () => {
  // 10% promo on 100 SAR items = 10 SAR cap. Attacker claims 90 SAR off.
  const cap = promoCapHalalas({ discount_percent: 10, discount_fixed: null }, 'total', sarToHalalas(100), 0);
  assert.equal(cap, 1000); // 10 SAR
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(100),
    deliveryHalalas: 0,
    claimedPromoHalalas: sarToHalalas(90), // tampered
    promoCapHalalas: cap,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(10), // items 100 - claimed 90
  });
  // effective promo bounded to 10 SAR -> expected = 90 SAR -> client 10 is underclaim.
  assert.equal(r.effectivePromoHalalas, 1000 + RECONCILE_TOLERANCE_HALALAS);
  assert.equal(r.underclaim, true);
});

test('PERCENT PROMO legit: 10% off 100 -> total 90 reconciles', () => {
  const cap = promoCapHalalas({ discount_percent: 10, discount_fixed: null }, 'total', sarToHalalas(100), 0);
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(100),
    deliveryHalalas: 0,
    claimedPromoHalalas: sarToHalalas(10),
    promoCapHalalas: cap,
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(90),
  });
  assert.equal(r.underclaim, false);
  assert.equal(r.overclaim, false);
});

test('promo scope delivery: cap uses the delivery base only', () => {
  const cap = promoCapHalalas({ discount_percent: 100, discount_fixed: null }, 'delivery', sarToHalalas(200), sarToHalalas(15));
  assert.equal(cap, 1500, '100% delivery promo caps at the 15 SAR fee, not the 200 SAR items');
});

test('promo scope order_total: cap uses items + delivery', () => {
  const cap = promoCapHalalas({ discount_percent: 10, discount_fixed: null }, 'order_total', sarToHalalas(100), sarToHalalas(20));
  assert.equal(cap, 1200); // 10% of 120
});

test('fixed promo cap ignores base', () => {
  const cap = promoCapHalalas({ discount_percent: null, discount_fixed: 5 }, 'total', sarToHalalas(100), 0);
  assert.equal(cap, 500);
});

test('stage-wise clamp: delivery-scope promo bigger than a tiny cart clamps to 0, not negative', () => {
  // items 8, delivery 15, promo 15 (delivery-scope). afterPromo = max(0, 8+15-15)=8.
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(8),
    deliveryHalalas: sarToHalalas(15),
    claimedPromoHalalas: sarToHalalas(15),
    promoCapHalalas: sarToHalalas(15),
    validatedCashbackHalalas: 0,
    clientTotalHalalas: sarToHalalas(8),
  });
  assert.equal(r.expectedHalalas, 800);
  assert.equal(r.underclaim, false);
});

test('cashback covers all -> expected 0, client 0 reconciles', () => {
  const r = reconcileOrderTotal({
    itemsHalalas: sarToHalalas(30),
    deliveryHalalas: 0,
    claimedPromoHalalas: 0,
    promoCapHalalas: 0,
    validatedCashbackHalalas: sarToHalalas(30),
    clientTotalHalalas: 0,
  });
  assert.equal(r.expectedHalalas, 0);
  assert.equal(r.underclaim, false);
});

test('clampDeliveryHalalas: 0 for non-delivery, clamped for delivery', () => {
  assert.equal(clampDeliveryHalalas('pickup', 999), 0);
  assert.equal(clampDeliveryHalalas('delivery', 15), 1500);
  assert.equal(clampDeliveryHalalas('delivery', -5), 0);
  assert.equal(clampDeliveryHalalas('delivery', 99999), 10000); // capped at 100 SAR
});
