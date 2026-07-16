/**
 * Foodics order-status sync cron — runs every 60s.
 *
 * WHY (2026-07-15): the customer app's order list is refreshed by a 30s
 * foreground poll that reads customer_orders DIRECTLY from Supabase
 * (src/api/orders.ts::fetchOrdersForCustomer) — it never calls an ALS REST
 * endpoint, so the /api/orders/:id/status read-through can't drive it. And the
 * Foodics webhook never lands (registration blocked by Foodics perms + Phase A
 * quarantines unsigned deliveries). Net effect: a cashier tapping Accept/Close
 * was invisible in the app until the unrelated no-accept sweep happened to run
 * (~5-10 min later), and only for orders inside its window.
 *
 * This cron closes that gap: it periodically reads the real Foodics status for
 * recent, confirmed, non-terminal, Foodics-relayed orders and writes it to
 * customer_orders (via the nooksweb credentialed read-back). The app's
 * direct-Supabase poll then shows the fresh status within ~a minute — no app
 * change / OTA required.
 *
 * Bounding (scale): only orders that are payment-confirmed, have a
 * foodics_order_id, are in a non-terminal app status, and were created in the
 * last STATUS_WINDOW_MS. Active orders reach a terminal state well within that
 * window, so the working set stays tiny. TODO(scale): if this ever grows, batch
 * per-merchant via GET /orders (list) like the kiosk walk-in sync instead of
 * one read-back per order.
 */
import { createClient } from '@supabase/supabase-js';
import { runWithHeartbeat } from '../utils/cronHeartbeat';
import { readBackFoodicsStatusViaNooks } from '../utils/foodicsStatusReadback';
import { earnForOrder } from '../routes/loyalty';
import { netOfLoyaltyEarnBase } from '../utils/loyaltyEarnBase';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 60 * 1000; // every minute
const STATUS_WINDOW_MS = 3 * 60 * 60 * 1000; // only orders created in the last 3h
const BATCH_LIMIT = 100; // hard cap on Foodics read-backs per tick
// Wall-clock deadline for a single tick's read-back loop. Each read-back can
// take up to its own 8s AbortSignal.timeout, so a serial BATCH_LIMIT=100 loop
// has a worst case of ~800s — far past the 55s cron-lock TTL (see cronLock.ts).
// A tick that overruns its lock lets a second replica's tick claim the lock
// and start overlapping read-backs on the SAME rows mid-loop. The nooksweb-side
// compare-and-swap (lib/foodics-order-status-sync.ts) makes that overlap safe
// (only one call ever wins the write + push), but staying inside the TTL is
// cheap defense-in-depth: once the deadline passes, stop issuing NEW
// read-backs and leave the remainder for the next tick (same oldest-first
// query picks them straight back up — nothing is skipped, only deferred).
const PROCESS_DEADLINE_MS = 45 * 1000;

// Non-terminal app statuses worth refreshing. Delivered/Cancelled are terminal.
const NON_TERMINAL_STATUSES = ['Placed', 'Preparing', 'Ready', 'Out for delivery'];

type OrderRow = {
  id: string;
  merchant_id: string;
  foodics_order_id: string;
  status: string;
  customer_id: string | null;
  total_sar: number | null;
  wallet_paid_sar: number | null;
  cashback_paid_sar: number | null;
};

async function processBatch(): Promise<{ scanned: number; synced: number }> {
  if (!supabaseAdmin) return { scanned: 0, synced: 0 };
  const windowStart = new Date(Date.now() - STATUS_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('customer_orders')
    .select('id, merchant_id, foodics_order_id, status, customer_id, total_sar, wallet_paid_sar, cashback_paid_sar')
    .not('foodics_order_id', 'is', null)
    .not('payment_confirmed_at', 'is', null)
    .in('status', NON_TERMINAL_STATUSES)
    .gte('created_at', windowStart)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) {
    console.warn('[foodicsOrderStatusSync] select failed:', error.message);
    return { scanned: 0, synced: 0 };
  }
  const rows = (data ?? []) as OrderRow[];
  if (rows.length === 0) return { scanned: 0, synced: 0 };

  let synced = 0;
  const deadlineAt = Date.now() + PROCESS_DEADLINE_MS;
  let i = 0;
  for (; i < rows.length; i++) {
    if (Date.now() >= deadlineAt) {
      console.warn(
        `[foodicsOrderStatusSync] wall-clock deadline (${PROCESS_DEADLINE_MS}ms) reached — deferring ${rows.length - i} order(s) to next tick`,
      );
      break;
    }
    const row = rows[i];
    if (!row.merchant_id || !row.foodics_order_id) continue;
    const result = await readBackFoodicsStatusViaNooks({
      merchantId: String(row.merchant_id),
      internalOrderId: String(row.id),
      foodicsOrderId: String(row.foodics_order_id),
    });
    // A failed read is left for the next tick — never treated as a signal.
    if (result.ok && result.synced) {
      synced += 1;
      console.log('[foodicsOrderStatusSync] synced', {
        orderId: row.id,
        from: result.from,
        to: result.to,
      });
      // Loyalty earn on delivery. This cron is what actually drives orders to
      // Delivered now that the Foodics webhook is dead — the earn hooks on the
      // ALS status routes never see these transitions, so without firing here
      // NOTHING earns for cron-synced orders (found live 2026-07-16: every
      // Delivered order since this cron shipped on 07-15 earned zero, under
      // both points and cashback). The push side effect made the migration
      // from the webhook; the earn side effect did not. earnPoints/earnCashback
      // are idempotent per order (partial unique indexes + atomic RPCs), so a
      // double-fire against the route hooks is a safe no-op.
      if (result.to === 'Delivered' && row.customer_id && row.merchant_id) {
        try {
          const earn = await earnForOrder(
            row.customer_id,
            row.id,
            netOfLoyaltyEarnBase(row),
            row.merchant_id,
          );
          console.log('[foodicsOrderStatusSync] loyalty earn fired', {
            orderId: row.id,
            earnBase: netOfLoyaltyEarnBase(row),
            result: earn,
          });
        } catch (e: any) {
          console.warn('[foodicsOrderStatusSync] loyalty earn failed:', {
            orderId: row.id,
            error: e?.message,
          });
        }
      }
    }
  }
  return { scanned: rows.length, synced };
}

let tickInFlight = false;

async function tick() {
  if (!supabaseAdmin) return;
  if (tickInFlight) {
    console.warn('[foodicsOrderStatusSync] previous tick still running — skipping this interval');
    return;
  }
  tickInFlight = true;
  try {
    const { tryClaimCronTick } = await import('../utils/cronLock');
    if (!(await tryClaimCronTick('foodicsOrderStatusSync', 55))) {
      return;
    }
    await runWithHeartbeat('foodicsOrderStatusSync', async () => {
      const { scanned, synced } = await processBatch();
      if (synced > 0) {
        console.log(`[foodicsOrderStatusSync] tick — scanned=${scanned} synced=${synced}`);
      }
      return { scanned, synced };
    });
  } catch (err: any) {
    console.warn('[foodicsOrderStatusSync] tick error (heartbeat captured):', err?.message);
  } finally {
    tickInFlight = false;
  }
}

export function startFoodicsOrderStatusSyncCron() {
  if (!supabaseAdmin) {
    console.warn('[foodicsOrderStatusSync] supabase not configured — cron disabled.');
    return;
  }
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, POLL_INTERVAL_MS);
}
