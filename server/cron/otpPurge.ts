/**
 * OTP purge cron — runs daily.
 *
 * 2026-07-24 legal review, Tier 1 finding #1: the privacy policy promises
 * "OTP logs kept 30 days" but no purge job ever existed — every sms_otp
 * row (phone number + one-time code, PDPL personal data) ever inserted
 * has stayed in the table indefinitely, even though each code is only
 * useful for a few minutes past its expires_at.
 *
 * Deletes sms_otp rows where created_at < now() - 30 days. Batched via
 * repeated SELECT-then-DELETE-by-id rounds (Postgres DELETE has no
 * native LIMIT; supabase-js's .limit() only applies to selects) so a
 * large first-run backlog doesn't hold one giant statement. A tick stops
 * once it either drains the backlog or hits MAX_BATCHES_PER_TICK —
 * whichever first — and leaves any remainder for tomorrow's tick (same
 * oldest-agnostic filter re-picks whatever's left; nothing is skipped).
 *
 * Follows the same registration/structure pattern as the other crons in
 * this directory (see paymentOrphanSweep.ts): cross-replica claim via
 * tryClaimCronTick, runWithHeartbeat wrapping the actual work, audit_log
 * row on completion, startXCron() export wired up in index.ts.
 */
import { createClient } from '@supabase/supabase-js';
import { runWithHeartbeat } from '../utils/cronHeartbeat';
import { captureError } from '../utils/sentryContext';
import { writeAudit } from '../utils/auditLog';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
// Policy: "OTP logs kept 30 days".
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 500; // rows per select/delete round-trip
// Safety cap so a huge one-time backlog (first run after this cron
// ships) can't hold the process in a multi-hour loop — 50 * 500 =
// 25,000 rows/tick ceiling; anything beyond that waits for tomorrow.
const MAX_BATCHES_PER_TICK = 50;
const CRON_LOCK_TTL_SECONDS = 10 * 60;

export type OtpPurgeResult = { deleted: number; batches: number; cappedOut: boolean };

/**
 * Core purge loop, admin injected so it's unit-testable without the
 * module-level supabase client. Deletes sms_otp rows older than
 * cutoffIso, BATCH_LIMIT (or batchLimit) rows at a time, stopping after
 * maxBatches rounds even if rows remain.
 */
export async function purgeOtpsOlderThan(
  admin: NonNullable<typeof supabaseAdmin>,
  cutoffIso: string,
  opts: { batchLimit?: number; maxBatches?: number } = {},
): Promise<OtpPurgeResult> {
  const batchLimit = opts.batchLimit ?? BATCH_LIMIT;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_TICK;

  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const { data: rows, error: selectError } = await admin
      .from('sms_otp')
      .select('id')
      .lt('created_at', cutoffIso)
      .limit(batchLimit);
    if (selectError) {
      console.warn('[otpPurge] select failed:', selectError.message);
      captureError(new Error(`otpPurge select failed: ${selectError.message}`), {
        component: 'cron.otpPurge.select',
      });
      break;
    }
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) break;
    batches += 1;

    const { error: deleteError } = await admin.from('sms_otp').delete().in('id', ids);
    if (deleteError) {
      console.warn('[otpPurge] delete failed:', deleteError.message);
      captureError(new Error(`otpPurge delete failed: ${deleteError.message}`), {
        component: 'cron.otpPurge.delete',
      });
      break;
    }
    deleted += ids.length;
    if (ids.length < batchLimit) break; // final (partial) page — backlog drained
  }

  const cappedOut = batches >= maxBatches;
  if (cappedOut) {
    console.warn(
      `[otpPurge] hit ${maxBatches}-batch cap this tick (${deleted} rows deleted) — remaining backlog deferred to next run`,
    );
  }
  return { deleted, batches, cappedOut };
}

async function runPurge(): Promise<OtpPurgeResult> {
  if (!supabaseAdmin) return { deleted: 0, batches: 0, cappedOut: false };
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  return purgeOtpsOlderThan(supabaseAdmin, cutoff);
}

let tickInFlight = false;

async function tick() {
  if (!supabaseAdmin) return;
  if (tickInFlight) {
    console.warn('[otpPurge] previous tick still running — skipping this interval');
    return;
  }
  tickInFlight = true;
  try {
    const { tryClaimCronTick } = await import('../utils/cronLock');
    if (!(await tryClaimCronTick('otpPurge', CRON_LOCK_TTL_SECONDS))) {
      console.log('[otpPurge] tick claimed by another replica — skipping');
      return;
    }
    await runWithHeartbeat('otpPurge', async () => {
      const result = await runPurge();
      if (result.deleted > 0) {
        console.log('[otpPurge] tick summary', result);
        await writeAudit({
          merchant_id: null,
          action: 'otp.purged',
          payload: result,
        });
      }
      return result;
    });
  } catch (err: any) {
    console.warn('[otpPurge] tick error (heartbeat captured):', err?.message);
  } finally {
    tickInFlight = false;
  }
}

export function startOtpPurgeCron() {
  if (!supabaseAdmin) {
    console.warn('[otpPurge] supabase not configured — cron disabled.');
    return;
  }
  // First run 90s after startup (after the DB warms up), then daily.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, 90 * 1000);
}
