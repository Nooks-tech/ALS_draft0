/**
 * Order management routes – merchant cancel/refund, customer cancel (60s grace),
 * system cancel (no-driver), edit-hold, commission, status
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';
import { cancelPayment } from '../services/payment';
import { sendOrderReceipt } from '../services/receipt';
import { earnPoints } from './loyalty';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { requireNooksInternalRequest } from '../utils/nooksInternal';

export const ordersRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOOKS_COMMISSION_RATE = 0;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const CUSTOMER_CANCEL_WINDOW_MS = 60_000; // 60 seconds
const NOOKS_API_BASE_URL = (process.env.NOOKS_API_BASE_URL || process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '').trim().replace(/\/+$/, '');
const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

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

// OTO dispatch was retired on 2026-04-19 in favour of Foodics DMS. Legacy
// orders with a non-null oto_id still exist in the DB but the OTO service
// itself is gone, so cancelling them there is a no-op — we just skip
// dispatch-side cancellation and let the refund logic below run.

async function relayOrderToNooks(payload: Record<string, unknown>) {
  if (!NOOKS_API_BASE_URL) {
    throw new Error('NOOKS_API_BASE_URL is not configured');
  }
  if (!NOOKS_INTERNAL_SECRET) {
    throw new Error('NOOKS_INTERNAL_SECRET is not configured');
  }

  const response = await fetch(`${NOOKS_API_BASE_URL}/api/public/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to relay order to nooks');
  }
  return data;
}

ordersRouter.post('/relay-to-nooks', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!NOOKS_API_BASE_URL) {
      return res.status(503).json({ error: 'NOOKS_API_BASE_URL is not configured' });
    }
    if (!NOOKS_INTERNAL_SECRET) {
      return res.status(503).json({ error: 'NOOKS_INTERNAL_SECRET is not configured' });
    }

    const body = req.body ?? {};
    if (body.customer_id && body.customer_id !== user.id) {
      return res.status(403).json({ error: 'customer_id does not match authenticated user' });
    }
    if (!body.merchant_id || !body.branch_id || typeof body.total_sar !== 'number' || !Array.isArray(body.items)) {
      return res.status(400).json({ error: 'merchant_id, branch_id, total_sar, and items are required' });
    }

    const relayPayload = {
      ...body,
      customer_id: user.id,
    };

    const data = await relayOrderToNooks(relayPayload);

    res.json({ success: true, relayed: true, data });
  } catch (err: any) {
    console.error('[Orders] relay-to-nooks error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to relay order' });
  }
});

ordersRouter.post('/commit', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const {
      id,
      merchantId,
      branchId,
      branchName,
      totalSar,
      status,
      items,
      orderType,
      deliveryAddress,
      deliveryLat,
      deliveryLng,
      deliveryCity,
      deliveryFee,
      paymentId,
      paymentMethod,
      otoId,
      customerName,
      customerPhone,
      customerEmail,
      promoCode,
      carDetails,
      relayToNooks,
      loyaltyDiscountSar,
    } = req.body ?? {};

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required' });
    }
    if (!merchantId || typeof merchantId !== 'string') {
      return res.status(400).json({ error: 'merchantId is required' });
    }
    if (!branchId || typeof branchId !== 'string') {
      return res.status(400).json({ error: 'branchId is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items are required' });
    }
    if (typeof totalSar !== 'number' || !Number.isFinite(totalSar) || totalSar < 0) {
      return res.status(400).json({ error: 'totalSar must be a valid non-negative number' });
    }
    if (orderType !== 'delivery' && orderType !== 'pickup' && orderType !== 'drivethru') {
      return res.status(400).json({ error: 'orderType must be delivery, pickup, or drivethru' });
    }

    // Subscription enforcement: reject orders for suspended merchants
    if (supabaseAdmin) {
      const { data: merchantRow } = await supabaseAdmin
        .from('merchants')
        .select('status')
        .eq('id', merchantId)
        .maybeSingle();
      if (merchantRow?.status === 'suspended') {
        return res.status(403).json({ error: 'Merchant is currently suspended. Orders cannot be placed.' });
      }
    }

    // Default to 'Placed' so the stepper's first step is active the moment the
    // row lands. Foodics webhooks then advance it: 2 (Active) → 'Accepted'.
    const normalizedStatus =
      typeof status === 'string' && status.trim()
        ? status.trim()
        : 'Placed';
    const normalizedDeliveryFee =
      typeof deliveryFee === 'number' && Number.isFinite(deliveryFee) ? deliveryFee : null;

    const { data: existing } = await supabaseAdmin
      .from('customer_orders')
      .select('id, customer_id, merchant_id')
      .eq('id', id)
      .maybeSingle();

    if (existing && (existing.customer_id !== user.id || existing.merchant_id !== merchantId)) {
      return res.status(403).json({ error: 'Order does not belong to the authenticated user' });
    }

    const payload: Record<string, unknown> = {
      id,
      merchant_id: merchantId,
      branch_id: branchId,
      branch_name: typeof branchName === 'string' && branchName.trim() ? branchName.trim() : null,
      customer_id: user.id,
      total_sar: totalSar,
      status: normalizedStatus,
      items,
      order_type: orderType,
      delivery_address: typeof deliveryAddress === 'string' ? deliveryAddress : null,
      delivery_lat: typeof deliveryLat === 'number' ? deliveryLat : null,
      delivery_lng: typeof deliveryLng === 'number' ? deliveryLng : null,
      delivery_city: typeof deliveryCity === 'string' ? deliveryCity : null,
      oto_id: typeof otoId === 'number' ? otoId : null,
      delivery_fee: normalizedDeliveryFee,
      payment_id: typeof paymentId === 'string' && paymentId.trim() ? paymentId.trim() : null,
      payment_method: typeof paymentMethod === 'string' && paymentMethod.trim() ? paymentMethod.trim() : null,
      car_details: orderType === 'drivethru' && carDetails && typeof carDetails === 'object' ? carDetails : null,
      updated_at: new Date().toISOString(),
    };

    const { data: savedOrder, error: commitError } = await supabaseAdmin
      .from('customer_orders')
      .upsert(payload, { onConflict: 'id' })
      .select('id, status, payment_id, created_at, updated_at')
      .single();

    if (commitError || !savedOrder) {
      return res.status(500).json({ error: commitError?.message || 'Failed to commit order' });
    }

    let relayResult: unknown = null;
    if (relayToNooks === true && payload.payment_id) {
      relayResult = await relayOrderToNooks({
        id,
        merchant_id: merchantId,
        branch_id: branchId,
        customer_id: user.id,
        total_sar: totalSar,
        status: normalizedStatus,
        order_type: orderType,
        branch_name: payload.branch_name,
        delivery_fee: normalizedDeliveryFee,
        payment_id: payload.payment_id,
        payment_method: payload.payment_method,
        customer_name: typeof customerName === 'string' ? customerName.trim() || null : null,
        customer_phone: typeof customerPhone === 'string' ? customerPhone.trim() || null : null,
        customer_email: typeof customerEmail === 'string' ? customerEmail.trim() || null : null,
        promo_code: typeof promoCode === 'string' ? promoCode.trim() || null : null,
        loyalty_discount_sar: typeof loyaltyDiscountSar === 'number' && loyaltyDiscountSar > 0 ? loyaltyDiscountSar : null,
        delivery_address: payload.delivery_address,
        delivery_lat: payload.delivery_lat,
        delivery_lng: payload.delivery_lng,
        delivery_city: payload.delivery_city,
        items: items.map((item: any) => {
          // Foodics expects the product's own unit_price here, and gets each
          // modifier's surcharge via the separate options[] array. If we sent
          // the already-summed display price, Foodics would add the modifier
          // prices on top again and the merchant POS total would diverge
          // from what the customer paid. Prefer basePrice (stamped by the
          // product screen) and fall back to price-minus-customizations for
          // older carts that still hold only the summed price.
          const rawBase =
            item.basePrice ?? item.base_price ?? item.unitBasePrice ?? null;
          let basePrice: number;
          if (typeof rawBase === 'number' && Number.isFinite(rawBase)) {
            basePrice = rawBase;
          } else {
            const customizations = item.customizations ?? {};
            const modifierSum = Object.values(customizations).reduce(
              (sum: number, opt: any) => sum + Number(opt?.price ?? 0),
              0,
            );
            basePrice = Math.max(
              0,
              Number(item.price ?? item.price_sar ?? 0) - Number(modifierSum || 0),
            );
          }
          return {
            product_id: String(item.id ?? item.product_id ?? ''),
            name: String(item.name ?? 'Item'),
            quantity: Number(item.quantity ?? 1),
            price_sar: basePrice,
            ...(item.customizations ? { customizations: item.customizations } : {}),
          };
        }),
      });

      // Store Foodics order ID from relay response (fire-and-forget)
      const relayData = relayResult as { foodics?: { ok?: boolean; foodicsOrderId?: string } } | null;
      if (relayData?.foodics?.ok && relayData.foodics.foodicsOrderId) {
        Promise.resolve(
          supabaseAdmin
            .from('customer_orders')
            .update({ foodics_order_id: relayData.foodics.foodicsOrderId })
            .eq('id', id)
        )
          .then(() => console.log(`[Orders] Stored foodics_order_id for ${id}`))
          .catch((e: any) => console.warn('[Orders] Failed to store foodics_order_id:', e?.message));
      }
    }

    // Fire the customer receipt — ZATCA-style, 15% VAT breakdown. Fire-
    // and-forget so a Resend outage can't block the order response.
    if (customerEmail && typeof customerEmail === 'string' && customerEmail.trim()) {
      void sendOrderReceipt({
        orderId: id,
        merchantId,
        customerEmail: customerEmail.trim(),
        customerName: typeof customerName === 'string' ? customerName.trim() : null,
        totalSar,
        deliveryFeeSar: normalizedDeliveryFee,
        items: items.map((item: any) => ({
          name: String(item.name ?? 'Item'),
          quantity: Number(item.quantity ?? 1),
          price_sar: Number(item.price ?? item.price_sar ?? 0),
        })),
        orderType,
        branchName: typeof branchName === 'string' ? branchName.trim() : null,
        paymentMethod: typeof paymentMethod === 'string' ? paymentMethod.trim() : null,
        paymentId: typeof paymentId === 'string' ? paymentId.trim() : null,
      });
    }

    res.json({ success: true, order: savedOrder, relayResult });
  } catch (err: any) {
    console.error('[Orders] commit error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to commit order' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   MERCHANT CANCEL – void-first refund + OTO cancel + fee tracking
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/:id/merchant-cancel', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

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

    const shouldRefund = refund !== false;
    let refundStatus = 'none';
    let refundId: string | null = null;
    let refundFee = 0;
    let refundMethod: string | null = null;
    const refundAmountSAR = amount != null ? Number(amount) : order.total_sar;
    const refundAmountHalals = amount != null ? Math.round(Number(amount) * 100) : undefined;

    if (shouldRefund && order.payment_id) {
      const result = await cancelPayment(order.payment_id, refundAmountHalals, order.merchant_id);
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
        commission_status: 'cancelled',
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
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .eq('customer_id', user.id)
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
      // Customer can cancel only while the merchant hasn't started preparing
      // the order yet. "Placed" and "Accepted" are both pre-kitchen states.
      if (!['Placed', 'Accepted', 'Pending', 'Preparing'].includes(order.status)) {
        return res.status(400).json({
          error: 'Cannot cancel — order preparation has already progressed.',
        });
      }
    }

    let refundStatus = 'none';
    let refundId: string | null = null;
    let refundFee = 0;
    let refundMethod: string | null = null;

    let refundError: string | undefined;
    if (order.payment_id) {
      console.log('[Orders] customer-cancel: attempting refund for payment_id:', order.payment_id);
      const result = await cancelPayment(order.payment_id, undefined, order.merchant_id);
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
        commission_status: 'cancelled',
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
    if (!requireNooksInternalRequest(req, res)) return;

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
        commission_status: 'cancelled',
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
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });

    const createdAt = new Date(order.created_at).getTime();
    const holdWindowMs = 5000;
    if (Date.now() - createdAt > holdWindowMs) {
      return res.status(400).json({ error: 'Edit window expired', windowExpired: true });
    }
    if (!['Placed', 'Accepted', 'Pending', 'Preparing'].includes(order.status)) {
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
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('customer_id, status')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({ status: 'Placed', updated_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('status', 'On Hold');

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ success: true, orderId, status: 'Placed' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to resume order' });
  }
});

/* ── Commission ── */
ordersRouter.get('/:id/commission', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

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
    // Flat 0.5 SAR per order — same as the Delivered write upstream.
    const commissionAmount = order.commission_amount ?? 0.5;

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
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('id, customer_id, status, cancellation_reason, cancelled_by, refund_status, refund_amount, refund_fee, refund_method, created_at, updated_at')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    const createdAt = new Date(order.created_at).getTime();
    const elapsed = Date.now() - createdAt;
    const canCustomerCancel =
      (['Placed', 'Accepted', 'Pending', 'Preparing'].includes(order.status) &&
        elapsed <= CUSTOMER_CANCEL_WINDOW_MS) ||
      order.status === 'On Hold';
    const cancelTimeRemaining = order.status === 'On Hold'
      ? CUSTOMER_CANCEL_WINDOW_MS
      : Math.max(0, CUSTOMER_CANCEL_WINDOW_MS - elapsed);

    res.json({
      id: order.id,
      status: order.status,
      cancellation_reason: order.cancellation_reason,
      cancelled_by: order.cancelled_by,
      refund_status: order.refund_status,
      refund_amount: order.refund_amount,
      refund_fee: order.refund_fee,
      refund_method: order.refund_method,
      created_at: order.created_at,
      updated_at: order.updated_at,
      canCustomerCancel,
      cancelTimeRemaining,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get order status' });
  }
});

/*
 * ── POST /api/orders/:id/customer-received ──
 *
 * Fallback for pickup orders where the cashier forgot to close the ticket
 * after handing the order over. The customer can tap "I received my order"
 * on the tracking screen after 45 minutes in Ready state — we stamp the
 * order as Delivered, fire the loyalty earn, and notify them.
 *
 * Refuses early presses (< 45 min since ready_at) and anything other than
 * a pickup order already in Ready.
 */
const CUSTOMER_RECEIVED_UNLOCK_MS = 45 * 60 * 1000;
ordersRouter.post('/:id/customer-received', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const orderId = req.params.id;
    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('id, customer_id, status, order_type, ready_at, total_sar, merchant_id')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.order_type !== 'pickup') {
      return res.status(400).json({ error: 'This action is only available for pickup orders' });
    }
    if (order.status !== 'Ready') {
      return res.status(400).json({ error: `Order must be in Ready state (currently ${order.status})` });
    }
    if (!order.ready_at) {
      return res.status(400).json({ error: 'Order has no ready timestamp yet' });
    }

    const readyAtMs = Date.parse(order.ready_at);
    if (!Number.isFinite(readyAtMs)) {
      return res.status(500).json({ error: 'Invalid ready_at timestamp' });
    }
    const elapsed = Date.now() - readyAtMs;
    if (elapsed < CUSTOMER_RECEIVED_UNLOCK_MS) {
      return res.status(400).json({
        error: 'Not available yet',
        unlocksInMs: CUSTOMER_RECEIVED_UNLOCK_MS - elapsed,
      });
    }

    const now = new Date().toISOString();
    // Flat platform fee — 0.5 SAR per delivered order, invoiced to
    // the merchant at the next monthly renewal. Keep in sync with
    // the Foodics webhook's Delivered transition in nooksweb.
    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'Delivered',
        delivered_at: now,
        commission_status: 'earned',
        commission_amount: 0.5,
        updated_at: now,
      })
      .eq('id', orderId)
      .eq('status', 'Ready');
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Fire loyalty earn (idempotency is enforced by the loyalty route itself).
    if (order.customer_id && order.merchant_id) {
      earnPoints(order.customer_id, order.id, order.total_sar ?? 0, order.merchant_id).catch(
        (e: any) => console.warn('[orders] customer-received loyalty earn failed:', e?.message),
      );
    }

    sendPushToCustomer(
      order.customer_id,
      'Order Received',
      'Thanks — we marked your pickup order as received.',
    ).catch(() => {});

    res.json({ success: true, status: 'Delivered' });
  } catch (err: any) {
    console.error('[orders] customer-received error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to mark received' });
  }
});

/* ── Update status (dashboard) ── */
ordersRouter.patch('/:id/status', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const orderId = req.params.id;
    const { status } = req.body;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    if (!status) return res.status(400).json({ error: 'status is required' });

    const validStatuses = ['Placed', 'Accepted', 'Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled', 'On Hold', 'Pending'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const { data: order } = await supabaseAdmin
      .from('customer_orders')
      .select('id, customer_id, status, total_sar, merchant_id')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const updatePayload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'Delivered') {
      updatePayload.delivered_at = new Date().toISOString();
    }

    const { error } = await supabaseAdmin
      .from('customer_orders')
      .update(updatePayload)
      .eq('id', orderId);

    if (error) return res.status(500).json({ error: error.message });

    if (order.customer_id) {
      if (status === 'Ready') {
        sendPushToCustomer(order.customer_id, 'Order Ready!', 'Your order is ready for pickup.');
      } else if (status === 'Out for delivery') {
        sendPushToCustomer(order.customer_id, 'Order On The Way!', 'Your order is out for delivery.');
      } else if (status === 'Delivered') {
        sendPushToCustomer(order.customer_id, 'Order Delivered', 'Your order has been delivered. Enjoy!');
        earnPoints(order.customer_id, orderId, order.total_sar ?? 0, order.merchant_id ?? '').catch(
          (e: any) => console.warn('[Orders] Auto-earn loyalty failed:', e?.message),
        );
      }
    }

    res.json({ success: true, orderId, status });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update status' });
  }
});

/* ── Diagnostic: check order payment + Moyasar status ── */
ordersRouter.get('/:id/debug-refund', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const orderId = req.params.id;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('id, merchant_id, payment_id, payment_method, refund_status, refund_id, total_sar, status')
      .eq('id', orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(order.merchant_id ?? null);
    const moyasarConfigured = !!runtimeConfig.secretKey;
    const result: Record<string, unknown> = {
      order,
      moyasarConfigured,
      paymentSource: runtimeConfig.source,
      moyasarKeyPrefix: runtimeConfig.secretKey ? runtimeConfig.secretKey.substring(0, 10) + '...' : 'NOT SET',
    };

    if (order.payment_id && runtimeConfig.secretKey) {
      const authHeader = `Basic ${Buffer.from(runtimeConfig.secretKey + ':').toString('base64')}`;

      // Try as payment
      try {
        const payRes = await fetch(`https://api.moyasar.com/v1/payments/${order.payment_id}`, {
          headers: { Authorization: authHeader },
        });
        result.paymentLookup = { status: payRes.status, body: await payRes.json().catch(() => null) };
      } catch (e: any) {
        result.paymentLookup = { error: e?.message };
      }

      // Try as invoice
      try {
        const invRes = await fetch(`https://api.moyasar.com/v1/invoices/${order.payment_id}`, {
          headers: { Authorization: authHeader },
        });
        result.invoiceLookup = { status: invRes.status, body: await invRes.json().catch(() => null) };
      } catch (e: any) {
        result.invoiceLookup = { error: e?.message };
      }
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

/* ── Export helpers for use in cron and complaints ── */
export { sendPushToCustomer, supabaseAdmin as ordersSupabaseAdmin };
