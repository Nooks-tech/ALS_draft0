import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { calculateCommission, calculateMoyasarFee, paymentService } from '../services/payment';

export const paymentRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOOKS_COMMISSION_RATE = parseFloat(process.env.NOOKS_COMMISSION_RATE || '0.01');
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

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
    res.status(500).json({ error: error?.message || 'Failed to initiate payment' });
  }
});

/** POST /api/payment/webhook – Moyasar payment status callback */
paymentRouter.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const id: string = payload.id ?? payload.data?.id ?? '';
    const status: string = payload.status ?? payload.data?.status ?? '';
    const metadata = payload.metadata ?? payload.data?.metadata ?? {};
    const source = payload.source ?? payload.data?.source ?? {};

    console.log('[Payment Webhook]', { id, status, orderId: metadata?.order_id, company: source?.company });
    if (!supabaseAdmin || !id) return res.json({ received: true });

    const metaOrderId = metadata?.order_id;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (status === 'paid' || status === 'captured') {
      updates.payment_id = id;

      const company = (source?.company || '').toLowerCase();
      if (company) {
        updates.payment_method = company;
      }
    } else if (status === 'refunded') {
      updates.refund_status = 'refunded';
      updates.refund_id = id;
    } else if (status === 'voided') {
      updates.refund_status = 'voided';
    } else if (status === 'failed') {
      updates.status = 'Cancelled';
      updates.cancellation_reason = 'Payment failed';
      updates.cancelled_by = 'system';
    }

    if (Object.keys(updates).length > 1) {
      let matched = false;

      // Try metadata.order_id first (matches the DB row id)
      if (metaOrderId) {
        const { error } = await supabaseAdmin.from('customer_orders').update(updates).eq('id', metaOrderId);
        if (!error) matched = true;
      }

      // Fallback: match by payment_id column (stores the real Moyasar ID)
      if (!matched && id) {
        await supabaseAdmin.from('customer_orders').update(updates).eq('payment_id', id);
      }

      // Calculate Moyasar fee if payment succeeded
      if ((status === 'paid' || status === 'captured') && updates.payment_method) {
        const lookupId = metaOrderId || id;
        const { data: order } = await supabaseAdmin
          .from('customer_orders')
          .select('id, total_sar')
          .or(`id.eq.${lookupId},payment_id.eq.${id}`)
          .limit(1)
          .single();
        if (order) {
          await supabaseAdmin
            .from('customer_orders')
            .update({ moyasar_fee: calculateMoyasarFee(order.total_sar, updates.payment_method as string) })
            .eq('id', order.id);
        }
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('[Payment Webhook] Error:', err?.message);
    res.json({ received: true });
  }
});
