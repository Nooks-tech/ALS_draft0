/**
 * Order management routes – merchant cancel/refund, customer cancel (60s grace),
 * system cancel (no-driver), edit-hold, commission, status
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { cancelPayment, calculateMoyasarFee } from '../services/payment';
import { otoService } from '../services/oto';

export const ordersRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOOKS_COMMISSION_RATE = parseFloat(process.env.NOOKS_COMMISSION_RATE || '0.01');
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const CUSTOMER_CANCEL_WINDOW_MS = 60_000; // 60 seconds

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

/* ── Push notification helper ── */
async function sendPushToCustomer(customerId: string, title: string, body: string) {
  if (!supabaseAdmin) return;
  try {
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('expo_push_token')
      .eq('user_id', customerId);
    const tokens = (subs ?? []).map((s: any) => s.expo_push_token).filter(Boolean);
    if (tokens.length === 0) return;

    const messages = tokens.map((token: string) => ({
      to: token,
      sound: 'default',
      title,
      body,
      channelId: 'marketing',
    }));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });
  } catch (e: any) {
    console.warn('[Push] Failed to send:', e?.message);
  }
}

/* ── Cancel OTO if delivery order ── */
async function cancelOtoIfDelivery(order: Record<string, any>) {
  if (order.order_type !== 'delivery' || !order.oto_id) return;
  const result = await otoService.cancelDelivery(order.oto_id);
  if (result.warning) console.warn('[Orders] OTO cancel warning:', result.warning);
}

/* ═══════════════════════════════════════════════════════════════════
   MERCHANT CANCEL – void-first refund + OTO cancel + fee tracking
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/:id/merchant-cancel', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { reason, refund, amount } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing order ID' });
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ error: 'Cancellation reason is required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: `Cannot cancel order with status: ${order.status}` });
    }

    // Cancel OTO delivery
    await cancelOtoIfDelivery(order);

    const shouldRefund = refund !== false;
    let refundStatus = 'none';
    let refundId: string | null = null;
    let refundFee = 0;
    let refundMethod: string | null = null;
    const refundAmountSAR = amount != null ? Number(amount) : order.total_sar;
    const refundAmountHalals = amount != null ? Math.round(Number(amount) * 100) : undefined;

    if (shouldRefund && order.payment_id) {
      const result = await cancelPayment(order.payment_id, refundAmountHalals);
      if (result.method === 'failed') {
        refundStatus = 'refund_failed';
      } else {
        refundStatus = result.method === 'void' ? 'voided' : 'refunded';
        refundId = result.moyasarId ?? null;
        refundFee = result.fee;
        refundMethod = result.method;
      }
    } else if (shouldRefund) {
      refundStatus = 'pending_manual';
    }

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'Cancelled',
        cancellation_reason: reason,
        cancelled_by: 'merchant',
        refund_status: refundStatus,
        refund_id: refundId,
        refund_amount: refundAmountSAR,
        refund_fee: refundFee,
        refund_fee_absorbed_by: 'merchant',
        refund_method: refundMethod,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Push notification to customer
    if (refundStatus === 'refunded' || refundStatus === 'voided') {
      sendPushToCustomer(
        order.customer_id,
        'Order Cancelled',
        `Your order has been cancelled by the store. A refund of ${refundAmountSAR} SAR has been initiated and will reflect in your account within 3–14 business days.`,
      );
    }

    res.json({ success: true, orderId, refundStatus, refundId: refundId, refundFee, refundMethod });
  } catch (err: any) {
    console.error('[Orders] merchant-cancel error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to cancel order' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   CUSTOMER CANCEL – 60-second grace period, hard block after
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/:id/customer-cancel', async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });

    // Allow On Hold cancellations (edit-flow) without time restriction
    if (order.status === 'On Hold') {
      // Original edit-flow cancel — no time restriction
    } else {
      // 60-second grace period
      const createdAt = new Date(order.created_at).getTime();
      const elapsed = Date.now() - createdAt;
      if (elapsed > CUSTOMER_CANCEL_WINDOW_MS) {
        return res.status(400).json({
          error: 'Cancellation window has expired. Please contact the store.',
          windowExpired: true,
        });
      }
      if (order.status !== 'Preparing') {
        return res.status(400).json({
          error: 'Cannot cancel — order preparation has already progressed.',
        });
      }
    }

    // Cancel OTO delivery
    await cancelOtoIfDelivery(order);

    let refundStatus = 'none';
    let refundId: string | null = null;
    let refundFee = 0;
    let refundMethod: string | null = null;

    let refundError: string | undefined;
    if (order.payment_id) {
      console.log('[Orders] customer-cancel: attempting refund for payment_id:', order.payment_id);
      const result = await cancelPayment(order.payment_id);
      console.log('[Orders] customer-cancel: cancelPayment result:', JSON.stringify(result));
      if (result.method === 'failed') {
        refundStatus = 'refund_failed';
        refundError = result.error;
      } else {
        refundStatus = result.method === 'void' ? 'voided' : 'refunded';
        refundId = result.moyasarId ?? null;
        refundFee = result.fee;
        refundMethod = result.method;
      }
    } else {
      console.log('[Orders] customer-cancel: no payment_id on order, marking pending_manual');
      refundStatus = 'pending_manual';
    }

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'Cancelled',
        cancellation_reason: 'Cancelled by customer',
        cancelled_by: 'customer',
        refund_status: refundStatus,
        refund_id: refundId,
        refund_amount: order.total_sar,
        refund_fee: refundFee,
        refund_fee_absorbed_by: refundFee > 0 ? 'platform' : null,
        refund_method: refundMethod,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    if (refundStatus === 'refunded' || refundStatus === 'voided') {
      sendPushToCustomer(
        order.customer_id,
        'Order Cancelled',
        `Your order has been cancelled. A refund of ${order.total_sar} SAR has been initiated.`,
      );
    }

    res.json({ success: true, orderId, refundStatus, refundFee, refundMethod, refundError, paymentId: order.payment_id });
  } catch (err: any) {
    console.error('[Orders] customer-cancel error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to cancel order' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   SYSTEM CANCEL – no-driver timeout / auto-cancel
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/:id/system-cancel', async (req, res) => {
  try {
    const orderId = req.params.id;
    const reason = (req.body.reason as string) || 'No delivery driver found within time limit';
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: `Cannot cancel order with status: ${order.status}` });
    }

    await cancelOtoIfDelivery(order);

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

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'Cancelled',
        cancellation_reason: reason,
        cancelled_by: 'system',
        refund_status: refundStatus,
        refund_id: refundId,
        refund_amount: order.total_sar,
        refund_fee: refundFee,
        refund_fee_absorbed_by: refundFee > 0 ? 'platform' : null,
        refund_method: refundMethod,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    sendPushToCustomer(
      order.customer_id,
      'Order Cancelled',
      `We're sorry — we couldn't find a delivery driver for your order. A full refund of ${order.total_sar} SAR has been initiated.`,
    );

    res.json({ success: true, orderId, refundStatus, refundFee, refundMethod });
  } catch (err: any) {
    console.error('[Orders] system-cancel error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to cancel order' });
  }
});

/* ── Hold / Resume (edit window) ── */
ordersRouter.post('/:id/hold', async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });

    const createdAt = new Date(order.created_at).getTime();
    const holdWindowMs = 5000;
    if (Date.now() - createdAt > holdWindowMs) {
      return res.status(400).json({ error: 'Edit window expired', windowExpired: true });
    }
    if (order.status !== 'Preparing') {
      return res.status(400).json({ error: 'Order is no longer editable' });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({ status: 'On Hold', updated_at: new Date().toISOString() })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ success: true, orderId, status: 'On Hold' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to hold order' });
  }
});

ordersRouter.post('/:id/resume', async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({ status: 'Preparing', updated_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('status', 'On Hold');

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ success: true, orderId, status: 'Preparing' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to resume order' });
  }
});

/* ── Commission ── */
ordersRouter.get('/:id/commission', async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('total_sar, delivery_fee, commission_amount, commission_status')
      .eq('id', orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    const deliveryFee = order.delivery_fee || 0;
    const orderSubtotal = order.total_sar - deliveryFee;
    const commissionAmount = order.commission_amount ?? +(orderSubtotal * NOOKS_COMMISSION_RATE).toFixed(2);

    res.json({
      orderId,
      orderTotal: order.total_sar,
      deliveryFee,
      orderSubtotal,
      commissionRate: NOOKS_COMMISSION_RATE,
      commissionAmount,
      commissionStatus: order.commission_status ?? 'pending',
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get commission' });
  }
});

ordersRouter.post('/calculate-commission', async (req, res) => {
  const { subtotal } = req.body;
  if (subtotal == null) return res.status(400).json({ error: 'subtotal required' });
  const amount = +(Number(subtotal) * NOOKS_COMMISSION_RATE).toFixed(2);
  res.json({ subtotal: Number(subtotal), commissionRate: NOOKS_COMMISSION_RATE, commissionAmount: amount });
});

/* ── Order status with cancel-window info ── */
ordersRouter.get('/:id/status', async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('id, status, cancellation_reason, cancelled_by, refund_status, refund_amount, refund_fee, refund_method, created_at, updated_at')
      .eq('id', orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    const createdAt = new Date(order.created_at).getTime();
    const elapsed = Date.now() - createdAt;
    const canCustomerCancel =
      (order.status === 'Preparing' && elapsed <= CUSTOMER_CANCEL_WINDOW_MS) ||
      order.status === 'On Hold';
    const cancelTimeRemaining = order.status === 'On Hold'
      ? CUSTOMER_CANCEL_WINDOW_MS
      : Math.max(0, CUSTOMER_CANCEL_WINDOW_MS - elapsed);

    res.json({ ...order, canCustomerCancel, cancelTimeRemaining });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get order status' });
  }
});

/* ── Update status (dashboard) ── */
ordersRouter.patch('/:id/status', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status } = req.body;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    if (!status) return res.status(400).json({ error: 'status is required' });

    const validStatuses = ['Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled', 'On Hold', 'Pending'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const { error } = await supabaseAdmin
      .from('customer_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', orderId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, orderId, status });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update status' });
  }
});

/* ── Export helpers for use in cron and complaints ── */
export { sendPushToCustomer, cancelOtoIfDelivery, supabaseAdmin as ordersSupabaseAdmin };
