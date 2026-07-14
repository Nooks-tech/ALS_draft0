// LOY-B (2026-07-10 audit) — the cross-channel earn guard must match BOTH
// reference_id forms a prior earn can carry for the same physical purchase:
// the bare Foodics uuid (app / branch earns) AND the kiosk walk-in form
// 'walkin_<uuid>'. Matching only the bare uuid let an app-commit race a
// kiosk walk-in sync into a double earn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crossChannelEarnReferenceIds } from '../routes/loyalty';

test('guard lookup covers the bare uuid AND the walkin_ prefixed form', () => {
  const uuid = '9a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
  assert.deepEqual(crossChannelEarnReferenceIds(uuid), [uuid, `walkin_${uuid}`]);
});

test('forms are distinct — walkin_<uuid> and <uuid> are different ledger keys', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const [bare, walkin] = crossChannelEarnReferenceIds(uuid);
  assert.notEqual(bare, walkin);
  assert.ok(walkin.startsWith('walkin_'));
  assert.equal(walkin.slice('walkin_'.length), bare);
});
