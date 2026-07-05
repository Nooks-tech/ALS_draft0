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
 * FAIL-OPEN by design: if the RPC is missing (migration lag) or the DB
 * errors, we run the tick anyway — that's exactly today's single-replica
 * behavior, and a broken lock layer must never silently stop billing/
 * expiry/carts. The failure is logged loudly so it gets fixed.
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
      console.warn(`[cronLock] claim RPC failed for ${name} — running unlocked:`, error.message);
      return true;
    }
    return Boolean(data);
  } catch (err: any) {
    console.warn(`[cronLock] claim threw for ${name} — running unlocked:`, err?.message);
    return true;
  }
}
