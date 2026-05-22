import { createClient } from '@supabase/supabase-js';
import { captureError } from './sentryContext';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

/**
 * Phase D — cron heartbeat wrapper.
 *
 * Wrap every cron tick so we get a `cron_runs` row at start + update
 * on completion. A health check can then query MAX(started_at) per
 * cron and alert if a cron hasn't fired in 2x its expected interval.
 *
 * Behavior:
 *   - If the inner fn throws, we catch it, mark the row 'failed',
 *     ship to Sentry, and RE-THROW. The outer setInterval already
 *     has its own try/catch (existing pattern) but having heartbeat
 *     run independently means a heartbeat failure doesn't suppress
 *     the actual error.
 *   - If supabaseAdmin is null (env not configured), we still run
 *     the fn but don't write the heartbeat. The cron still works.
 *
 * Usage from inside a cron's tick:
 *     await runWithHeartbeat('cartAbandonment', async () => { ... });
 */
export async function runWithHeartbeat<T>(
  name: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  let heartbeatWritten = false;

  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.from('cron_runs').insert({
        name,
        started_at: startedAtIso,
        status: 'running',
        payload: extra ?? null,
      });
      if (!error) heartbeatWritten = true;
      else {
        console.warn('[cronHeartbeat] start insert failed', { name, error: error.message });
      }
    } catch (e: any) {
      console.warn('[cronHeartbeat] start insert threw', { name, error: e?.message });
    }
  }

  let result: T;
  try {
    result = await fn();
  } catch (err: any) {
    const durationMs = Date.now() - startedAt.getTime();
    if (heartbeatWritten && supabaseAdmin) {
      try {
        await supabaseAdmin
          .from('cron_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            duration_ms: durationMs,
            last_error: (err?.message || String(err)).slice(0, 1000),
          })
          .eq('name', name)
          .eq('started_at', startedAtIso);
      } catch { /* heartbeat write failure is non-fatal */ }
    }
    captureError(err, {
      component: `cron.${name}`,
      extra: { durationMs, ...(extra ?? {}) },
    });
    throw err;
  }

  const durationMs = Date.now() - startedAt.getTime();
  if (heartbeatWritten && supabaseAdmin) {
    try {
      await supabaseAdmin
        .from('cron_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
        })
        .eq('name', name)
        .eq('started_at', startedAtIso);
    } catch { /* heartbeat write failure is non-fatal */ }
  }
  return result;
}

/**
 * Health-check helper. Returns { ok, lastStartedAt, ageMs } for a cron.
 * Use from a future /ready endpoint or a dashboard widget.
 */
export async function getCronHealth(name: string, expectedIntervalMs: number) {
  if (!supabaseAdmin) {
    return { ok: false, reason: 'db-unconfigured', lastStartedAt: null, ageMs: null };
  }
  const { data, error } = await supabaseAdmin
    .from('cron_runs')
    .select('started_at, status, duration_ms, last_error')
    .eq('name', name)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: 'db-error', error: error.message, lastStartedAt: null, ageMs: null };
  }
  if (!data) {
    return { ok: false, reason: 'never-ran', lastStartedAt: null, ageMs: null };
  }
  const lastStartedAt = new Date(data.started_at as string);
  const ageMs = Date.now() - lastStartedAt.getTime();
  const ok = ageMs < expectedIntervalMs * 2 && data.status !== 'failed';
  return {
    ok,
    reason: ok ? 'healthy' : data.status === 'failed' ? 'last-run-failed' : 'stale',
    lastStartedAt: data.started_at as string,
    ageMs,
    durationMs: (data.duration_ms as number) ?? null,
    lastError: (data.last_error as string) ?? null,
  };
}
