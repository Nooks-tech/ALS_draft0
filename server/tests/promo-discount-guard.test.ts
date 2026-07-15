import assert from 'node:assert/strict';
import test from 'node:test';

import { checkLegacyPromoDiscountMagnitude } from '../utils/promoDiscountGuard';

test('fixed promo: claim within the configured amount is accepted', () => {
  const r = checkLegacyPromoDiscountMagnitude(5, { discount_percent: null, discount_fixed: 5 });
  assert.equal(r.mode, 'fixed');
  assert.equal(r.ok, true);
  assert.equal(r.maxLegalDiscountSar, 5);
});

test('fixed promo: claim BELOW the configured amount is accepted (small cart, big fixed promo)', () => {
  // A 50-SAR fixed promo on a 12-SAR cart legitimately yields only 12 off.
  const r = checkLegacyPromoDiscountMagnitude(12, { discount_percent: null, discount_fixed: 50 });
  assert.equal(r.ok, true, 'must never reject a legit claim below the configured fixed amount');
});

test('fixed promo: claim ABOVE the configured amount is rejected (the R1 tampering case)', () => {
  // Promo configured as "5 SAR off", client claims "50 SAR off".
  const r = checkLegacyPromoDiscountMagnitude(50, { discount_percent: null, discount_fixed: 5 });
  assert.equal(r.mode, 'fixed');
  assert.equal(r.ok, false);
  assert.equal(r.maxLegalDiscountSar, 5);
});

test('fixed promo: accepts within the 0.01 SAR floating-point tolerance', () => {
  const r = checkLegacyPromoDiscountMagnitude(5.009, { discount_percent: null, discount_fixed: 5 });
  assert.equal(r.ok, true);
});

test('fixed promo: just over tolerance is rejected', () => {
  const r = checkLegacyPromoDiscountMagnitude(5.02, { discount_percent: null, discount_fixed: 5 });
  assert.equal(r.ok, false);
});

test('percent promo: intentionally NOT enforced in the legacy path (deferred to canonical quote)', () => {
  // Even an absurd claim on a percent promo passes HERE — the modifier-inclusive
  // base needed to check it safely only exists in the Phase B canonical quote.
  // This is the deliberate no-false-rejection tradeoff; money impact is bounded
  // by the separate 95%-of-menu-floor check.
  const r = checkLegacyPromoDiscountMagnitude(9999, { discount_percent: 10, discount_fixed: null });
  assert.equal(r.mode, 'percent_deferred');
  assert.equal(r.ok, true);
  assert.equal(r.maxLegalDiscountSar, null);
});

test('unconfigured promo (neither fixed nor percent): not enforceable here, not rejected', () => {
  const r = checkLegacyPromoDiscountMagnitude(10, { discount_percent: null, discount_fixed: null });
  assert.equal(r.mode, 'unconfigured');
  assert.equal(r.ok, true);
});

test('fixed promo: negative/garbage configured amount clamps to a zero ceiling', () => {
  const r = checkLegacyPromoDiscountMagnitude(1, { discount_percent: null, discount_fixed: -5 });
  assert.equal(r.maxLegalDiscountSar, 0);
  assert.equal(r.ok, false, 'a positive claim against a zero ceiling is rejected');
});
