// DB-4 (2026-07-10 audit) — cronLock FAILS CLOSED on a lock error.
//
// The lock client is pointed at an unroutable local endpoint so the claim RPC
// deterministically errors (connection refused). Pre-DB-4 behavior returned
// true ("run unlocked") — exactly during the DB stress that lets 2+ replicas
// overlap on non-idempotent ticks. Post-DB-4 it must return false (skip the
// tick; the next interval self-heals).
//
// Env is set BEFORE the dynamic import (module reads it at load). Runs in its
// own node:test child process, so this env never leaks into other test files.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1'; // nothing listens here
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-not-a-real-key';

test('tryClaimCronTick returns false (skips the tick) when the claim RPC errors', async () => {
  // Dynamic import AFTER the env assignments above (the module reads env at
  // load; tsx compiles tests as CJS, so no top-level await).
  const { tryClaimCronTick } = await import('../utils/cronLock');
  const claimed = await tryClaimCronTick('unit-test-fail-closed', 30);
  assert.equal(claimed, false);
});
