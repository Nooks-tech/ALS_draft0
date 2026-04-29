import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { calculateCommission, calculateMoyasarFee, normalizeMerchantId, paymentService } from '../services/payment';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { hasProcessedWebhookEvent, recordWebhookEvent } from '../utils/webhookIdempotency';
import { paymentRateLimit, webhookRateLimit } from '../utils/rateLimit';

/** Constant-time string comparison; safe to call with strings of any length. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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

paymentRouter.post('/initiate', paymentRateLimit, async (req, res) => {
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
paymentRouter.post('/webhook', webhookRateLimit, async (req, res) => {
  try {
    const payload = req.body;
    const eventType: string = String(payload.type ?? payload.event ?? '').toLowerCase();
    // Moyasar fires separate event streams for payments and invoices. We
    // only care about the payment-level events here (paid, captured,
    // voided, refunded). Invoice-level events (invoice_*) carry an invoice
    // id in `id`, which causes our `/v1/payments/{id}` re-verify call to
    // 404 and pollutes the logs. Ack them and move on — the matching
    // payment_* event arrives separately.
    if (eventType.startsWith('invoice_')) {
      console.log('[Payment Webhook] Ignoring invoice-level event:', eventType);
      return res.json({ received: true, ignored: true, reason: 'invoice_event' });
    }
    const id: string = payload.id ?? payload.data?.id ?? '';
    let status: string = payload.status ?? payload.data?.status ?? '';
    const metadata = payload.metadata ?? payload.data?.metadata ?? {};
    // Moyasar's source object is loosely typed (differs per payment method).
    // Typed as any to preserve the existing card-token / card-metadata reads
    // downstream without having to enumerate every field Moyasar may send.
    let source: any = payload.source ?? payload.data?.source ?? {};
    const merchantId: string = metadata?.merchant_id ?? '';
    if (!merchantId) {
      console.warn('[Payment Webhook] Missing merchant_id metadata');
      return res.status(400).json({ error: 'merchant_id metadata is required' });
    }

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    const merchantSecretKey = runtimeConfig.secretKey;
    const platformSecretKey = (process.env.MOYASAR_SECRET_KEY || '').trim();

    if (!merchantSecretKey && !platformSecretKey) {
      return res.status(503).json({ error: 'Merchant Moyasar secret key is not configured' });
    }
    if (!id) {
      return res.status(400).json({ error: 'payment id is required' });
    }

    // Webhook bodies are untrusted — Moyasar doesn't sign them, and the
    // optional "secret_token" field is a weak shared-secret at best. Instead
    // we verify the payment by calling Moyasar's own API with the merchant's
    // secret key (which we already store to process payments). A forged body
    // with status=paid can't survive this check because Moyasar will return
    // the real payment state, or 401/403 if the payment doesn't belong to
    // this merchant's account.
    //
    // Sandbox note: Moyasar's public sandbox publishable key
    // (`pk_test_ciMvyPA...`) belongs to a shared Moyasar demo account, not
    // the merchant's own account. Verifying those payments with a merchant
    // secret key returns 404 every time. If the merchant secret 404s we
    // fall back to a platform-level key so sandbox testing still verifies.
    const tryVerify = async (key: string) =>
      fetch(`https://api.moyasar.com/v1/payments/${encodeURIComponent(id)}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
          Accept: 'application/json',
        },
      });

    let verifyRes: Response | null = null;
    if (merchantSecretKey) {
      verifyRes = await tryVerify(merchantSecretKey);
    }
    if (
      platformSecretKey &&
      (!verifyRes || [401, 403, 404].includes(verifyRes.status))
    ) {
      const platformRes = await tryVerify(platformSecretKey);
      if (platformRes.ok) verifyRes = platformRes;
      else if (!verifyRes) verifyRes = platformRes;
    }
    if (!verifyRes) {
      return res.status(503).json({ error: 'No Moyasar secret key available to verify' });
    }

    if (verifyRes.status === 401 || verifyRes.status === 403 || verifyRes.status === 404) {
      // Log at info level — the common cause is a sandbox publishable key
      // on the mobile app that isn't paired with any secret we hold. That's
      // expected during dev testing and shouldn't look like an error.
      console.info('[Payment Webhook] Moyasar disowns this payment:', {
        httpStatus: verifyRes.status,
        paymentId: id,
        eventType,
        merchantId,
        hint:
          'Most likely the mobile app used a shared-sandbox publishable key (pk_test_ciMvyPA...) whose secret we do not have. Configure per-merchant test keys in the dashboard to verify webhook payloads during sandbox testing.',
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!verifyRes.ok) {
      console.warn('[Payment Webhook] Moyasar verify failed:', verifyRes.status);
      return res.status(502).json({ error: 'Could not verify payment with Moyasar' });
    }
    const verified = (await verifyRes.json()) as {
      id?: string;
      status?: string;
      amount?: number;
      source?: { company?: string; token?: { id?: string; brand?: string; last_four?: string; format?: string } };
      metadata?: Record<string, string>;
    };

    const verifiedMerchantId = (verified.metadata?.merchant_id ?? '').trim();
    if (verifiedMerchantId && verifiedMerchantId !== merchantId) {
      console.warn('[Payment Webhook] merchant_id mismatch between webhook and Moyasar:', {
        webhook: merchantId,
        moyasar: verifiedMerchantId,
      });
      return res.status(400).json({ error: 'merchant_id mismatch' });
    }

    // Trust only Moyasar's authoritative response from here on. If the
    // webhook body tried to lie about status/amount/source, it's ignored.
    status = String(verified.status ?? status ?? '').toLowerCase();
    if (verified.amount != null) payload.amount = verified.amount;
    source = { ...source, ...(verified.source ?? {}) };

    console.log('[Payment Webhook]', { id, status, orderId: metadata?.order_id, merchantId, company: source?.company });
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Idempotency: ignore retries from Moyasar (they retry 5x over ~3.5 hours on non-2xx).
    // Use Moyasar event id when present, fall back to (payment id + status) for older payloads.
    const eventId = String(payload.id ?? `${id}:${status}`);
    if (await hasProcessedWebhookEvent('moyasar', eventId)) {
      console.log('[Payment Webhook] Duplicate event, skipping:', eventId);
      return res.json({ received: true, duplicate: true });
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

      // Validate payment amount matches order total (prevent tampered webhooks).
      // Compare in halalas (integers) with 1-halala tolerance for legitimate rounding only.
      if ((status === 'paid' || status === 'captured') && order.total_sar != null) {
        const webhookAmountHalals = Number(payload.amount ?? payload.data?.amount ?? 0);
        const expectedHalals = Math.round(Number(order.total_sar) * 100);
        if (Math.abs(webhookAmountHalals - expectedHalals) > 1) {
          console.error('[Payment Webhook] Amount mismatch!', {
            webhookHalals: webhookAmountHalals,
            expectedHalals,
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

    await recordWebhookEvent('moyasar', eventId, { paymentId: id, status, merchantId });
    res.json({ received: true });
  } catch (err: any) {
    console.error('[Payment Webhook] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to process webhook' });
  }
});

/* ─── Saved Cards (Tokenization) ─── */

/**
 * POST /api/payment/saved-cards/attach
 * body: { merchantId, token }
 *
 * Attach a Moyasar token (created client-side via /v1/tokens with
 * save_only=true and the merchant's publishable key) to the
 * authenticated customer. Re-fetches the token from Moyasar with the
 * SECRET key so we can:
 *   1) confirm the token actually exists and is owned by this merchant,
 *   2) read brand/last_four/name/expiry from the canonical source
 *      rather than trusting the client.
 *
 * Idempotent on (customer_id, merchant_id, token) — re-attaching the
 * same token returns the existing card row instead of duplicating.
 */
paymentRouter.post('/saved-cards/attach', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const merchantId = typeof req.body?.merchantId === 'string' ? req.body.merchantId.trim() : '';
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!token) return res.status(400).json({ error: 'token required' });

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    const secretKey = runtimeConfig.secretKey;
    if (!secretKey) {
      return res.status(503).json({ error: 'Moyasar secret key is not configured for this merchant' });
    }

    // Verify the token actually exists in Moyasar before we trust the
    // brand/last_four claims the client sent.
    const tokenRes = await fetch(`https://api.moyasar.com/v1/tokens/${encodeURIComponent(token)}`, {
      headers: { Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}` },
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      return res.status(502).json({ error: `Moyasar token lookup failed (${tokenRes.status}): ${text.slice(0, 200)}` });
    }
    const tokenData: any = await tokenRes.json();
    if (tokenData?.status && tokenData.status !== 'active' && tokenData.status !== 'verified') {
      return res.status(400).json({
        error: `Token status is ${tokenData.status} — only active/verified tokens can be saved.`,
      });
    }

    const { data: existing } = await supabaseAdmin
      .from('customer_saved_cards')
      .select('id, brand, last_four, name, expires_month, expires_year')
      .eq('customer_id', user.id)
      .eq('merchant_id', merchantId)
      .eq('token', token)
      .maybeSingle();
    if (existing) {
      return res.json({ ...existing, already_saved: true });
    }

    const brand = (tokenData.brand ?? '').toString().toLowerCase() || null;
    const last_four = tokenData.last_four ?? null;
    const name = tokenData.name ?? null;
    const expires_month = tokenData.month ? Number(tokenData.month) : null;
    const expires_year = tokenData.year ? Number(tokenData.year) : null;

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('customer_saved_cards')
      .insert({
        customer_id: user.id,
        merchant_id: merchantId,
        token,
        brand,
        last_four,
        name,
        expires_month,
        expires_year,
      })
      .select('id, brand, last_four, name, expires_month, expires_year')
      .single();
    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    res.json({ ...inserted, already_saved: false });
  } catch (err: any) {
    console.error('[SavedCards] Attach error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to save card' });
  }
});

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
