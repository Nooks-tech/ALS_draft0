/**
 * Payment-processing health cron — runs every 30 minutes.
 *
 * What it catches: an order that's been Delivered or Cancelled for
 * more than an hour, has a Moyasar payment_id, but whose
 * commission_status is still null or 'pending'. The Moyasar webhook
 * is supposed to flip that to 'earned' the moment it lands (success
 * OR failure both accrue the 1 SAR fee). If a webhook fails / never
 * arrives / is dropped by a network blip, the order silently slips
 * out of the payment-processing tally and the platform loses 1 SAR
 * of revenue per orphan.
 *
 * Symptom the user reported on 2026-05-22 (mofosos test merchant):
 * "an order that was completed and the payment processing did not
 * update" — exactly this case. There was no signal anywhere; the
 * merchant noticed by eyeballing the dashboard tile.
 *
 * What this cron emits per detected orphan:
 *   - console.error with merchantId / orderId / paymentId / status
 *   - Sentry.captureException tagged with merchant_id + order_id
 *   - audit_log row, action = 'payment_processing.stuck_order_detected'
 *
 * What we DO NOT do here: automatically retry the Moyasar webhook
 * accrual. That's a separate operational decision — the
 * /api/orders/internal/reconcile-payment-processing endpoint (to be
 * built) can do the catch-up safely with merchant scoping. For now,
 * surfacing the problem is the win.
 */

import { createClient } from '@supabase/supabase-js';
import { runWithHeartbeat } from '../utils/cronHeartbeat';
import { captureError } from '../utils/sentryContext';
import { writeAudit } from '../utils/auditLog';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const STUCK_AFTER_MS = 60 * 60 * 1000; // 1 hour grace for the Moyasar webhook
const BATCH_LIMIT = 500;

type StuckOrderRow = {
  id: string;
  merchant_id: string | null;
  customer_id: string | null;
  status: string | null;
  payment_id: string | null;
  total_sar: number | null;
  commission_status: string | null;
  commission_amount: number | null;
  created_at: string;
  updated_at: string | null;
};

// Orders already alerted on (see dedupe note inside runScan).
const alertedOrderIds = new Set<string>();

async function runScan(): Promise<{ stuckCount: number; merchantsAffected: number }> {
  if (!supabaseAdmin) return { stuckCount: 0, merchantsAffected: 0 };

  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

  // status IN (Delivered, Cancelled), commission_status in (null, pending),
  // has a real Moyasar payment_id (skip wallet: / reward: synthetic ids),
  // old enough that the webhook should have landed by now.
  const { data, error } = await supabaseAdmin
    .from('customer_orders')
    .select('id, merchant_id, customer_id, status, payment_id, total_sar, commission_status, commission_amount, created_at, updated_at')
    .in('status', ['Delivered', 'Cancelled'])
    .or('commission_status.is.null,commission_status.eq.pending')
    .not('payment_id', 'is', null)
    .lt('created_at', cutoff)
    .limit(BATCH_LIMIT);

  if (error) {
    console.warn('[paymentProcessingHealth] scan query failed:', error.message);
    captureError(new Error(`paymentProcessingHealth scan failed: ${error.message}`), {
      component: 'cron.paymentProcessingHealth.scan',
    });
    return { stuckCount: 0, merchantsAffected: 0 };
  }

  const rows = (data ?? []) as StuckOrderRow[];
  // Filter out the synthetic payment_id prefixes that don't go through
  // Moyasar — the webhook never fires for those, so commission_status
  // stuck on null is expected, not a bug.
  const stuck = rows.filter((r) => {
    const pid = (r.payment_id ?? '').trim();
    if (!pid) return false;
    if (pid.startsWith('wallet:')) return false;
    if (pid.startsWith('reward:')) return false;
    return true;
  });

  if (stuck.length === 0) {
    alertedOrderIds.clear();
    return { stuckCount: 0, merchantsAffected: 0 };
  }

  // Only alert on orders we haven't already reported. A permanently-stuck
  // order used to re-fire the log + Sentry + one audit row per merchant
  // EVERY 30 minutes forever — 48 audit rows/day per stuck order feeding
  // the unbounded audit_log. In-memory is fine: a restart re-alerting
  // once is acceptable, and the cron-lock keeps this single-runner.
  const newlyStuck = stuck.filter((o) => !alertedOrderIds.has(o.id));
  for (const o of newlyStuck) alertedOrderIds.add(o.id);
  // Forget orders that resolved so a relapse re-alerts.
  const currentIds = new Set(stuck.map((o) => o.id));
  for (const id of alertedOrderIds) {
    if (!currentIds.has(id)) alertedOrderIds.delete(id);
  }
  if (newlyStuck.length === 0) {
    return { stuckCount: stuck.length, merchantsAffected: 0 };
  }

  const byMerchant = new Map<string, number>();
  for (const o of newlyStuck) {
    if (o.merchant_id) byMerchant.set(o.merchant_id, (byMerchant.get(o.merchant_id) ?? 0) + 1);
  }

  // Loud log line for Railway — one summary plus details.
  console.error(
    `[paymentProcessingHealth] ⚠️  ${newlyStuck.length} NEW stuck orders (${stuck.length} total outstanding) across ${byMerchant.size} merchant(s) — Moyasar webhook never accrued the platform fee.`,
    {
      sampleIds: newlyStuck.slice(0, 5).map((o) => ({
        order_id: o.id,
        merchant_id: o.merchant_id,
        status: o.status,
        payment_id: o.payment_id,
        commission_status: o.commission_status,
        age_minutes: Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000),
      })),
    },
  );

  // Sentry: one captureException for the batch (groups together) +
  // per-merchant tags so the issue page is filterable. Per-order
  // captures would flood Sentry on a wide outage.
  captureError(
    new Error(`payment-processing-stuck: ${newlyStuck.length} new orphan orders`),
    {
      component: 'cron.paymentProcessingHealth',
      extra: {
        new_stuck_count: newlyStuck.length,
        total_outstanding: stuck.length,
        merchants_affected: byMerchant.size,
        sample_orders: newlyStuck.slice(0, 10).map((o) => o.id),
      },
    },
  );

  // Audit_log: one row per merchant (not per order) so we don't
  // explode the audit table on wide outages. The merchant's
  // dashboard widget can show the count from this row.
  for (const [merchantId, count] of byMerchant.entries()) {
    void writeAudit({
      merchant_id: merchantId,
      action: 'payment_processing.stuck_orders_detected',
      payload: {
        stuck_count: count,
        scan_cutoff: cutoff,
        sample_order_ids: newlyStuck
          .filter((o) => o.merchant_id === merchantId)
          .slice(0, 10)
          .map((o) => o.id),
      },
    });
  }

  return { stuckCount: stuck.length, merchantsAffected: byMerchant.size };
}

/**
 * Public health summary for the /ready endpoint and the dashboard
 * widget. Returns the most recent stuck-order count across all
 * merchants. Different from runScan in that it doesn't write audit
 * or trigger Sentry — just reports.
 */
export async function getPaymentProcessingHealth(): Promise<{
  ok: boolean;
  stuckCount: number;
  cutoffAgoHours: number;
  reason: string | null;
}> {
  if (!supabaseAdmin) {
    return { ok: false, stuckCount: 0, cutoffAgoHours: 1, reason: 'db-unconfigured' };
  }
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const { count, error } = await supabaseAdmin
    .from('customer_orders')
    .select('id', { head: true, count: 'exact' })
    .in('status', ['Delivered', 'Cancelled'])
    .or('commission_status.is.null,commission_status.eq.pending')
    .not('payment_id', 'is', null)
    .lt('created_at', cutoff);
  if (error) {
    return { ok: false, stuckCount: 0, cutoffAgoHours: 1, reason: `query-error: ${error.message}` };
  }
  const stuckCount = count ?? 0;
  return {
    ok: stuckCount === 0,
    stuckCount,
    cutoffAgoHours: 1,
    reason: stuckCount > 0 ? `${stuckCount} orders awaiting webhook accrual` : null,
  };
}

async function tick() {
  if (!supabaseAdmin) return;
  try {
    const { tryClaimCronTick } = await import('../utils/cronLock');
    if (!(await tryClaimCronTick('paymentProcessingHealth', 25 * 60))) {
      console.log('[paymentProcessingHealth] tick claimed by another replica — skipping');
      return;
    }
    await runWithHeartbeat('paymentProcessingHealth', runScan);
  } catch (err: any) {
    console.warn('[paymentProcessingHealth] tick error (heartbeat captured):', err?.message);
  }
}

export function startPaymentProcessingHealthCron() {
  if (!supabaseAdmin) {
    console.warn('[paymentProcessingHealth] supabase not configured — cron disabled.');
    return;
  }
  // First run 2 min after startup so DB connections are warm and the
  // boot logs aren't drowned in scan output. Then every 30 min.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, 2 * 60 * 1000);
}
