/**
 * Stale delivery order auto-cancel cron.
 * Polls every 5 minutes.  If a delivery order has been in "Ready" status
 * for 15+ minutes and OTO has no driver assigned, system-cancels it with full refund.
 */
import { createClient } from '@supabase/supabase-js';
import { cancelPayment } from '../services/payment';
import { otoService } from '../services/oto';

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

async function checkStaleOrders() {
  if (!supabaseAdmin) return;

  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: staleOrders, error } = await supabaseAdmin
    .from('customer_orders')
    .select('*')
    .eq('order_type', 'delivery')
    .in('status', ['Ready', 'Preparing'])
    .not('oto_id', 'is', null)
    .lt('updated_at', cutoff)
    .limit(20);

  if (error || !staleOrders?.length) return;

  for (const order of staleOrders) {
    try {
      // Check OTO first — driver might have been assigned
      if (order.oto_id) {
        const otoStatus = await otoService.orderStatus(order.oto_id);
        const status = (otoStatus.status || '').toLowerCase();
        if (['picked_up', 'on_the_way', 'delivered', 'out_for_delivery'].some(s => status.includes(s))) {
          console.log(`[Cron] Order ${order.id} has OTO status "${otoStatus.status}" — skipping auto-cancel`);
          continue;
        }
      }

      // Cancel OTO
      if (order.oto_id) {
        await otoService.cancelDelivery(order.oto_id);
      }

      // Cancel payment (void-first)
      let refundStatus = 'none';
      let refundId: string | null = null;
      let refundFee = 0;
      let refundMethod: string | null = null;

      if (order.payment_id) {
        const result = await cancelPayment(order.payment_id);
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

export function startStaleOrdersCron() {
  console.log('[Cron] Stale orders check started (every 5 min)');
  setInterval(checkStaleOrders, POLL_INTERVAL_MS);
  // Also run once at startup (after a short delay)
  setTimeout(checkStaleOrders, 10_000);
}
