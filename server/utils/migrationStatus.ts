import { createClient } from '@supabase/supabase-js';
import { captureError } from './sentryContext';
import { writeAudit } from './auditLog';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// If the latest applied migration is older than this many days
// relative to the deploy time, we treat it as drift and log loudly.
// The 2026-05-22 incident had a 50-migration / 6-week gap go
// undetected — anything more than ~14 days is suspicious.
const MIGRATION_DRIFT_WARN_DAYS = 14;

export type MigrationStatus = {
  ok: boolean;
  latestVersion: string | null;
  latestName: string | null;
  latestAppliedAgeDays: number | null;
  totalApplied: number | null;
  driftSuspected: boolean;
  reason: string | null;
};

/**
 * Query supabase_migrations.schema_migrations for the latest applied
 * migration version. The version is a 14-digit YYYYMMDDhhmmss
 * timestamp from the filename prefix. We parse it, compute the age
 * relative to now (the assumption being: the server just started up,
 * so "now" ≈ "deploy time"), and flag if the gap exceeds the warn
 * threshold.
 *
 * This is intentionally a coarse check — we can't read the migrations
 * directory from inside the Docker container (the build context is
 * only the server/ folder; supabase/migrations/ is one level up).
 * A more precise check (file-vs-DB diff) would require either baking
 * a manifest at build time or fetching from GitHub at runtime. For
 * the kind of bug we're trying to catch (multi-week migration gap),
 * the age-of-latest-applied check is sufficient.
 */
export async function checkMigrationStatus(): Promise<MigrationStatus> {
  if (!supabaseAdmin) {
    return {
      ok: false,
      latestVersion: null,
      latestName: null,
      latestAppliedAgeDays: null,
      totalApplied: null,
      driftSuspected: false,
      reason: 'supabase-unconfigured',
    };
  }
  try {
    // supabase-js's PostgREST proxy only sees the `public` schema by
    // default, so we can't direct-query supabase_migrations.schema_migrations.
    // The 20260522000001_migration_status_rpc.sql migration adds a
    // SECURITY DEFINER function that exposes the summary; we call it
    // here. If the RPC itself is missing (e.g. that migration hasn't
    // been applied yet), we treat it as inconclusive — meta-drift.
    const { data, error } = await supabaseAdmin.rpc('get_migration_status');
    if (error) {
      return {
        ok: false,
        latestVersion: null,
        latestName: null,
        latestAppliedAgeDays: null,
        totalApplied: null,
        driftSuspected: false,
        reason: `rpc-error: ${error.message}`,
      };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const latest = (row ?? null) as { latest_version?: string; latest_name?: string; total_applied?: number } | null;
    if (!latest?.latest_version) {
      return {
        ok: false,
        latestVersion: null,
        latestName: null,
        latestAppliedAgeDays: null,
        totalApplied: 0,
        driftSuspected: true,
        reason: 'schema-migrations-empty',
      };
    }
    // Parse YYYYMMDDhhmmss
    const v = latest.latest_version;
    let ageDays: number | null = null;
    if (v.length === 14 && /^\d+$/.test(v)) {
      const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`;
      const t = Date.parse(iso);
      if (Number.isFinite(t)) {
        ageDays = (Date.now() - t) / (24 * 60 * 60 * 1000);
      }
    }
    const drift = ageDays != null && ageDays > MIGRATION_DRIFT_WARN_DAYS;
    return {
      ok: !drift,
      latestVersion: latest.latest_version,
      latestName: latest.latest_name ?? null,
      latestAppliedAgeDays: ageDays != null ? Number(ageDays.toFixed(2)) : null,
      totalApplied: Number(latest.total_applied ?? 0),
      driftSuspected: drift,
      reason: drift ? `latest-applied-too-old (${ageDays?.toFixed(1)}d > ${MIGRATION_DRIFT_WARN_DAYS}d)` : null,
    };
  } catch (e: any) {
    return {
      ok: false,
      latestVersion: null,
      latestName: null,
      latestAppliedAgeDays: null,
      totalApplied: null,
      driftSuspected: false,
      reason: `threw: ${e?.message}`,
    };
  }
}

/**
 * Startup hook — query the migration status and log loudly if drift
 * is suspected, with a Sentry capture + audit_log row. Called once
 * at boot from index.ts.
 *
 * Why this matters: the 2026-05-22 incident was caused by 50 git-
 * applied migrations that were never run against prod, going
 * unnoticed for 6 weeks until the wallet topup broke. With this
 * check, that gap would show up in the very first startup log as
 * a WARN line and in Sentry as a captured event.
 */
export async function logStartupMigrationStatus(): Promise<void> {
  const status = await checkMigrationStatus();
  if (status.driftSuspected) {
    console.warn(
      `[startup] ⚠️  MIGRATION DRIFT SUSPECTED — latest applied: ${status.latestVersion} (${status.latestName}), age ${status.latestAppliedAgeDays}d. Reason: ${status.reason}. Apply pending migrations via 'supabase migrate up' or the management API.`,
    );
    captureError(new Error(`Migration drift suspected: ${status.reason}`), {
      component: 'startup.migrationDrift',
      extra: {
        latest_version: status.latestVersion,
        latest_name: status.latestName,
        age_days: status.latestAppliedAgeDays,
        total_applied: status.totalApplied,
      },
    });
    void writeAudit({
      merchant_id: null,
      action: 'startup.migration_drift_suspected',
      payload: {
        latest_version: status.latestVersion,
        latest_name: status.latestName,
        age_days: status.latestAppliedAgeDays,
        total_applied: status.totalApplied,
        reason: status.reason,
      },
    });
  } else if (!status.ok && status.reason) {
    console.warn(`[startup] Migration status check inconclusive: ${status.reason}`);
  } else {
    console.log(
      `[startup] Migrations OK — latest applied: ${status.latestVersion} (${status.latestName}), age ${status.latestAppliedAgeDays}d, total applied: ${status.totalApplied}`,
    );
  }
}
