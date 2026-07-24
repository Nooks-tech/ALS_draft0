// Confirms the otp purge cron is actually registered at boot (source-text
// assertion, same convention as payment-orphan-wiring.test.ts — index.ts
// starts a live server on import, so it's never imported directly here).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync('index.ts', 'utf8');

test('otpPurge cron is imported and started alongside the other crons', () => {
  assert.match(indexSource, /import \{ startOtpPurgeCron \} from '\.\/cron\/otpPurge';/);
  const listenStart = indexSource.indexOf('app.listen(');
  assert.ok(listenStart >= 0);
  const listenBody = indexSource.slice(listenStart);
  assert.match(listenBody, /startOtpPurgeCron\(\);/);
});

test('otpPurge is included in the /ready cron health checks', () => {
  assert.match(indexSource, /getCronHealth\('otpPurge', 24 \* 60 \* 60 \* 1000\)/);
  assert.match(indexSource, /otpPurge/);
});
