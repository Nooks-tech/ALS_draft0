import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source-assertion tests locking the minimum-order-subtotal gate into the
// authoritative /commit path. The gate's correctness matters on a payment
// path, and its POSITION is load-bearing: it must sit OUTSIDE the shadow
// reconciliation try/catch (which swallows throws) and run on both commits,
// before the reward gate. These assertions fail loudly if a refactor moves it.

const src = readFileSync('routes/orders.ts', 'utf8');

test('commit path uses the shared minimum-subtotal helper', () => {
  assert.match(src, /from '\.\.\/utils\/minimumSubtotal'/);
  assert.match(src, /minSubtotalHalalasForType\(minOps/);
});

test('below-minimum orders are rejected with a reversal-derived safety contract', () => {
  assert.match(src, /code: 'BELOW_MIN_SUBTOTAL'/);
  // A charge may already have landed (Apple Pay / saved card before commit),
  // so the gate must void it. `terminal` is true only when that reversal is
  // confirmed; older clients must not rotate into a second charge otherwise.
  assert.match(src, /voidChargeOnRejectedCommit\([^)]*'min subtotal gate'/s);
  const gate = src.slice(src.indexOf("code: 'BELOW_MIN_SUBTOTAL'") - 400, src.indexOf("code: 'BELOW_MIN_SUBTOTAL'") + 100);
  assert.match(gate, /paymentReversalResponse\(reversal\)/);
});

test('the gate sits outside the shadow reconciliation and before the reward gate', () => {
  const reconcileErr = src.indexOf('TOTAL_RECONCILIATION error (non-blocking)');
  const minGate = src.indexOf("code: 'BELOW_MIN_SUBTOTAL'");
  const rewardGate = src.indexOf('Pre-charge reward-authorization gate');
  assert.ok(reconcileErr > 0 && minGate > 0 && rewardGate > 0, 'anchors present');
  // After the shadow try closes (so a throw is not swallowed) and before the
  // reward gate (so it runs on both the pre-charge and final commits).
  assert.ok(reconcileErr < minGate, 'gate must be after the shadow reconciliation block');
  assert.ok(minGate < rewardGate, 'gate must be before the reward-authorization gate');
});

test('the minimum is read branch-scoped from branch_operations', () => {
  // The gate region: from the end of the shadow reconciliation block up to
  // the rejection code. The branch-scoped read must live inside it.
  const gate = src.slice(
    src.indexOf('TOTAL_RECONCILIATION error (non-blocking)'),
    src.indexOf("code: 'BELOW_MIN_SUBTOTAL'"),
  );
  assert.match(gate, /from\('branch_operations'\)/);
  assert.match(gate, /\.eq\('merchant_id', merchantId\)/);
  assert.match(gate, /\.eq\('branch_id', branchId\)/);
});
