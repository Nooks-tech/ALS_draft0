/**
 * Cart abandonment cron — runs every minute.
 *
 * Phase D of the per-merchant separation work moved the cart from
 * AsyncStorage to a server-side customer_carts table. With the cart
 * now persisted, the server can drive the abandonment flow instead
 * of relying on a device-local 1-hour notification:
 *
 *   updated_at < now() - 15min AND notified_at IS NULL
 *     → send a merchant-branded "Don't forget your cart 😉" push,
 *       stamp notified_at so it doesn't repeat.
 *
 *   updated_at < now() - 45min
 *     → move the row into abandoned_carts (recovered_at NULL),
 *       DELETE from customer_carts. (15 min notify window + 30 min
 *       grace after the nudge before the cart is wiped.)
 *
 *   On order commit, the matching abandoned_carts row (if any) gets
 *   recovered_at + recovered_order_id stamped so the dashboard can
 *   show recovery rate. That stamping is handled by orders.ts /commit,
 *   not this cron.
 *
 * Localization: the push uses the customer's per-merchant language
 * pref (customer_merchant_profiles.language → fallback to
 * push_subscriptions.app_language → English).
 *
 * Idempotency: notified_at is the lock against repeat pushes. The
 * trigger on customer_carts clears notified_at whenever items change,
 * so a customer who comes back, modifies the cart, then leaves again
 * gets a fresh notification window.
 */
import { createClient } from '@supabase/supabase-js';
import { sendLocalizedPushScoped } from '../utils/push';
import { runWithHeartbeat } from '../utils/cronHeartbeat';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 60 * 1000; // every minute
const NOTIFY_AFTER_MS = 15 * 60 * 1000; // 15 min idle → "don't forget your cart"
// 30 min AFTER the notification fires (so 45 min total cart idle) the
// row gets moved to abandoned_carts and the active cart cleared. This
// is the spec the founder set 2026-05-23 — gives the customer a
// reasonable window to come back after the nudge, but doesn't let
// stale carts sit indefinitely poisoning future opens.
const ABANDON_AFTER_MS = 45 * 60 * 1000;
const BATCH_LIMIT = 200;

type CartRow = {
  merchant_id: string;
  customer_id: string;
  items: unknown;
  subtotal_sar: number | null;
  branch_id: string | null;
  order_type: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
};

async function processNotifyBatch() {
  if (!supabaseAdmin) return 0;
  const cutoff = new Date(Date.now() - NOTIFY_AFTER_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('customer_carts')
    .select('merchant_id, customer_id, items, subtotal_sar, updated_at')
    .is('notified_at', null)
    .lt('updated_at', cutoff)
    .limit(BATCH_LIMIT);
  if (error) {
    console.warn('[cartAbandonment] notify select failed:', error.message);
    return 0;
  }
  if (!data || data.length === 0) return 0;

  let sent = 0;
  for (const row of data as Array<Pick<CartRow, 'merchant_id' | 'customer_id' | 'items' | 'subtotal_sar' | 'updated_at'>>) {
    const itemCount = Array.isArray(row.items) ? row.items.length : 0;
    if (itemCount === 0) {
      // Empty cart shouldn't exist (we DELETE on clear) but defend
      // anyway — no point notifying about nothing.
      await supabaseAdmin
        .from('customer_carts')
        .delete()
        .eq('merchant_id', row.merchant_id)
        .eq('customer_id', row.customer_id);
      continue;
    }

    try {
      await sendLocalizedPushScoped({
        customerId: row.customer_id,
        merchantId: row.merchant_id,
        channel: 'orders',
        // Single-line winky-face nudge — the founder's preferred copy
        // 2026-05-23. The detail about how many items / how to finish
        // ordering used to live on a second line but cluttered the
        // lockscreen; the title is now the whole message.
        copy: {
          en: {
            title: "Don't forget your cart 😉",
            body:
              itemCount === 1
                ? 'There’s still an item waiting. Tap to finish.'
                : `There are still ${itemCount} items waiting. Tap to finish.`,
          },
          ar: {
            title: 'لا تنسى سلتك 😉',
            body:
              itemCount === 1
                ? 'في منتج لسه ينتظرك. اضغط لإتمام الطلب.'
                : `في ${itemCount} منتجات لسه تنتظرك. اضغط لإتمام الطلب.`,
          },
        },
      });
    } catch (err: any) {
      // Phase E: enrich with (merchant, customer) so a sudden burst
      // of push failures on one merchant (= APNS cert expired, FCM
      // misconfigured) is queryable.
      console.warn('[cartAbandonment] push send failed', {
        merchantId: row.merchant_id,
        customerId: row.customer_id,
        itemCount,
        error: err?.message,
      });
      // Push failure shouldn't block stamping — we don't want an
      // infinite re-notify loop if Expo is down.
    }

    const { error: stampErr } = await supabaseAdmin
      .from('customer_carts')
      .update({ notified_at: new Date().toISOString() })
      .eq('merchant_id', row.merchant_id)
      .eq('customer_id', row.customer_id);
    if (stampErr) {
      console.warn('[cartAbandonment] notified_at stamp failed:', stampErr.message);
    } else {
      sent += 1;
    }
  }
  return sent;
}

async function processAbandonBatch() {
  if (!supabaseAdmin) return 0;
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('customer_carts')
    .select('merchant_id, customer_id, items, subtotal_sar, branch_id, order_type, created_at, updated_at')
    .lt('updated_at', cutoff)
    .limit(BATCH_LIMIT);
  if (error) {
    console.warn('[cartAbandonment] abandon select failed:', error.message);
    return 0;
  }
  if (!data || data.length === 0) return 0;

  let abandoned = 0;
  for (const row of data as CartRow[]) {
    const itemCount = Array.isArray(row.items) ? row.items.length : 0;
    if (itemCount > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from('abandoned_carts')
        .insert({
          merchant_id: row.merchant_id,
          customer_id: row.customer_id,
          items: row.items,
          subtotal_sar: row.subtotal_sar ?? 0,
          branch_id: row.branch_id,
          order_type: row.order_type,
          cart_created_at: row.created_at,
          cart_last_updated_at: row.updated_at,
        });
      if (insertErr) {
        console.warn('[cartAbandonment] abandoned_carts insert failed:', insertErr.message);
        // Skip delete — re-try next tick so we don't lose the row.
        continue;
      }
    }

    const { error: delErr } = await supabaseAdmin
      .from('customer_carts')
      .delete()
      .eq('merchant_id', row.merchant_id)
      .eq('customer_id', row.customer_id);
    if (delErr) {
      console.warn('[cartAbandonment] customer_carts delete failed:', delErr.message);
    } else {
      abandoned += 1;
    }
  }
  return abandoned;
}

async function tick() {
  if (!supabaseAdmin) return;
  try {
    await runWithHeartbeat('cartAbandonment', async () => {
      const [notified, abandoned] = await Promise.all([
        processNotifyBatch(),
        processAbandonBatch(),
      ]);
      if (notified > 0 || abandoned > 0) {
        console.log(`[cartAbandonment] tick — notified=${notified} abandoned=${abandoned}`);
      }
      return { notified, abandoned };
    });
  } catch (err: any) {
    // runWithHeartbeat already shipped to Sentry + audit-stamped the
    // failure row. We swallow here so the setInterval keeps firing.
    console.warn('[cartAbandonment] tick error (heartbeat captured):', err?.message);
  }
}

export function startCartAbandonmentCron() {
  if (!supabaseAdmin) {
    console.warn('[cartAbandonment] supabase not configured — cron disabled.');
    return;
  }
  // First tick after 60s so we don't run during the very first second
  // of startup; subsequent ticks every minute.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, POLL_INTERVAL_MS);
}
