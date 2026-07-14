// PRIV-02 (2026-07-10 audit) — saved-card token encryption at rest.
// Proves the envelope codec in server/routes/payment.ts:
//   * encrypt → decrypt roundtrip through the SAME decryptMerchantCredential
//     path the merchant-credential codec uses (v2 keyId envelope),
//   * raw legacy `tok_…` values PASS THROUGH decrypt untouched (deploy-order
//     safety: token-pay keeps working on pre-backfill plaintext rows),
//   * ciphertext tampering is detected (AES-GCM auth tag),
//   * token_hash is stable across encryptions while ciphertexts differ
//     (random IV per write → hash, not ciphertext, is the dedup key).
//
// Env is set BEFORE the dynamic import so the lazy key caches in both
// payment.ts and merchantCredentials.ts pick these keys up. Runs in its own
// node:test child process, so this env never leaks into other test files.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MERCHANT_CREDENTIALS_KEYS = JSON.stringify({ testkey1: 'unit-test-secret-material-1' });
process.env.MERCHANT_CREDENTIALS_ACTIVE_KEY_ID = 'testkey1';
delete process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY;

// require() AFTER the env assignments above — payment.ts and
// merchantCredentials.ts read key env lazily/at-load, and tsx compiles tests
// as CJS (no top-level await for a dynamic import).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  encryptSavedCardToken,
  decryptSavedCardToken,
  savedCardTokenHash,
} = require('../routes/payment') as typeof import('../routes/payment');

test('encrypt → decrypt roundtrip returns the original Moyasar token', () => {
  const raw = 'tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
  const stored = encryptSavedCardToken(raw);
  assert.ok(stored.startsWith('v2:testkey1:'), `expected v2 envelope, got: ${stored.slice(0, 16)}…`);
  assert.notEqual(stored, raw);
  assert.equal(decryptSavedCardToken(stored), raw);
});

test('decrypt passes raw legacy plaintext tokens through untouched', () => {
  // Pre-backfill rows store the bare Moyasar token — decrypt must NOT throw
  // and must NOT alter it, so deploy order can never break token-pay.
  const legacy = 'tok_legacy_plaintext_1234567890';
  assert.equal(decryptSavedCardToken(legacy), legacy);
  // Whitespace-trimmed like every other read path.
  assert.equal(decryptSavedCardToken(`  ${legacy}  `), legacy);
});

test('tampered ciphertext fails to decrypt (GCM auth)', () => {
  const stored = encryptSavedCardToken('tok_tamper_check_0011223344');
  const parts = stored.split(':'); // v2:keyId:iv:tag:ciphertext
  const ct = parts[4];
  const flipped = ct[0] === 'A' ? 'B' : 'A';
  parts[4] = flipped + ct.slice(1);
  assert.throws(() => decryptSavedCardToken(parts.join(':')));
});

test('unknown key id fails loudly instead of returning garbage', () => {
  const stored = encryptSavedCardToken('tok_unknown_key_check');
  const parts = stored.split(':');
  parts[1] = 'no-such-key';
  assert.throws(() => decryptSavedCardToken(parts.join(':')), /key ID|Unknown/i);
});

test('token_hash is stable while ciphertexts differ (random IV)', () => {
  const raw = 'tok_hash_stability_5566778899';
  const a = encryptSavedCardToken(raw);
  const b = encryptSavedCardToken(raw);
  assert.notEqual(a, b); // fresh IV per write → dedup CANNOT key on ciphertext
  assert.equal(decryptSavedCardToken(a), decryptSavedCardToken(b));
  const h1 = savedCardTokenHash(raw);
  const h2 = savedCardTokenHash(` ${raw} `); // trimmed like the write paths
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/); // sha256 hex
  assert.notEqual(savedCardTokenHash('tok_other'), h1);
});

test('empty values fail loudly at use', () => {
  assert.throws(() => encryptSavedCardToken(''));
  assert.throws(() => decryptSavedCardToken(''));
  assert.throws(() => decryptSavedCardToken(null));
  assert.throws(() => decryptSavedCardToken(undefined));
});
