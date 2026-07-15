import { createClient } from '@supabase/supabase-js';
import { captureError } from './sentryContext';
import { writeAudit } from './auditLog';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

export const HISTORICAL_MANIFEST_SHA256 =
  'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493';

export type MigrationStatus = {
  ok: boolean;
  latestVersion: string | null;
  latestName: string | null;
  latestAppliedAgeDays: number | null;
  totalApplied: number | null;
  manifestSha256: string | null;
  authorityRepository: string | null;
  totalInventory: number | null;
  registeredExact: number | null;
  liveEffectAttested: number | null;
  supersededObsolete: number | null;
  pendingUnproven: number | null;
  manifestComplete: boolean;
  hashesValid: boolean;
  manifestCount: number | null;
  authoritativeManifestSha256: string | null;
  authoritativeReleaseCount: number | null;
  deploymentAttestationComplete: boolean;
  driftSuspected: boolean;
  reason: string | null;
};

export type MigrationStatusRpcRow = {
  latest_version?: unknown;
  latest_name?: unknown;
  total_applied?: unknown;
  manifest_sha256?: unknown;
  authority_repository?: unknown;
  total_inventory?: unknown;
  registered_exact?: unknown;
  live_effect_attested?: unknown;
  superseded_obsolete?: unknown;
  pending_unproven?: unknown;
  manifest_complete?: unknown;
  hashes_valid?: unknown;
  manifest_count?: unknown;
  authoritative_manifest_sha256?: unknown;
  authoritative_release_count?: unknown;
  deployment_attestation_complete?: unknown;
};

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function strictBoolean(value: unknown): boolean {
  return value === true;
}

function latestVersionAgeDays(version: string | null, nowMs: number): number | null {
  if (!version || !/^\d{14}$/.test(version)) return null;
  const iso =
    `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}` +
    `T${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}Z`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Number(((nowMs - timestamp) / (24 * 60 * 60 * 1000)).toFixed(2));
}

function emptyStatus(reason: string, driftSuspected = false): MigrationStatus {
  return {
    ok: false,
    latestVersion: null,
    latestName: null,
    latestAppliedAgeDays: null,
    totalApplied: null,
    manifestSha256: null,
    authorityRepository: null,
    totalInventory: null,
    registeredExact: null,
    liveEffectAttested: null,
    supersededObsolete: null,
    pendingUnproven: null,
    manifestComplete: false,
    hashesValid: false,
    manifestCount: null,
    authoritativeManifestSha256: null,
    authoritativeReleaseCount: null,
    deploymentAttestationComplete: false,
    driftSuspected,
    reason,
  };
}

/**
 * Convert the service-only RPC row into the stable /ready response.
 *
 * The built-in Supabase registry fields remain for compatibility and
 * diagnostics, but health is decided by collision-safe manifests, source
 * hashes, evidence status, and the finalized ALS deployment attestation.
 */
export function interpretMigrationStatusRow(
  row: MigrationStatusRpcRow | null | undefined,
  nowMs = Date.now(),
): MigrationStatus {
  if (!row) return emptyStatus('manifest-status-empty', true);

  const latestVersion = nullableString(row.latest_version);
  const latestName = nullableString(row.latest_name);
  const totalApplied = nullableNonnegativeInteger(row.total_applied);
  const manifestSha256 = nullableString(row.manifest_sha256);
  const authorityRepository = nullableString(row.authority_repository);
  const totalInventory = nullableNonnegativeInteger(row.total_inventory);
  const registeredExact = nullableNonnegativeInteger(row.registered_exact);
  const liveEffectAttested = nullableNonnegativeInteger(row.live_effect_attested);
  const supersededObsolete = nullableNonnegativeInteger(row.superseded_obsolete);
  const pendingUnproven = nullableNonnegativeInteger(row.pending_unproven);
  const manifestCount = nullableNonnegativeInteger(row.manifest_count);
  const authoritativeManifestSha256 = nullableString(row.authoritative_manifest_sha256);
  const authoritativeReleaseCount = nullableNonnegativeInteger(row.authoritative_release_count);
  const manifestComplete = strictBoolean(row.manifest_complete);
  const hashesValid = strictBoolean(row.hashes_valid);
  const deploymentAttestationComplete = strictBoolean(row.deployment_attestation_complete);
  const latestAppliedAgeDays = latestVersionAgeDays(latestVersion, nowMs);

  const statusCounts = [
    registeredExact,
    liveEffectAttested,
    supersededObsolete,
    pendingUnproven,
  ];
  const countsValid =
    totalInventory !== null &&
    registeredExact !== null &&
    liveEffectAttested !== null &&
    supersededObsolete !== null &&
    pendingUnproven !== null &&
    statusCounts.every((value) => value !== null) &&
    registeredExact + liveEffectAttested + supersededObsolete + pendingUnproven === totalInventory;

  let reason: string | null = null;
  if (!latestVersion) {
    reason = 'schema-migrations-empty';
  } else if (manifestSha256 !== HISTORICAL_MANIFEST_SHA256) {
    reason = 'historical-manifest-missing-or-unexpected';
  } else if (authorityRepository !== 'ALS') {
    reason = 'shared-db-authority-is-not-als';
  } else if (!manifestComplete) {
    reason = 'manifest-incomplete';
  } else if (!hashesValid) {
    reason = 'manifest-hash-mismatch';
  } else if (
    !deploymentAttestationComplete ||
    !authoritativeManifestSha256 ||
    authoritativeReleaseCount === null ||
    authoritativeReleaseCount < 4 ||
    manifestCount === null ||
    manifestCount < 2
  ) {
    reason = 'authoritative-deployment-attestation-missing';
  } else if (!countsValid) {
    reason = 'manifest-status-counts-invalid';
  } else if ((pendingUnproven ?? 0) > 0) {
    reason = `pending-unproven-history (${pendingUnproven})`;
  }

  return {
    ok: reason === null,
    latestVersion,
    latestName,
    latestAppliedAgeDays,
    totalApplied,
    manifestSha256,
    authorityRepository,
    totalInventory,
    registeredExact,
    liveEffectAttested,
    supersededObsolete,
    pendingUnproven,
    manifestComplete,
    hashesValid,
    manifestCount,
    authoritativeManifestSha256,
    authoritativeReleaseCount,
    deploymentAttestationComplete,
    driftSuspected: reason !== null,
    reason,
  };
}

export async function checkMigrationStatus(): Promise<MigrationStatus> {
  if (!supabaseAdmin) return emptyStatus('supabase-unconfigured');

  try {
    const { data, error } = await supabaseAdmin.rpc('get_migration_status');
    if (error) return emptyStatus(`rpc-error: ${error.message}`);

    const row = (Array.isArray(data) ? data[0] : data) as MigrationStatusRpcRow | null;
    return interpretMigrationStatusRow(row);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyStatus(`threw: ${message}`);
  }
}

/**
 * Startup hook: unresolved inventory is visible without blocking /ready.
 * Pending/unproven history is intentionally noisy until each row is either
 * terminal-effect-attested or explicitly superseded; it is never auto-marked.
 */
export async function logStartupMigrationStatus(): Promise<void> {
  const status = await checkMigrationStatus();
  if (status.driftSuspected) {
    console.warn(
      `[startup] MIGRATION REGISTRY ATTENTION — manifest ${status.manifestSha256 ?? 'missing'}, ` +
        `authority ${status.authorityRepository ?? 'unknown'}, pending/unproven ` +
        `${status.pendingUnproven ?? 'unknown'}. Reason: ${status.reason}. ` +
        'Inspect the collision-safe ledger; append only reviewed ALS-authority attestations.',
    );
    captureError(new Error(`Migration registry attention: ${status.reason}`), {
      component: 'startup.migrationDrift',
      extra: {
        latest_version: status.latestVersion,
        latest_name: status.latestName,
        total_applied: status.totalApplied,
        historical_manifest_sha256: status.manifestSha256,
        authoritative_manifest_sha256: status.authoritativeManifestSha256,
        authority_repository: status.authorityRepository,
        total_inventory: status.totalInventory,
        registered_exact: status.registeredExact,
        live_effect_attested: status.liveEffectAttested,
        superseded_obsolete: status.supersededObsolete,
        pending_unproven: status.pendingUnproven,
        manifest_complete: status.manifestComplete,
        hashes_valid: status.hashesValid,
        deployment_attestation_complete: status.deploymentAttestationComplete,
      },
    });
    void writeAudit({
      merchant_id: null,
      action: 'startup.migration_drift_suspected',
      payload: {
        latest_version: status.latestVersion,
        latest_name: status.latestName,
        historical_manifest_sha256: status.manifestSha256,
        authoritative_manifest_sha256: status.authoritativeManifestSha256,
        authority_repository: status.authorityRepository,
        total_inventory: status.totalInventory,
        registered_exact: status.registeredExact,
        live_effect_attested: status.liveEffectAttested,
        superseded_obsolete: status.supersededObsolete,
        pending_unproven: status.pendingUnproven,
        manifest_complete: status.manifestComplete,
        hashes_valid: status.hashesValid,
        deployment_attestation_complete: status.deploymentAttestationComplete,
        reason: status.reason,
      },
    });
  } else if (!status.ok && status.reason) {
    console.warn(`[startup] Migration registry check inconclusive: ${status.reason}`);
  } else {
    console.log(
      `[startup] Migration registry OK — ${status.totalInventory} releases across ` +
        `${status.manifestCount} manifests; authority ${status.authorityRepository}`,
    );
  }
}
