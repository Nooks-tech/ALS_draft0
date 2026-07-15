import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORICAL_MANIFEST_SHA256,
  interpretMigrationStatusRow,
  type MigrationStatusRpcRow,
} from '../utils/migrationStatus';

const NOW = Date.parse('2026-07-15T00:00:00Z');

function reconciledRow(overrides: Partial<MigrationStatusRpcRow> = {}): MigrationStatusRpcRow {
  return {
    latest_version: '20260522000001',
    latest_name: 'migration_status_rpc',
    total_applied: '68',
    manifest_sha256: HISTORICAL_MANIFEST_SHA256,
    authority_repository: 'ALS',
    total_inventory: '157',
    registered_exact: '62',
    live_effect_attested: '49',
    superseded_obsolete: '4',
    pending_unproven: '42',
    manifest_complete: true,
    hashes_valid: true,
    manifest_count: '2',
    authoritative_manifest_sha256: 'a'.repeat(64),
    authoritative_release_count: '4',
    deployment_attestation_complete: true,
    ...overrides,
  };
}

test('reports the honest pending/unproven inventory instead of calling all files applied', () => {
  const status = interpretMigrationStatusRow(reconciledRow(), NOW);

  assert.equal(status.ok, false);
  assert.equal(status.driftSuspected, true);
  assert.equal(status.reason, 'pending-unproven-history (42)');
  assert.equal(status.totalInventory, 157);
  assert.equal(status.registeredExact, 62);
  assert.equal(status.liveEffectAttested, 49);
  assert.equal(status.supersededObsolete, 4);
  assert.equal(status.pendingUnproven, 42);
  assert.equal(status.authorityRepository, 'ALS');
});

test('accepts a structurally complete, hash-valid, fully attested future manifest state', () => {
  const status = interpretMigrationStatusRow(
    reconciledRow({
      live_effect_attested: '91',
      pending_unproven: '0',
    }),
    NOW,
  );

  assert.equal(status.ok, true);
  assert.equal(status.driftSuspected, false);
  assert.equal(status.reason, null);
  // The built-in registry date is diagnostic only once manifests are active.
  assert.ok((status.latestAppliedAgeDays ?? 0) > 30);
});

test('fails closed when the finalized ALS deployment attestation is absent', () => {
  const status = interpretMigrationStatusRow(
    reconciledRow({
      authoritative_manifest_sha256: null,
      authoritative_release_count: '0',
      deployment_attestation_complete: false,
      manifest_count: '1',
    }),
    NOW,
  );

  assert.equal(status.reason, 'authoritative-deployment-attestation-missing');
  assert.equal(status.driftSuspected, true);
});

test('prioritizes structural and hash failures over evidence backlog', () => {
  assert.equal(
    interpretMigrationStatusRow(reconciledRow({ manifest_complete: false }), NOW).reason,
    'manifest-incomplete',
  );
  assert.equal(
    interpretMigrationStatusRow(reconciledRow({ hashes_valid: false }), NOW).reason,
    'manifest-hash-mismatch',
  );
});

test('rejects status counts that do not add up to the inventory', () => {
  const status = interpretMigrationStatusRow(
    reconciledRow({
      pending_unproven: '0',
      total_inventory: '999',
    }),
    NOW,
  );

  assert.equal(status.reason, 'manifest-status-counts-invalid');
});

test('rejects a missing or unexpected historical manifest and an empty RPC result', () => {
  assert.equal(
    interpretMigrationStatusRow(reconciledRow({ manifest_sha256: 'b'.repeat(64) }), NOW).reason,
    'historical-manifest-missing-or-unexpected',
  );
  assert.equal(interpretMigrationStatusRow(null, NOW).reason, 'manifest-status-empty');
});

