/**
 * Loyalty expiration cron – runs daily:
 * 1. Expires loyalty points past their expires_at date
 * 2. Cleans up retired loyalty programs past their grace period
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const BATCH_LIMIT = 200;

async function sendPush(customerId: string, title: string, body: string) {
  if (!supabaseAdmin) return;
  try {
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('expo_push_token')
      .eq('user_id', customerId);
    const tokens = (subs ?? []).map((s: any) => s.expo_push_token).filter(Boolean);
    if (tokens.length === 0) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(tokens.map((t: string) => ({
        to: t, sound: 'default', title, body, channelId: 'loyalty',
      }))),
    });
  } catch { /* best-effort */ }
}

// ── 1. Expire stale loyalty points ──

async function expireStalePoints() {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();

  const { data: expiredTxns, error } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, customer_id, merchant_id, points')
    .eq('type', 'earn')
    .eq('expired', false)
    .not('expires_at', 'is', null)
    .lt('expires_at', now)
    .limit(BATCH_LIMIT);

  if (error || !expiredTxns?.length) {
    if (error) console.warn('[Loyalty Cron] Expiry query failed:', error.message);
    return;
  }

  console.log(`[Loyalty Cron] Found ${expiredTxns.length} expired transactions to process`);

  // Group by customer+merchant
  const grouped = new Map<string, { customerId: string; merchantId: string; totalPoints: number; txnIds: string[] }>();
  for (const txn of expiredTxns) {
    const key = `${txn.customer_id}:${txn.merchant_id}`;
    const existing = grouped.get(key) ?? { customerId: txn.customer_id, merchantId: txn.merchant_id, totalPoints: 0, txnIds: [] };
    existing.totalPoints += txn.points;
    existing.txnIds.push(txn.id);
    grouped.set(key, existing);
  }

  const groups = Array.from(grouped.values());
  for (const group of groups) {
    // Mark transactions as expired
    await supabaseAdmin
      .from('loyalty_transactions')
      .update({ expired: true })
      .in('id', group.txnIds);

    // Subtract from balance (floor at 0)
    const { data: balance } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', group.customerId)
      .eq('merchant_id', group.merchantId)
      .single();

    if (balance) {
      const newPoints = Math.max(0, balance.points - group.totalPoints);
      await supabaseAdmin
        .from('loyalty_points')
        .update({ points: newPoints, updated_at: now })
        .eq('customer_id', group.customerId)
        .eq('merchant_id', group.merchantId);
    }

    // Record expiration transaction for audit trail
    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: group.customerId,
      merchant_id: group.merchantId,
      type: 'expire',
      points: -group.totalPoints,
      description: `${group.totalPoints} points expired`,
      source: 'system',
    });

    sendPush(group.customerId, 'Points Expired', `${group.totalPoints} loyalty points have expired.`);
    console.log(`[Loyalty Cron] Expired ${group.totalPoints} points for customer ${group.customerId}`);
  }
}

// ── 2. Clean up retired loyalty programs past grace period ──

async function cleanupRetiredPrograms() {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();

  const { data: expiredPrograms } = await supabaseAdmin
    .from('loyalty_programs')
    .select('id, merchant_id')
    .eq('status', 'retiring')
    .lt('grace_period_end', now)
    .limit(20);

  if (!expiredPrograms?.length) return;

  console.log(`[Loyalty Cron] Found ${expiredPrograms.length} retired programs to clean up`);

  for (const program of expiredPrograms) {
    // Mark program as fully retired
    await supabaseAdmin
      .from('loyalty_programs')
      .update({ status: 'retired', retired_at: now })
      .eq('id', program.id);

    // Zero out remaining balances for this program
    await supabaseAdmin
      .from('loyalty_points')
      .update({ points: 0, updated_at: now })
      .eq('program_id', program.id);

    console.log(`[Loyalty Cron] Retired program ${program.id} for merchant ${program.merchant_id}`);
  }
}

// ── 3. Warn customers about upcoming point expiration (7-day advance) ──

async function warnUpcomingExpiry() {
  if (!supabaseAdmin) return;

  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: soonExpiring, error } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, customer_id, merchant_id, points, expires_at')
    .eq('type', 'earn')
    .eq('expired', false)
    .eq('expiry_warned', false)
    .not('expires_at', 'is', null)
    .gt('expires_at', now.toISOString())
    .lt('expires_at', sevenDaysOut)
    .limit(BATCH_LIMIT);

  if (error || !soonExpiring?.length) {
    if (error) console.warn('[Loyalty Cron] Expiry warning query failed:', error.message);
    return;
  }

  console.log(`[Loyalty Cron] Found ${soonExpiring.length} transactions to warn about expiry`);

  // Group by customer+merchant
  const grouped = new Map<string, { customerId: string; merchantId: string; totalPoints: number; txnIds: string[]; daysLeft: number }>();
  for (const txn of soonExpiring) {
    const key = `${txn.customer_id}:${txn.merchant_id}`;
    const daysLeft = Math.ceil((new Date(txn.expires_at).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const existing = grouped.get(key) ?? { customerId: txn.customer_id, merchantId: txn.merchant_id, totalPoints: 0, txnIds: [], daysLeft };
    existing.totalPoints += txn.points;
    existing.txnIds.push(txn.id);
    existing.daysLeft = Math.min(existing.daysLeft, daysLeft);
    grouped.set(key, existing);
  }

  const groups = Array.from(grouped.values());
  for (const group of groups) {
    // Mark as warned
    await supabaseAdmin
      .from('loyalty_transactions')
      .update({ expiry_warned: true })
      .in('id', group.txnIds);

    sendPush(
      group.customerId,
      'Points Expiring Soon',
      `You have ${group.totalPoints} points expiring in ${group.daysLeft} day${group.daysLeft === 1 ? '' : 's'}. Use them before they expire!`,
    );
  }
}

// ── Startup ──

export function startLoyaltyExpirationCron() {
  console.log('[Cron] Loyalty expiration cron started (daily)');
  setInterval(async () => {
    await warnUpcomingExpiry();
    await expireStalePoints();
    await cleanupRetiredPrograms();
  }, POLL_INTERVAL_MS);
  // First run 30s after startup
  setTimeout(async () => {
    await warnUpcomingExpiry();
    await expireStalePoints();
    await cleanupRetiredPrograms();
  }, 30_000);
}
