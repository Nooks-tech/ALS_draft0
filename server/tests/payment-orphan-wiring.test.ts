import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routeSource = readFileSync('routes/orders.ts', 'utf8');
const indexSource = readFileSync('index.ts', 'utf8');
const sweepSource = readFileSync('cron/paymentOrphanSweep.ts', 'utf8');
const paymentSource = readFileSync('services/payment.ts', 'utf8');
const migrationSource = readFileSync(
  '../supabase/migrations/20260723130000_payment_orphan_terminal_manual_review.sql',
  'utf8',
);

test('commit persists after merchant existence but before credential, OTP, and rate-limit checks', () => {
  const merchantIndex = routeSource.indexOf(
    'data: recoveryMerchant,',
  );
  const configIndex = routeSource.indexOf(
    'getMerchantPaymentRuntimeConfig(\n          recoveryCandidate.merchant_id',
  );
  const verificationIndex = routeSource.indexOf(
    'const recoveryVerification = await requireVerifiedAtMerchant(',
  );
  const upsertIndex = routeSource.indexOf(
    'const registration = await upsertPaymentOrphanCandidate(',
  );
  const limiterIndex = routeSource.indexOf(
    "endpoint: 'orders.commit.recovery-candidate'",
  );
  assert.ok(merchantIndex >= 0);
  assert.ok(upsertIndex >= 0);
  assert.ok(upsertIndex > merchantIndex);
  assert.ok(limiterIndex > upsertIndex);
  assert.ok(configIndex > upsertIndex);
  assert.ok(verificationIndex > configIndex);
  assert.match(routeSource, /markPaymentOrphanCandidateManualReview/);
});

test('no pre-router limiter can reject an already-captured commit before persistence', () => {
  assert.doesNotMatch(
    indexSource,
    /app\.use\(\s*['"]\/api\/orders\/commit['"][\s\S]*?createCustomerAwareRateLimit/,
  );
  assert.match(
    routeSource,
    /upsertPaymentOrphanCandidate\([\s\S]*?endpoint: 'orders\.commit\.recovery-candidate'/,
  );
});

test('attribution conflicts never trigger a provider reversal', () => {
  const registrationCatchStart = routeSource.indexOf(
    '} catch (candidateError: any) {',
  );
  const postRegistrationStart = routeSource.indexOf(
    'if (recoveryCandidateRegistered && recoveryLeaseToken)',
    registrationCatchStart,
  );
  const registrationCatch = routeSource.slice(
    registrationCatchStart,
    postRegistrationStart,
  );
  assert.ok(registrationCatchStart >= 0);
  assert.ok(postRegistrationStart > registrationCatchStart);
  assert.doesNotMatch(registrationCatch, /voidChargeOnRejectedCommit/);
  assert.match(registrationCatch, /PAYMENT_RECOVERY_CONFLICT/);
  assert.match(routeSource, /code: 'PAYMENT_MANUAL_REVIEW'/);
  assert.match(
    registrationCatch,
    /PaymentOrphanCandidateCapacityError[\s\S]*?insertTerminalPaymentOrphanManualReview/,
  );
});

test('commit renews token ownership at side-effect and order durability boundaries', () => {
  assert.match(
    routeSource,
    /exact boundary before cashback\/promo\/wallet\/reward deductions begin\.[\s\S]*?renewCommitRecoveryLease\(\)/,
  );
  assert.match(
    routeSource,
    /about to[\s\S]*?make its order durable[\s\S]*?renewCommitRecoveryLease\(\)/,
  );
  assert.match(
    routeSource,
    /markPaymentOrphanCandidateOrderFound\([\s\S]*?recoveryLeaseToken/,
  );
});

test('migration enforces token-shaped leases and exempts terminal operator rows from the cap', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS processing_token uuid/);
  assert.match(
    migrationSource,
    /processing_owner IS NULL[\s\S]*processing_token IS NULL[\s\S]*processing_until IS NULL/,
  );
  assert.match(
    migrationSource,
    /processing_owner IN \('commit', 'sweep'\)[\s\S]*processing_token IS NOT NULL[\s\S]*processing_until IS NOT NULL/,
  );
  assert.match(
    migrationSource,
    /IF NEW\.resolved_at IS NOT NULL OR NEW\.metadata_customer_id IS NULL THEN/,
  );
  assert.match(
    migrationSource,
    /idx_payment_orphan_candidates_unresolved_customer[\s\S]*WHERE resolved_at IS NULL AND metadata_customer_id IS NOT NULL/,
  );
});

test('post-capture commit responses never hard-code terminal true', () => {
  const commitStart = routeSource.indexOf("ordersRouter.post('/commit'");
  const commitEnd = routeSource.indexOf(
    "ordersRouter.post('/:id/merchant-refuse'",
    commitStart,
  );
  const commitSource = routeSource.slice(commitStart, commitEnd);
  assert.ok(commitStart >= 0);
  assert.ok(commitEnd > commitStart);
  assert.doesNotMatch(commitSource, /terminal:\s*true/);
  assert.match(commitSource, /paymentReversalResponse\(reversal\)/);
});

test('sweep lease is fenced inside cancelPayment immediately before provider writes', () => {
  assert.match(
    sweepSource,
    /beforeProviderWrite:[\s\S]*?renewPaymentOrphanLease\([\s\S]*?'sweep'/,
  );
  assert.match(
    paymentSource,
    /providerWriteAllowed\('void'\)[\s\S]*?\/void/,
  );
  assert.match(
    paymentSource,
    /providerWriteAllowed\('refund'\)[\s\S]*?\/refund/,
  );
});
