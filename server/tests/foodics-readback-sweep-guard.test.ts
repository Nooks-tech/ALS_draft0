import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readbackPermitsTimeoutCancel,
  type FoodicsStatusReadbackResult,
} from '../utils/foodicsStatusReadback';

// Regression guard for the read-back fail-open (2026-07-15): the no-accept
// sweep must cancel + void + refund ONLY on a proven not-accepted read. The
// original bug gated on `ok` (HTTP transport) alone, so a failed Foodics read
// returned HTTP 200 with accepted===undefined and the sweep cancelled an
// order the store had already accepted.

test('cancel permitted ONLY when read succeeded AND store proved not-accepted', () => {
  const r: FoodicsStatusReadbackResult = { ok: true, readOk: true, accepted: false };
  assert.equal(readbackPermitsTimeoutCancel(r), true);
});

test('failed Foodics read behind a 200 relay does NOT permit cancel (the fixed bug)', () => {
  // nooksweb returns HTTP 200 (ok:true) but the Foodics call failed: readOk
  // false, accepted undefined. This is the exact shape that used to cancel an
  // accepted order.
  const r: FoodicsStatusReadbackResult = { ok: true, readOk: false, accepted: undefined, reason: 'Foodics request failed: 502' };
  assert.equal(readbackPermitsTimeoutCancel(r), false);
});

test('HTTP relay failure does NOT permit cancel', () => {
  const r: FoodicsStatusReadbackResult = { ok: false, reason: 'status read-back HTTP 500' };
  assert.equal(readbackPermitsTimeoutCancel(r), false);
});

test('accepted store does NOT permit cancel', () => {
  const r: FoodicsStatusReadbackResult = { ok: true, readOk: true, accepted: true, to: 'Preparing' };
  assert.equal(readbackPermitsTimeoutCancel(r), false);
});

test('acceptance unknown (readOk true but accepted undefined) does NOT permit cancel', () => {
  const r: FoodicsStatusReadbackResult = { ok: true, readOk: true, accepted: undefined };
  assert.equal(readbackPermitsTimeoutCancel(r), false);
});

test('old nooksweb without readOk (backward-compat) does NOT permit cancel', () => {
  // An ALS deploy that lands before nooksweb ships `readOk`: the field is
  // absent, so the sweep conservatively skips every candidate. Safe-degraded
  // (delayed legit sweeps) rather than wrong-cancel.
  const r: FoodicsStatusReadbackResult = { ok: true, accepted: false } as FoodicsStatusReadbackResult;
  assert.equal(readbackPermitsTimeoutCancel(r), false);
});

test('the no-config early-return does NOT permit cancel', () => {
  const r: FoodicsStatusReadbackResult = { ok: false, reason: 'nooks internal relay not configured' };
  assert.equal(readbackPermitsTimeoutCancel(r), false);
});
