import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { calculateCommission, paymentService } from '../services/payment';

export const paymentRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

/** Redirect for payment return - allows https success_url that redirects to app deep link */
paymentRouter.get('/redirect', (req, res) => {
  const to = req.query.to as string;
  if (to && (to.startsWith('alsdraft0://') || to.startsWith('https://'))) {
    return res.redirect(302, to);
  }
  res.status(400).send('Invalid redirect');
});

paymentRouter.post('/initiate', async (req, res) => {
  try {
    const { amount, currency, orderId, customer, successUrl, deliveryFee } = req.body;
    console.log('[Payment] Initiate request:', { amount, currency, orderId });
    const session = await paymentService.initiatePayment({
      amount: Number(amount),
      currency: currency || 'SAR',
      orderId,
      customer,
      successUrl,
      deliveryFee: deliveryFee != null ? Number(deliveryFee) : 0,
    });

    if (orderId && supabaseAdmin) {
      const commission = calculateCommission(Number(amount), deliveryFee ? Number(deliveryFee) : 0);
      await supabaseAdmin
        .from('customer_orders')
        .update({
          payment_id: session.id,
          commission_amount: commission.amount,
          commission_rate: commission.rate,
          commission_status: 'pending',
        })
        .eq('id', orderId)
        .then(({ error }) => {
          if (error) console.warn('[Payment] Commission record failed:', error.message);
          else console.log('[Payment] Commission recorded:', commission.amount, 'SAR for order', orderId);
        });
    }

    console.log('[Payment] Session created:', session.id, session.url ? 'has url' : 'no url');
    res.json(session);
  } catch (error: any) {
    console.error('[Payment] Initiate error:', error?.message);
    res.status(500).json({
      error: error?.message || 'Failed to initiate payment',
    });
  }
});

/** POST /api/payment/webhook – Moyasar payment status callback */
paymentRouter.post('/webhook', async (req, res) => {
  try {
    const { id, status, metadata } = req.body;
    console.log('[Payment Webhook]', { id, status, orderId: metadata?.order_id });
    if (!supabaseAdmin || !id) return res.json({ received: true });

    const orderId = metadata?.order_id;
    if (!orderId) return res.json({ received: true });

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (status === 'paid') {
      updates.payment_id = id;
    } else if (status === 'refunded') {
      updates.refund_status = 'refunded';
      updates.refund_id = id;
    } else if (status === 'failed') {
      updates.status = 'Cancelled';
      updates.cancellation_reason = 'Payment failed';
      updates.cancelled_by = 'system';
    }

    if (Object.keys(updates).length > 1) {
      await supabaseAdmin.from('customer_orders').update(updates).eq('id', orderId);
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('[Payment Webhook] Error:', err?.message);
    res.json({ received: true });
  }
});
