/**
 * Delivery order cron – runs every 5 minutes:
 * 1. Syncs OTO status for all active delivery orders (webhook safety net)
 * 2. Auto-cancels stale orders with no driver after 15 minutes
 */
import { createClient } from '@supabase/supabase-js';
import { cancelPayment } from '../services/payment';
import { otoService } from '../services/oto';
import { mapOtoStatusToOrderStatus } from '../routes/oto';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;    // every 5 minutes

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
        to: t, sound: 'default', title, body, channelId: 'marketing',
      }))),
    });
  } catch { /* best-effort */ }
}

const STATUS_RANK: Record<string, number> = {
  'Placed': 0, 'Pending': 0, 'Accepted': 1, 'Preparing': 2, 'Ready': 3, 'Out for delivery': 4, 'Delivered': 5, 'Cancelled': 6,
};

async function syncOtoStatuses() {
  // OTO-DISABLED 2026-04-19: delivery moved to Foodics DMS. No OTO orders
  // are being created anymore so there's nothing to sync; short-circuit
  // the cron work. Leaving the function body below for reference.
  return;
  // eslint-disable-next-line @typescript-eslint/no-unreachable-code
  if (!supabaseAdmin) return;

  const { data: activeOrders, error } = await supabaseAdmin
    .from('customer_orders')
    .select('id, status, customer_id, oto_id, merchant_id')
    .eq('order_type', 'delivery')
    .in('status', ['Placed', 'Accepted', 'Preparing', 'Ready', 'Out for delivery'])
    .not('oto_id', 'is', null)
    .limit(50);

  if (error || !activeOrders?.length) return;

  for (const order of activeOrders) {
    try {
      const otoData = await otoService.orderStatus(order.oto_id, order.merchant_id);
      const mapped = mapOtoStatusToOrderStatus(otoData?.status);

      const currentRank = STATUS_RANK[order.status] ?? 0;
      const newRank = STATUS_RANK[mapped] ?? 0;
      if (newRank <= currentRank && mapped !== 'Cancelled') continue;

      const updates: Record<string, unknown> = { status: mapped, updated_at: new Date().toISOString() };
      await supabaseAdmin.from('customer_orders').update(updates).eq('id', order.id);

      if (mapped === 'Out for delivery' && order.customer_id) {
        sendPush(order.customer_id, 'Order On The Way!', 'Your order is out for delivery.');
      } else if (mapped === 'Delivered' && order.customer_id) {
        sendPush(order.customer_id, 'Order Delivered', 'Your order has been delivered. Enjoy!');
      }

      console.log(`[Cron] OTO sync: order ${order.id} ${order.status} -> ${mapped}`);
    } catch (e: any) {
      console.warn(`[Cron] OTO sync failed for order ${order.id}:`, e?.message);
    }
  }
}

async function checkStaleOrders() {
  if (!supabaseAdmin) return;

  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: staleOrders, error } = await supabaseAdmin
    .from('customer_orders')
    .select('*')
    .eq('order_type', 'delivery')
    .in('status', ['Ready', 'Preparing', 'Accepted', 'Placed'])
    .not('oto_id', 'is', null)
    .lt('updated_at', cutoff)
    .limit(20);

  if (error || !staleOrders?.length) return;

  for (const order of staleOrders) {
    try {
      // Check OTO first — driver might have been assigned
      if (order.oto_id) {
        const otoStatus = await otoService.orderStatus(order.oto_id, order.merchant_id);
        const status = (otoStatus.status || '').toLowerCase();
        if (['picked_up', 'on_the_way', 'delivered', 'out_for_delivery'].some(s => status.includes(s))) {
          console.log(`[Cron] Order ${order.id} has OTO status "${otoStatus.status}" — skipping auto-cancel`);
          continue;
        }
      }

      // Cancel OTO
      if (order.oto_id) {
        await otoService.cancelDelivery(order.oto_id, undefined, order.merchant_id);
      }

      // Cancel payment (void-first)
      let refundStatus = 'none';
      let refundId: string | null = null;
      let refundFee = 0;
      let refundMethod: string | null = null;

      if (order.payment_id) {
        const result = await cancelPayment(order.payment_id, undefined, order.merchant_id);
        if (result.method === 'failed') {
          refundStatus = 'refund_failed';
        } else {
          refundStatus = result.method === 'void' ? 'voided' : 'refunded';
          refundId = result.moyasarId ?? null;
          refundFee = result.fee;
          refundMethod = result.method;
        }
      }

      await supabaseAdmin
        .from('customer_orders')
        .update({
          status: 'Cancelled',
          cancellation_reason: 'No delivery driver found within 15 minutes',
          cancelled_by: 'system',
          refund_status: refundStatus,
          refund_id: refundId,
          refund_amount: order.total_sar,
          refund_fee: refundFee,
          refund_fee_absorbed_by: refundFee > 0 ? 'platform' : null,
          refund_method: refundMethod,
          commission_status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      sendPush(
        order.customer_id,
        'Order Cancelled',
        `We're sorry — no delivery driver was found for your order. A full refund of ${order.total_sar} SAR has been initiated.`,
      );

      console.log(`[Cron] Auto-cancelled stale order ${order.id}`);
    } catch (e: any) {
      console.error(`[Cron] Failed to auto-cancel order ${order.id}:`, e?.message);
    }
  }
}

async function runCronCycle() {
  await syncOtoStatuses();
  await checkStaleOrders();
}

export function startStaleOrdersCron() {
  console.log('[Cron] Delivery order cron started (every 5 min): OTO sync + stale order check');
  setInterval(runCronCycle, POLL_INTERVAL_MS);
  setTimeout(runCronCycle, 10_000);
}
