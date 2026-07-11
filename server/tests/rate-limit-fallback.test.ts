// SCAL-005 — proves the in-memory limiter that the Upstash-outage emergency
// fallback relies on actually BOUNDS requests (previously the Upstash path
// failed open → unlimited on money endpoints). Uses unique bucket values per
// test because previewLimits shares a module-level store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewLimits, type LimitKey } from '../utils/rateLimit';

test('previewLimits blocks after max within the window', () => {
  const keys: LimitKey[] = [{ dim: 'customer', value: 'scal005-block', max: 3, windowMs: 60_000 }];
  assert.equal(previewLimits(keys).ok, true); // 1
  assert.equal(previewLimits(keys).ok, true); // 2
  assert.equal(previewLimits(keys).ok, true); // 3
  const r = previewLimits(keys); // 4 -> blocked
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.dim, 'customer');
});

test('previewLimits ANDs dimensions — the tightest one blocks', () => {
  const keys: LimitKey[] = [
    { dim: 'customer', value: 'scal005-and-c', max: 10, windowMs: 60_000 },
    { dim: 'ip', value: 'scal005-and-ip', max: 2, windowMs: 60_000 },
  ];
  assert.equal(previewLimits(keys).ok, true); // 1
  assert.equal(previewLimits(keys).ok, true); // 2
  const r = previewLimits(keys); // ip dim exceeded
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.dim, 'ip');
});

test('emergency fallback (2x max) allows exactly twice before blocking', () => {
  // Mirrors previewLimitsUpstash catch: previewLimits(keys.map(k => ({...k, max: k.max*2}))).
  const doubled: LimitKey[] = [{ dim: 'customer', value: 'scal005-2x', max: 3 * 2, windowMs: 60_000 }];
  for (let i = 0; i < 6; i++) assert.equal(previewLimits(doubled).ok, true, `req ${i + 1} should pass`);
  assert.equal(previewLimits(doubled).ok, false); // 7th blocked — bounded, NOT unlimited
});

test('different (max,windowMs) configs use separate buckets', () => {
  const v = 'scal005-cfg';
  assert.equal(previewLimits([{ dim: 'customer', value: v, max: 1, windowMs: 60_000 }]).ok, true);
  assert.equal(previewLimits([{ dim: 'customer', value: v, max: 1, windowMs: 60_000 }]).ok, false); // config A exhausted
  // A different max is a different bucket → still allowed.
  assert.equal(previewLimits([{ dim: 'customer', value: v, max: 5, windowMs: 60_000 }]).ok, true);
});
