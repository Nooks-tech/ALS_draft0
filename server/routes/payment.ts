import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { calculateCommission, calculateMoyasarFee, normalizeMerchantId, paymentService } from '../services/payment';
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

/** POST /api/payment/stcpay/initiate – Initiate STC Pay (sends OTP to mobile) */
paymentRouter.post('/stcpay/initiate', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const { orderId, merchantId, mobile, amount } = req.body;
    console.log('[STC Pay] Initiate request:', { orderId, merchantId, mobile: mobile?.replace(/.(?=.{4})/g, '*') });

    const scopedMerchantId = typeof merchantId === 'string' ? merchantId.trim() : '';
    if (!scopedMerchantId) {
      return res.status(400).json({ error: 'merchantId is required' });
    }
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ error: 'orderId is required' });
    }
    if (!mobile || typeof mobile !== 'string') {
      return res.status(400).json({ error: 'mobile is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Validate order exists and amount matches
    const { data: order, error: orderError } = await supabaseAdmin
      .from('customer_orders')
      .select('id, total_sar, customer_id, merchant_id, status')
      .eq('id', orderId)
      .eq('merchant_id', scopedMerchantId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (orderError) {
      return res.status(500).json({ error: orderError.message });
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found for this customer' });
    }

    const requestedAmount = Number(amount);
    const persistedAmount = Number(order.total_sar ?? 0);
    if (!Number.isFinite(requestedAmount) || Math.abs(requestedAmount - persistedAmount) > 0.01) {
      return res.status(400).json({ error: 'Amount does not match the persisted order total' });
    }
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: `Cannot initiate payment for order status: ${order.status}` });
    }

    const session = await paymentService.initiateStcPay({
      amount: requestedAmount,
      currency: 'SAR',
      orderId,
      mobile,
      merchantId: scopedMerchantId,
      metadata: { merchant_id: scopedMerchantId },
    });

    // Store payment_id on the order
    const commission = calculateCommission(requestedAmount, Number(order.total_sar ?? 0) - requestedAmount);
    const { error: updateError } = await supabaseAdmin
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
    if (updateError) {
      console.warn('[STC Pay] Commission record failed:', updateError.message);
    }

    console.log('[STC Pay] Session created:', session.id, 'status:', session.status);
    res.json({ paymentId: session.id, status: session.status });
  } catch (error: any) {
    console.error('[STC Pay] Initiate error:', error?.message);
    res.status(500).json({ error: error?.message || 'Failed to initiate STC Pay' });
  }
});

/** POST /api/payment/stcpay/otp – Verify STC Pay OTP */
paymentRouter.post('/stcpay/otp', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const { paymentId, otp } = req.body;
    console.log('[STC Pay] OTP verification for payment:', paymentId);

    if (!paymentId || typeof paymentId !== 'string') {
      return res.status(400).json({ error: 'paymentId is required' });
    }
    if (!otp || typeof otp !== 'string') {
      return res.status(400).json({ error: 'otp is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Look up the order to get the merchant's secret key
    const { data: order, error: orderError } = await supabaseAdmin
      .from('customer_orders')
      .select('id, merchant_id, total_sar, status')
      .eq('payment_id', paymentId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (orderError) {
      return res.status(500).json({ error: orderError.message });
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found for this payment' });
    }

    const merchantId = normalizeMerchantId(order.merchant_id);
    if (!merchantId) {
      return res.status(400).json({ error: 'Merchant ID not found on order' });
    }

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    const secretKey = runtimeConfig.secretKey;
    if (!secretKey) {
      return res.status(500).json({ error: 'Moyasar secret key is not configured' });
    }

    const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;

    // Call Moyasar to verify the OTP
    const moyasarRes = await fetch(`https://api.moyasar.com/v1/stc_pays/${paymentId}/proceed`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ otp_value: otp }),
    });
    const data = await moyasarRes.json();

    if (!moyasarRes.ok) {
      console.error('[STC Pay] OTP verification failed:', moyasarRes.status, data);
      return res.status(moyasarRes.status >= 500 ? 502 : 400).json({
        error: data?.message || 'OTP verification failed',
        status: data?.status,
      });
    }

    console.log('[STC Pay] OTP result:', data.id, 'status:', data.status);

    // If payment succeeded, update the order
    if (data.status === 'paid') {
      const updates: Record<string, unknown> = {
        payment_id: data.id || paymentId,
        payment_method: 'stcpay',
        updated_at: new Date().toISOString(),
      };
      const { error: updateError } = await supabaseAdmin
        .from('customer_orders')
        .update(updates)
        .eq('id', order.id)
        .eq('merchant_id', merchantId);
      if (updateError) {
        console.warn('[STC Pay] Order update failed:', updateError.message);
      }

      // Record Moyasar fee for STC Pay
      const fee = calculateMoyasarFee(Number(order.total_sar), 'stcpay');
      await supabaseAdmin
        .from('customer_orders')
        .update({ moyasar_fee: fee })
        .eq('id', order.id)
        .eq('merchant_id', merchantId);
    }

    res.json({ paymentId: data.id || paymentId, status: data.status });
  } catch (error: any) {
    console.error('[STC Pay] OTP error:', error?.message);
    res.status(500).json({ error: error?.message || 'Failed to verify OTP' });
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
        .select('id, total_sar, customer_id')
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

      // Validate payment amount matches order total (prevent tampered webhooks)
      if ((status === 'paid' || status === 'captured') && order.total_sar != null) {
        const webhookAmountHalals = Number(payload.amount ?? payload.data?.amount ?? 0);
        const webhookAmountSar = webhookAmountHalals / 100;
        const tolerance = 1.0; // 1 SAR tolerance for rounding
        if (Math.abs(webhookAmountSar - Number(order.total_sar)) > tolerance) {
          console.error('[Payment Webhook] Amount mismatch!', {
            webhookAmountSar,
            orderTotalSar: order.total_sar,
            orderId: order.id,
          });
          return res.status(409).json({ error: 'Payment amount does not match order total' });
        }
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

      // Save card token when payment succeeds and source includes a token
      if ((status === 'paid' || status === 'captured') && source?.token?.id) {
        const tokenObj = source.token;
        const tokenId: string = tokenObj.id ?? '';
        const customerId: string = metadata?.customer_id ?? order.customer_id ?? '';
        if (tokenId && customerId) {
          const { error: upsertError } = await supabaseAdmin
            .from('customer_saved_cards')
            .upsert(
              {
                customer_id: customerId,
                merchant_id: merchantId,
                token: tokenId,
                brand: (tokenObj.brand ?? source.company ?? '').toLowerCase() || null,
                last_four: tokenObj.last_four ?? source.last_four ?? null,
                name: tokenObj.name ?? source.name ?? null,
                expires_month: tokenObj.month ?? null,
                expires_year: tokenObj.year ?? null,
              },
              { onConflict: 'customer_id,merchant_id,token' },
            );
          if (upsertError) {
            console.warn('[Payment Webhook] Card token save failed:', upsertError.message);
          } else {
            console.log('[Payment Webhook] Card token saved for customer', customerId);
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('[Payment Webhook] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to process webhook' });
  }
});

/* ─── Saved Cards (Tokenization) ─── */

/** GET /api/payment/saved-cards?merchantId=X – List user's saved cards */
paymentRouter.get('/saved-cards', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId.trim() : '';
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId query param is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const { data, error } = await supabaseAdmin
      .from('customer_saved_cards')
      .select('id, brand, last_four, name, expires_month, expires_year')
      .eq('customer_id', user.id)
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[SavedCards] List error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json(data ?? []);
  } catch (err: any) {
    console.error('[SavedCards] List error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to list saved cards' });
  }
});

/** DELETE /api/payment/saved-cards/:id – Delete a saved card */
paymentRouter.delete('/saved-cards/:id', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const cardId = req.params.id;
    if (!cardId) {
      return res.status(400).json({ error: 'card id is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Look up the card to get the token and merchant for Moyasar deletion
    const { data: card, error: lookupError } = await supabaseAdmin
      .from('customer_saved_cards')
      .select('id, token, merchant_id')
      .eq('id', cardId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (lookupError) {
      return res.status(500).json({ error: lookupError.message });
    }
    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Delete the token from Moyasar (best-effort — don't block on failure)
    try {
      const runtimeConfig = await getMerchantPaymentRuntimeConfig(card.merchant_id);
      const secretKey = runtimeConfig.secretKey;
      if (secretKey && card.token) {
        await fetch(`https://api.moyasar.com/v1/tokens/${card.token}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
          },
        });
        console.log('[SavedCards] Moyasar token deleted:', card.token);
      }
    } catch (e: any) {
      console.warn('[SavedCards] Moyasar token deletion failed (non-blocking):', e?.message);
    }

    // Delete from our database
    const { error: deleteError } = await supabaseAdmin
      .from('customer_saved_cards')
      .delete()
      .eq('id', cardId)
      .eq('customer_id', user.id);
    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[SavedCards] Delete error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to delete saved card' });
  }
});

/** POST /api/payment/token-pay – Pay with a saved (tokenized) card */
paymentRouter.post('/token-pay', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const { orderId, merchantId, savedCardId } = req.body;
    const scopedMerchantId = typeof merchantId === 'string' ? merchantId.trim() : '';
    if (!scopedMerchantId) {
      return res.status(400).json({ error: 'merchantId is required' });
    }
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ error: 'orderId is required' });
    }
    if (!savedCardId || typeof savedCardId !== 'string') {
      return res.status(400).json({ error: 'savedCardId is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Look up the saved card
    const { data: card, error: cardError } = await supabaseAdmin
      .from('customer_saved_cards')
      .select('token')
      .eq('id', savedCardId)
      .eq('customer_id', user.id)
      .eq('merchant_id', scopedMerchantId)
      .maybeSingle();
    if (cardError) {
      return res.status(500).json({ error: cardError.message });
    }
    if (!card) {
      return res.status(404).json({ error: 'Saved card not found' });
    }

    // Look up the order
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
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: `Cannot pay for order status: ${order.status}` });
    }

    const amount = Number(order.total_sar ?? 0);
    const session = await paymentService.initiateMoyasarTokenPayment({
      amount,
      currency: 'SAR',
      orderId,
      token: card.token,
      merchantId: scopedMerchantId,
      metadata: { merchant_id: scopedMerchantId },
    });

    // Record commission
    const commission = calculateCommission(amount, Number(order.delivery_fee ?? 0));
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
      console.warn('[TokenPay] Commission record failed:', commissionError.message);
    }

    console.log('[TokenPay] Payment created:', session.id, 'status:', session.status);
    res.json(session);
  } catch (err: any) {
    console.error('[TokenPay] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to process token payment' });
  }
});
