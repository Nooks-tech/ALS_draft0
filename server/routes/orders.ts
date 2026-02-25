/**
 * Order management routes – merchant cancel/refund, customer cancel, edit-hold, commission
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';

export const ordersRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY;
const NOOKS_COMMISSION_RATE = parseFloat(process.env.NOOKS_COMMISSION_RATE || '0.01');

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

/** POST /api/orders/:id/merchant-cancel – merchant cancels order with refund + note */
ordersRouter.post('/:id/merchant-cancel', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { reason, refund } = req.body;
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

    const shouldRefund = refund !== false;
    let refundStatus = 'none';
    let moyasarRefundId: string | null = null;

    if (shouldRefund && order.payment_id && MOYASAR_SECRET_KEY) {
      try {
        const refundRes = await fetch(
          `https://api.moyasar.com/v1/payments/${order.payment_id}/refund`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(MOYASAR_SECRET_KEY + ':').toString('base64')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ amount: Math.round(order.total_sar * 100) }),
          }
        );
        const refundData = await refundRes.json();
        if (refundRes.ok) {
          refundStatus = 'refunded';
          moyasarRefundId = refundData?.id ?? null;
          console.log('[Orders] Moyasar refund success:', moyasarRefundId);
        } else {
          refundStatus = 'refund_failed';
          console.error('[Orders] Moyasar refund failed:', refundData);
        }
      } catch (e: any) {
        refundStatus = 'refund_failed';
        console.error('[Orders] Refund error:', e?.message);
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
        refund_id: moyasarRefundId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({
      success: true,
      orderId,
      refundStatus,
      refundId: moyasarRefundId,
    });
  } catch (err: any) {
    console.error('[Orders] merchant-cancel error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to cancel order' });
  }
});

/** POST /api/orders/:id/customer-cancel – customer cancels within 2-minute window */
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
    if (order.status !== 'Preparing') {
      return res.status(400).json({ error: 'Order can only be cancelled while Preparing' });
    }

    const createdAt = new Date(order.created_at).getTime();
    const now = Date.now();
    const twoMinutesMs = 2 * 60 * 1000;

    if (now - createdAt > twoMinutesMs) {
      return res.status(400).json({
        error: 'Cancellation window expired. Orders can only be cancelled within 2 minutes.',
        windowExpired: true,
      });
    }

    let refundStatus = 'none';
    let moyasarRefundId: string | null = null;

    if (order.payment_id && MOYASAR_SECRET_KEY) {
      try {
        const refundRes = await fetch(
          `https://api.moyasar.com/v1/payments/${order.payment_id}/refund`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(MOYASAR_SECRET_KEY + ':').toString('base64')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ amount: Math.round(order.total_sar * 100) }),
          }
        );
        const refundData = await refundRes.json();
        if (refundRes.ok) {
          refundStatus = 'refunded';
          moyasarRefundId = refundData?.id ?? null;
        } else {
          refundStatus = 'refund_failed';
        }
      } catch {
        refundStatus = 'refund_failed';
      }
    } else {
      refundStatus = 'pending_manual';
    }

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'Cancelled',
        cancellation_reason: 'Cancelled by customer',
        cancelled_by: 'customer',
        refund_status: refundStatus,
        refund_id: moyasarRefundId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({ success: true, orderId, refundStatus });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to cancel order' });
  }
});

/** POST /api/orders/:id/hold – withhold payment (5-second edit window after payment) */
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
    const now = Date.now();
    const holdWindowMs = 5000;

    if (now - createdAt > holdWindowMs) {
      return res.status(400).json({ error: 'Edit window expired', windowExpired: true });
    }

    if (order.status !== 'Preparing') {
      return res.status(400).json({ error: 'Order is no longer editable' });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'On Hold',
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({ success: true, orderId, status: 'On Hold' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to hold order' });
  }
});

/** POST /api/orders/:id/resume – resume a held order */
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

/** GET /api/orders/:id/commission – get commission breakdown for an order */
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

/** POST /api/orders/calculate-commission – calculate commission for a given amount */
ordersRouter.post('/calculate-commission', async (req, res) => {
  const { subtotal } = req.body;
  if (subtotal == null) return res.status(400).json({ error: 'subtotal required' });
  const amount = +(Number(subtotal) * NOOKS_COMMISSION_RATE).toFixed(2);
  res.json({ subtotal: Number(subtotal), commissionRate: NOOKS_COMMISSION_RATE, commissionAmount: amount });
});

/** GET /api/orders/:id/status – get order status with cancellation info */
ordersRouter.get('/:id/status', async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('id, status, cancellation_reason, cancelled_by, refund_status, created_at, updated_at')
      .eq('id', orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    const createdAt = new Date(order.created_at).getTime();
    const cancelWindowMs = 2 * 60 * 1000;
    const canCustomerCancel = order.status === 'Preparing' && Date.now() - createdAt < cancelWindowMs;
    const cancelTimeRemaining = canCustomerCancel ? Math.max(0, cancelWindowMs - (Date.now() - createdAt)) : 0;

    res.json({
      ...order,
      canCustomerCancel,
      cancelTimeRemaining,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get order status' });
  }
});

/** PATCH /api/orders/:id/status – update order status from nooksweb dashboard */
ordersRouter.patch('/:id/status', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status } = req.body;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    if (!status) return res.status(400).json({ error: 'status is required' });

    const validStatuses = ['Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled'];
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
