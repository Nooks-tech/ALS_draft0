import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { calculateCommission, calculateMoyasarFee, paymentService } from '../services/payment';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';

export const paymentRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

export function buildPaymentWebhookUpdates(params: {
  status: string;
  paymentId: string;
  sourceCompany?: string | null;
}) {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (params.status === 'paid' || params.status === 'captured') {
    updates.payment_id = params.paymentId;
    const company = (params.sourceCompany || '').toLowerCase();
    if (company) {
      updates.payment_method = company;
    }
  } else if (params.status === 'refunded') {
    updates.refund_status = 'refunded';
    updates.refund_id = params.paymentId;
  } else if (params.status === 'voided') {
    updates.refund_status = 'voided';
  } else if (params.status === 'failed') {
    updates.status = 'Cancelled';
    updates.cancellation_reason = 'Payment failed';
    updates.cancelled_by = 'system';
  }

  return updates;
}

paymentRouter.get('/redirect', (req, res) => {
  const to = req.query.to as string;
  if (to && to.startsWith('alsdraft0://')) {
    return res.redirect(302, to);
  }
  res.status(400).send('Invalid redirect');
});

paymentRouter.post('/initiate', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const { amount, currency, orderId, customer, successUrl, deliveryFee, merchantId } = req.body;
    console.log('[Payment] Initiate request:', { amount, currency, orderId, merchantId });
    const scopedMerchantId = typeof merchantId === 'string' ? merchantId.trim() : '';
    if (!scopedMerchantId) {
      return res.status(400).json({ error: 'merchantId is required for merchant checkout' });
    }
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ error: 'orderId is required for merchant checkout' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('customer_orders')
      .select('id, total_sar, delivery_fee, customer_id, merchant_id, status')
      .eq('id', orderId)
      .eq('merchant_id', scopedMerchantId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (orderError) {
      return res.status(500).json({ error: orderError.message });
    }
    if (!order) {
      return res.status(404).json({ error: 'Checkout order not found for this customer' });
    }

    const requestedAmount = Number(amount);
    const persistedAmount = Number(order.total_sar ?? 0);
    if (!Number.isFinite(requestedAmount) || Math.abs(requestedAmount - persistedAmount) > 0.01) {
      return res.status(400).json({ error: 'Checkout amount does not match the persisted order total' });
    }
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: `Cannot initiate payment for order status: ${order.status}` });
    }

    const session = await paymentService.initiatePayment({
      amount: requestedAmount,
      currency: currency || 'SAR',
      orderId,
      customer,
      successUrl,
      deliveryFee: deliveryFee != null ? Number(deliveryFee) : Number(order.delivery_fee ?? 0),
      merchantId: scopedMerchantId,
      metadata: { merchant_id: scopedMerchantId },
    });

    const commission = calculateCommission(requestedAmount, deliveryFee ? Number(deliveryFee) : Number(order.delivery_fee ?? 0));
    const { error: commissionError } = await supabaseAdmin
      .from('customer_orders')
      .update({
        payment_id: session.id,
        commission_amount: commission.amount,
        commission_rate: commission.rate,
        commission_status: 'pending',
      })
      .eq('id', orderId)
      .eq('merchant_id', scopedMerchantId)
      .eq('customer_id', user.id);
    if (commissionError) {
      console.warn('[Payment] Commission record failed:', commissionError.message);
    } else {
      console.log('[Payment] Commission recorded:', commission.amount, 'SAR for order', orderId);
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
    const merchantId: string = metadata?.merchant_id ?? '';
    if (!merchantId) {
      console.warn('[Payment Webhook] Missing merchant_id metadata');
      return res.status(400).json({ error: 'merchant_id metadata is required' });
    }

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    const expectedWebhookSecret = runtimeConfig.webhookSecret;

    if (!expectedWebhookSecret) {
      return res.status(503).json({ error: 'Moyasar webhook secret is not configured' });
    }

    const token =
      req.body?.secret_token as string ||
      (req.query.secret_token as string) ||
      req.headers['x-moyasar-token'] as string ||
      req.headers['x-webhook-secret'] as string;
    if (token !== expectedWebhookSecret) {
      console.warn('[Payment Webhook] Invalid or missing secret token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('[Payment Webhook]', { id, status, orderId: metadata?.order_id, merchantId, company: source?.company });
    if (!id) {
      return res.status(400).json({ error: 'payment id is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const metaOrderId = metadata?.order_id;

    const updates = buildPaymentWebhookUpdates({
      status,
      paymentId: id,
      sourceCompany: source?.company,
    });

    if (Object.keys(updates).length > 1) {
      let lookup = supabaseAdmin
        .from('customer_orders')
        .select('id, total_sar')
        .eq('merchant_id', merchantId)
        .limit(1);

      if (metaOrderId) {
        lookup = lookup.or(`id.eq.${metaOrderId},payment_id.eq.${id}`);
      } else {
        lookup = lookup.eq('payment_id', id);
      }

      const { data: order, error: lookupError } = await lookup.maybeSingle();
      if (lookupError) {
        console.error('[Payment Webhook] Order lookup failed:', lookupError.message);
        return res.status(500).json({ error: 'Failed to resolve payment order' });
      }
      if (!order) {
        console.warn('[Payment Webhook] No order row matched webhook payload', { id, metaOrderId, merchantId });
        return res.status(409).json({ error: 'Order not found for webhook payload' });
      }

      const { error: updateError } = await supabaseAdmin
        .from('customer_orders')
        .update(updates)
        .eq('id', order.id)
        .eq('merchant_id', merchantId);
      if (updateError) {
        console.error('[Payment Webhook] Order update failed:', updateError.message);
        return res.status(500).json({ error: 'Failed to persist payment webhook state' });
      }

      // Calculate Moyasar fee if payment succeeded
      if ((status === 'paid' || status === 'captured') && updates.payment_method) {
        const { error: feeUpdateError } = await supabaseAdmin
          .from('customer_orders')
          .update({ moyasar_fee: calculateMoyasarFee(order.total_sar, updates.payment_method as string) })
          .eq('id', order.id)
          .eq('merchant_id', merchantId);
        if (feeUpdateError) {
          console.error('[Payment Webhook] Moyasar fee update failed:', feeUpdateError.message);
          return res.status(500).json({ error: 'Failed to persist payment fee state' });
        }
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('[Payment Webhook] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to process webhook' });
  }
});
