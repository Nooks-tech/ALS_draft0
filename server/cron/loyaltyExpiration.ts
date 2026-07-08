/**
 * Loyalty expiration cron – runs daily:
 * 1. Expires loyalty points past their expires_at date
 * 2. Cleans up retired loyalty programs past their grace period
 */
import { createClient } from '@supabase/supabase-js';
import { sendPushScoped } from '../utils/push';
import { captureError } from '../utils/sentryContext';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const BATCH_LIMIT = 200;
// Each expire/warn task loops batches until drained. Runs on a persistent
// Railway worker (no serverless timeout), so the only cap is a runaway
// backstop — normal termination is "batch shorter than BATCH_LIMIT".
// Without the loop the whole PLATFORM was capped at 200 expirations/day.
const MAX_BATCHES_PER_TICK = 1000;

function sendPush(customerId: string, merchantId: string, title: string, body: string) {
  return sendPushScoped({ customerId, merchantId, title, body, channel: 'loyalty' });
}

// ── 1. Expire stale loyalty points ──

async function expireStalePoints() {
  if (!supabaseAdmin) return;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
  const now = new Date().toISOString();

  const { data: expiredTxns, error } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, customer_id, merchant_id, points, loyalty_type')
    .eq('type', 'earn')
    .eq('expired', false)
    // Cashback earns are expired by expireStaleCashback (which decrements the
    // SAR balance). Processing them here marked them expired=true first, which
    // starved that pass — expired cashback stayed spendable forever. NULL-safe
    // (legacy rows have loyalty_type = NULL).
    .or('loyalty_type.is.null,loyalty_type.neq.cashback')
    .not('expires_at', 'is', null)
    .lt('expires_at', now)
    .limit(BATCH_LIMIT);

  if (error || !expiredTxns?.length) {
    if (error) console.warn('[Loyalty Cron] Expiry query failed:', error.message);
    return;
  }

  console.log(`[Loyalty Cron] Found ${expiredTxns.length} expired transactions to process`);

  // Group by customer+merchant
  type PointsGroup = { customerId: string; merchantId: string; totalPoints: number; txnIds: string[] };
  const grouped = new Map<string, PointsGroup>();
  for (const txn of expiredTxns as Array<{ id: string; customer_id: string; merchant_id: string; points: number; loyalty_type?: string }>) {
    const key = `${txn.customer_id}:${txn.merchant_id}`;
    const existing: PointsGroup = grouped.get(key) ?? { customerId: txn.customer_id, merchantId: txn.merchant_id, totalPoints: 0, txnIds: [] };
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

    sendPush(group.customerId, group.merchantId, 'Points Expired', `${group.totalPoints} loyalty points have expired.`);
    console.log(`[Loyalty Cron] Expired ${group.totalPoints} points for customer ${group.customerId}`);
  }

  if (expiredTxns.length < BATCH_LIMIT) break; // drained
  }
}

// ── 1b. Expire stale cashback balances ──

async function expireStaleCashback() {
  if (!supabaseAdmin) return;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
  // Find cashback transactions that have expired
  const now = new Date().toISOString();
  const { data: expiredCbTxns, error } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, customer_id, merchant_id, amount_sar')
    .eq('type', 'earn')
    .eq('loyalty_type', 'cashback')
    .eq('expired', false)
    .not('expires_at', 'is', null)
    .lt('expires_at', now)
    .limit(BATCH_LIMIT);

  if (error || !expiredCbTxns?.length) return;

  console.log(`[Loyalty Cron] Found ${expiredCbTxns.length} expired cashback transactions`);

  type CashbackGroup = { customerId: string; merchantId: string; totalSar: number; txnIds: string[] };
  const grouped = new Map<string, CashbackGroup>();
  for (const txn of expiredCbTxns as Array<{ id: string; customer_id: string; merchant_id: string; amount_sar?: number }>) {
    const key = `${txn.customer_id}:${txn.merchant_id}`;
    const existing: CashbackGroup = grouped.get(key) ?? { customerId: txn.customer_id, merchantId: txn.merchant_id, totalSar: 0, txnIds: [] };
    existing.totalSar += Math.abs(txn.amount_sar ?? 0);
    existing.txnIds.push(txn.id);
    grouped.set(key, existing);
  }

  for (const group of grouped.values()) {
    await supabaseAdmin.from('loyalty_transactions').update({ expired: true }).in('id', group.txnIds);

    // Subtract from cashback balance
    const { data: bal } = await supabaseAdmin.from('loyalty_cashback_balances')
      .select('balance_sar, config_version')
      .eq('customer_id', group.customerId).eq('merchant_id', group.merchantId)
      .order('config_version', { ascending: false }).limit(1).maybeSingle();

    if (bal) {
      await supabaseAdmin.from('loyalty_cashback_balances')
        .update({ balance_sar: Math.max(0, +(bal.balance_sar - group.totalSar).toFixed(2)), updated_at: now })
        .eq('customer_id', group.customerId).eq('merchant_id', group.merchantId).eq('config_version', bal.config_version);
    }

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: group.customerId, merchant_id: group.merchantId,
      type: 'expire', loyalty_type: 'cashback', amount_sar: -group.totalSar,
      points: 0, description: `${group.totalSar.toFixed(2)} SAR cashback expired`, source: 'system',
    });

    sendPush(group.customerId, group.merchantId, 'Cashback Expired', `${group.totalSar.toFixed(2)} SAR cashback has expired.`);
  }

  if (expiredCbTxns.length < BATCH_LIMIT) break; // drained
  }
}

// Stamp-specific expiration removed in Phase 1 — the underlying
// loyalty_stamps table is dropped. Points-mode expiry is covered by
// expireStalePoints above (which reads from loyalty_points). Phase 2
// will revisit whether points need any extra notification copy
// beyond the existing "Points Expired" push.

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

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: soonExpiring, error } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, customer_id, merchant_id, points, expires_at, loyalty_type')
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
  type WarnGroup = { customerId: string; merchantId: string; totalPoints: number; txnIds: string[]; daysLeft: number };
  const grouped = new Map<string, WarnGroup>();
  for (const txn of soonExpiring as Array<{ id: string; customer_id: string; merchant_id: string; points: number; expires_at: string; loyalty_type?: string }>) {
    const key = `${txn.customer_id}:${txn.merchant_id}`;
    const daysLeft = Math.ceil((new Date(txn.expires_at).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const existing: WarnGroup = grouped.get(key) ?? { customerId: txn.customer_id, merchantId: txn.merchant_id, totalPoints: 0, txnIds: [], daysLeft };
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

    // Type-aware warning push
    const txnType = (soonExpiring.find(t => t.customer_id === group.customerId) as any)?.loyalty_type;
    const days = `${group.daysLeft} day${group.daysLeft === 1 ? '' : 's'}`;
    if (txnType === 'cashback') {
      const sarValue = (group.totalPoints * 0.1).toFixed(2);
      sendPush(group.customerId, group.merchantId, 'Cashback Expiring Soon', `You have ${sarValue} SAR cashback expiring in ${days}. Use it before it expires!`);
    } else {
      sendPush(group.customerId, group.merchantId, 'Points Expiring Soon', `You have ${group.totalPoints} points expiring in ${days}. Use them before they expire!`);
    }
  }

  if (soonExpiring.length < BATCH_LIMIT) break; // drained
  }
}

// ── Retention: prune the cron_runs heartbeat log ──
// cron_runs is the highest-row table (heartbeats from every cron tick) and
// was never pruned. This daily cron is the natural place to trim it — one
// delete per day keeps ~30 days of history for the /ready health checks.
const CRON_RUNS_RETENTION_DAYS = 30;

async function pruneOldCronRuns() {
  if (!supabaseAdmin) return;
  const cutoff = new Date(Date.now() - CRON_RUNS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.from('cron_runs').delete().lt('started_at', cutoff);
  if (error) console.warn('[Loyalty Cron] cron_runs prune failed:', error.message);
}

// ── Retention: the other unbounded append-only tables (audit H7) ──
// audit_log grows 5-10 rows per order (relay steps, webhooks, telemetry,
// rate-limit hits) ≈ 2-3.5M rows/yr per 1,000 orders/day; webhook_events
// gets one row per Moyasar/Foodics/OTO event and its own header comment
// promised a pruner that was never written; abandoned_carts is insert-only.
// Financial / reconciliation trails are exempt from the audit_log prune —
// recovery stamping looks back 24h and reports read one month, so 60d is
// generous for everything else (M10: was 180d, shrunk to keep the table lean).
async function pruneRetention() {
  if (!supabaseAdmin) return;
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  const { error: whErr } = await supabaseAdmin
    .from('webhook_events')
    .delete()
    .lt('processed_at', daysAgo(30));
  if (whErr) console.warn('[Loyalty Cron] webhook_events prune failed:', whErr.message);

  const { error: alErr } = await supabaseAdmin
    .from('audit_log')
    .delete()
    .lt('created_at', daysAgo(60))
    .not('action', 'ilike', 'commission%')
    .not('action', 'ilike', '%invoiced%')
    .not('action', 'ilike', '%reversal%')
    .not('action', 'ilike', '%refund%')
    .not('action', 'ilike', 'wallet%');
  if (alErr) console.warn('[Loyalty Cron] audit_log prune failed:', alErr.message);

  // M5: unclaimed walk-in (kiosk) orders. The kiosk writes customer_orders
  // rows with a claim window (claim_expires_at); if the customer never
  // claims them the rows are dead weight forever. 48h past expiry they can
  // no longer be claimed — delete them. Claimed rows (claimed_at set) and
  // app orders (claim_expires_at NULL, so .lt never matches) are untouched.
  const { error: woErr } = await supabaseAdmin
    .from('customer_orders')
    .delete()
    .is('claimed_at', null)
    .lt('claim_expires_at', daysAgo(2));
  if (woErr) console.warn('[Loyalty Cron] unclaimed walk-in orders prune failed:', woErr.message);

  const { error: acErr } = await supabaseAdmin
    .from('abandoned_carts')
    .delete()
    .lt('abandoned_at', daysAgo(180));
  if (acErr) console.warn('[Loyalty Cron] abandoned_carts prune failed:', acErr.message);
}

// ── Startup ──

// L11: nightly wallet balance-vs-ledger reconciliation alert. Catches a
// balance that diverged from SUM(customer_wallet_transactions.amount_halalas)
// — i.e. a direct balance write that bypassed credit_/debit_customer_wallet
// (like the phantom test grant reconciled 2026-07-08). Wallet is the one
// balance with no expiry, so its ledger sum is exact — no false positives.
// (Points/cashback reconciliation needs expiry-aware logic — separate follow-up.)
async function reconcileWalletBalances() {
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin.rpc('wallet_balance_mismatches');
  if (error) {
    console.warn('[Loyalty Cron] wallet reconciliation query failed:', error.message);
    captureError(new Error(`wallet_balance_mismatches rpc failed: ${error.message}`), {
      component: 'cron.reconcileWalletBalances',
    });
    return;
  }
  const mismatches = (data ?? []) as Array<{
    customer_id: string;
    merchant_id: string;
    balance_halalas: number;
    ledger_halalas: number;
  }>;
  if (mismatches.length === 0) return;
  console.error(`[Loyalty Cron] ALERT — ${mismatches.length} wallet balance(s) diverge from their ledger:`, mismatches);
  captureError(
    new Error(`Wallet balance/ledger reconciliation found ${mismatches.length} mismatch(es)`),
    { component: 'cron.reconcileWalletBalances', extra: { mismatches } },
  );
}

async function runLoyaltyTick() {
  // Each task is wrapped independently so one failure doesn't skip the
  // rest. Top-level try/catch is for paranoia — anything that escapes
  // the inner try/catches (e.g. an unhandled promise inside a task)
  // would otherwise kill the cron worker process via unhandledRejection.
  const tasks: Array<[string, () => Promise<void>]> = [
    ['warnUpcomingExpiry', warnUpcomingExpiry],
    ['expireStalePoints', expireStalePoints],
    ['expireStaleCashback', expireStaleCashback],
    ['cleanupRetiredPrograms', cleanupRetiredPrograms],
    ['pruneOldCronRuns', pruneOldCronRuns],
    ['pruneRetention', pruneRetention],
    ['reconcileWalletBalances', reconcileWalletBalances],
  ];
  for (const [name, task] of tasks) {
    try {
      await task();
    } catch (err: unknown) {
      console.error(`[Loyalty Cron] ${name} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

async function heartbeatTick() {
  // Imported here (not at top) to avoid a circular-import risk —
  // cronHeartbeat itself doesn't depend on this module.
  const { tryClaimCronTick } = await import('../utils/cronLock');
  // TTL 23h (< the 24h interval so cadence is unaffected). The tick's
  // balance math is read-modify-write, so a second replica running it
  // concurrently would double-deduct — this claim is the guard.
  if (!(await tryClaimCronTick('loyaltyExpiration', 23 * 60 * 60))) {
    console.log('[Loyalty Cron] tick claimed by another replica — skipping');
    return;
  }
  const { runWithHeartbeat } = await import('../utils/cronHeartbeat');
  await runWithHeartbeat('loyaltyExpiration', runLoyaltyTick);
}

export function startLoyaltyExpirationCron() {
  console.log('[Cron] Loyalty expiration cron started (daily)');
  setInterval(() => {
    heartbeatTick().catch((err) =>
      console.error('[Loyalty Cron] heartbeatTick rejected (heartbeat captured):', err?.message),
    );
  }, POLL_INTERVAL_MS);
  // First run 30s after startup
  setTimeout(() => {
    heartbeatTick().catch((err) =>
      console.error('[Loyalty Cron] startup heartbeatTick rejected:', err?.message),
    );
  }, 30_000);
}
