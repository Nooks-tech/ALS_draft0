/**
 * Distributed cron-tick claim (scalability audit H2, 2026-07-05).
 *
 * All ALS crons are in-process setIntervals — with 2+ Railway replicas
 * every replica fires every cron, and non-atomic ticks (loyalty
 * expiration's read-modify-write balance math, cart pushes) double-run.
 * Each tick now claims `cron_locks` via the try_claim_cron RPC before
 * doing work; only the claim winner proceeds.
 *
 * TTL guidance: >= the tick's worst-case duration, <= the cron interval.
 * An expired TTL lets the next tick claim, so a crashed holder never
 * wedges the cron for longer than one TTL.
 *
 * FAIL-CLOSED on lock error (DB-4, 2026-07-10): if the claim RPC errors or
 * throws (DB slowdown, transient outage), we SKIP this tick rather than run
 * unlocked. A fail-open lock lets 2+ replicas overlap during exactly the DB
 * stress that produces the error, and the non-money ticks (loyalty
 * expiration's read-modify-write balance math, cart pushes) are not all
 * idempotency-protected, so an overlap can double-run them. Skipping is safe:
 * every cron re-runs on its next interval, so a skipped tick self-heals within
 * one cycle. The failure is logged loudly so a persistently-broken lock layer
 * (e.g. the RPC actually missing) surfaces and gets fixed.
 *
 * NOTE: an unconfigured lock layer (no service key → supabaseAdmin null) still
 * returns true — there is no DB to claim against, and in that state the crons
 * themselves no-op, so it is not a lock *error*.
 */
import { createClient } from '@supabase/supabase-js';
import os from 'os';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const HOLDER = `${os.hostname()}:${process.pid}`;

export async function tryClaimCronTick(name: string, ttlSeconds: number): Promise<boolean> {
  if (!supabaseAdmin) return true;
  try {
    const { data, error } = await supabaseAdmin.rpc('try_claim_cron', {
      p_name: name,
      p_ttl_seconds: ttlSeconds,
      p_holder: HOLDER,
    });
    if (error) {
      console.warn(`[cronLock] claim RPC failed for ${name} — skipping tick (fail-closed):`, error.message);
      return false;
    }
    return Boolean(data);
  } catch (err: any) {
    console.warn(`[cronLock] claim threw for ${name} — skipping tick (fail-closed):`, err?.message);
    return false;
  }
}
