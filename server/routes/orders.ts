/**
 * Order management routes – merchant refuse (full void + wallet credit),
 * system cancel (no-driver, full wallet credit), edit-hold, commission,
 * status. End users CANNOT cancel orders directly — their only refund
 * path is the complaint flow (server/routes/complaints.ts), which always
 * credits the customer wallet and never issues a card refund.
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';
import { cancelPayment } from '../services/payment';
import { sendOrderReceipt } from '../services/receipt';
import { earnPoints } from './loyalty';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { requireNooksInternalRequest } from '../utils/nooksInternal';
import { creditWalletForRefund } from './wallet';

export const ordersRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOOKS_COMMISSION_RATE = 0;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const NOOKS_API_BASE_URL = (process.env.NOOKS_API_BASE_URL || process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '').trim().replace(/\/+$/, '');
const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

/* ── Push notification helper ── */
async function sendPushToCustomer(
  customerId: string,
  title: string,
  body: string,
  merchantId?: string,
) {
  if (!supabaseAdmin) return;
  try {
    // CRITICAL multi-tenant scoping: same Supabase auth.uid is shared
    // across every merchant's white-label app, so a customer with
    // Mafasa AND GrindHouse installed has TWO push_subscriptions rows
    // under the same user_id. Without merchant scoping, an
    // "Order Cancelled" push for a Mafasa order fans out to both apps
    // — confused customer, duplicate notifications, brand confusion.
    //
    // merchantId is optional only because a few legacy callers haven't
    // been updated yet. Always pass it when you know it.
    let q = supabaseAdmin.from('push_subscriptions').select('expo_push_token').eq('user_id', customerId);
    if (merchantId) q = q.eq('merchant_id', merchantId);
    const { data: subs } = await q;
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

import { debitWalletForOrder } from './wallet';

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
      promoDiscountSar,
      promoScope,
      customerNote,
      carDetails,
      relayToNooks,
      loyaltyDiscountSar,
      walletAmountSar,
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

    // ─── Defense-in-depth: per-item price floor + total sanity ───
    // Audit Tier 1 #1: client-supplied total_sar can be tampered to
    // place orders for far less than the items are actually worth (the
    // wallet-only path skips Moyasar's amount-mismatch check entirely).
    // Full server-side recompute against the merchant menu requires
    // nooksweb integration that's still pending. Until that lands, this
    // floor catches the obvious tampering: each item must have a unit
    // price ≥ 0.50 SAR (no SAR-cent F&B item exists in the real world)
    // and the total must be at least items.length * 0.50 (no tampered
    // total can claim a 0.01 SAR order with 50 items in cart).
    const MIN_ITEM_PRICE_SAR = 0.5;
    let computedItemFloor = 0;
    for (const it of items as Array<{ price?: unknown; quantity?: unknown; basePrice?: unknown }>) {
      const unitPrice = Number(it.basePrice ?? it.price ?? 0);
      const qty = Math.max(1, Math.floor(Number(it.quantity ?? 1)));
      if (!Number.isFinite(unitPrice) || unitPrice < MIN_ITEM_PRICE_SAR) {
        return res.status(400).json({
          error: `Item price below the ${MIN_ITEM_PRICE_SAR} SAR per-unit floor; refusing to commit a likely-tampered order.`,
        });
      }
      computedItemFloor += unitPrice * qty;
    }
    // The server's lower-bound computed floor ignores discounts (promo,
    // loyalty, wallet) so the comparison is "does the claimed total at
    // least cover the per-item baseline minus reasonable discounts?"
    // We allow up to 95% discount stack (promo + loyalty + wallet) before
    // rejecting — anything below that is impossible-to-justify on real
    // pricing. Production-grade fix is server menu re-compute; this is
    // a stop-gap that closes the >95% drain attack.
    const MAX_DISCOUNT_RATIO = 0.95;
    const minAcceptableTotal = computedItemFloor * (1 - MAX_DISCOUNT_RATIO);
    if (Number(totalSar) < minAcceptableTotal - 0.01) {
      return res.status(400).json({
        error: `Order total ${totalSar} is implausibly low for ${items.length} item(s) with floor ${computedItemFloor.toFixed(2)} SAR; refusing to commit.`,
      });
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

    // Wallet credit: applied to the order BEFORE saving it. Two
    // shapes the client can send:
    //   - paymentMethod === 'wallet'        → wallet covers the full
    //                                         total (legacy shape from
    //                                         when the wallet was a
    //                                         payment-method choice).
    //   - walletAmountSar > 0 (any method)  → wallet covers a portion
    //                                         and the chosen card /
    //                                         Apple Pay covers the
    //                                         remainder. The wallet
    //                                         debit lives in the
    //                                         ledger keyed by order_id;
    //                                         /token-pay reads it back
    //                                         to subtract from the
    //                                         card charge.
    // Either way the SQL function throws 'INSUFFICIENT_WALLET_BALANCE'
    // if the balance can't cover the requested amount, and the debit
    // is idempotent on (order_id, customer, merchant) — a retry of
    // this commit returns the same wallet transaction instead of
    // double-debiting.
    let walletPaymentId: string | null = null;
    let walletAppliedSar = 0;
    if (paymentMethod === 'wallet') {
      walletAppliedSar = Number(totalSar);
    } else if (typeof walletAmountSar === 'number' && walletAmountSar > 0) {
      // Cap to totalSar so a tampered client can't pull more wallet
      // credit than the order is worth.
      walletAppliedSar = Math.min(Number(walletAmountSar), Number(totalSar));
    }

    if (walletAppliedSar > 0) {
      try {
        const { data: priorDebit } = await supabaseAdmin
          .from('customer_wallet_transactions')
          .select('id')
          .eq('customer_id', user.id)
          .eq('merchant_id', merchantId)
          .eq('order_id', id)
          .eq('entry_type', 'spend')
          .maybeSingle();
        if (priorDebit) {
          walletPaymentId = `wallet:${priorDebit.id}`;
        } else {
          const debit = await debitWalletForOrder({
            customerId: user.id,
            merchantId,
            amountSar: walletAppliedSar,
            orderId: id,
          });
          walletPaymentId = `wallet:${debit.transactionId}`;
        }
      } catch (e: any) {
        if (e?.message === 'INSUFFICIENT_WALLET_BALANCE') {
          return res.status(400).json({ error: 'INSUFFICIENT_WALLET_BALANCE' });
        }
        return res.status(500).json({ error: e?.message || 'Wallet debit failed' });
      }
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
      // Wallet-only payments don't have a Moyasar id — use the wallet
      // transaction id as the payment_id so audit / reconcile flows
      // still have a stable handle. For partial-wallet (= the wallet
      // covered some of the total but a card pays the rest), the
      // payment_id stays whatever the client sent or null until
      // /token-pay or the webhook lands the card id; the wallet debit
      // is still recorded in customer_wallet_transactions.order_id.
      payment_id:
        paymentMethod === 'wallet'
          ? walletPaymentId
          : (typeof paymentId === 'string' && paymentId.trim() ? paymentId.trim() : null),
      payment_method: typeof paymentMethod === 'string' && paymentMethod.trim() ? paymentMethod.trim() : null,
      car_details: orderType === 'drivethru' && carDetails && typeof carDetails === 'object' ? carDetails : null,
      // Per-order processing fee billed to the merchant (NOT to the
      // end customer — the customer's total never includes it). Recorded
      // at commit so cancelled / refused orders flip to 'cancelled' and
      // delivered orders flip to 'earned' downstream. Aggregated monthly
      // and invoiced to the merchant out-of-band. Pickup + delivery both
      // count; the customer-received handler only updates the status,
      // not the amount.
      commission_amount: 1,
      commission_rate: 0,
      commission_status: 'pending',
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
        promo_discount_sar:
          typeof promoDiscountSar === 'number' && Number.isFinite(promoDiscountSar) && promoDiscountSar > 0
            ? promoDiscountSar
            : null,
        promo_scope: promoScope === 'delivery' || promoScope === 'total' ? promoScope : null,
        customer_note: typeof customerNote === 'string' ? customerNote.trim() || null : null,
        loyalty_discount_sar: typeof loyaltyDiscountSar === 'number' && loyaltyDiscountSar > 0 ? loyaltyDiscountSar : null,
        // Wallet credit applied to this order (already debited from
        // the customer's wallet during commit). nooksweb shrinks
        // Foodics unit_prices proportionally so the POS total matches
        // what the customer actually paid (card portion + wallet).
        wallet_amount_sar:
          walletAppliedSar > 0 ? walletAppliedSar : null,
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

/**
 * Refund the order's full charge to the customer. Money goes back to the
 * card when Moyasar can void/refund the original payment (free void
 * within ~2h of capture, or 1-3-day refund afterwards). Only when that
 * fails — Moyasar 4xx, no payment_id (wallet-only payment), missing
 * config — do we fall back to crediting the in-app wallet.
 *
 * Previous behavior credited the wallet AND voided on Moyasar, which
 * double-refunded the customer (money back to card + wallet credit for
 * the same order). The new rule: exactly one refund destination per
 * order. Returned `refundMethod` is the source of truth for callers and
 * is persisted to customer_orders.refund_method.
 */
type RefundDestination = 'card' | 'wallet';
async function refundOrderToWallet(
  orderId: string,
  cancelledBy: 'merchant' | 'system',
  reason: string,
): Promise<
  | { ok: true; orderId: string; refundedSar: number; refundMethod: RefundDestination }
  | { ok: false; error: string; status: number }
> {
  if (!supabaseAdmin) return { ok: false, error: 'Database not configured', status: 500 };

  const { data: order, error: fetchErr } = await supabaseAdmin
    .from('customer_orders')
    .select('*')
    .eq('id', orderId)
    .single();
  if (fetchErr || !order) return { ok: false, error: 'Order not found', status: 404 };
  if (order.status === 'Cancelled' || order.status === 'Delivered') {
    return { ok: false, error: `Cannot cancel order with status: ${order.status}`, status: 400 };
  }
  if (!order.customer_id || !order.merchant_id) {
    return { ok: false, error: 'Order is missing customer_id or merchant_id', status: 500 };
  }

  // Try Moyasar void/refund first. If it succeeds the money goes back to
  // the card (~2h for void, 1-3d for refund) and we MUST NOT also credit
  // the wallet — that's a double refund. Wallet credit is the fallback
  // for when Moyasar can't return the money to the card.
  let moyasarMethod: 'void' | 'refund' | 'failed' | 'skipped' = 'skipped';
  if (order.payment_id) {
    try {
      const result = await cancelPayment(order.payment_id, undefined, order.merchant_id);
      moyasarMethod = result.method;
      console.log('[Orders] Moyasar cancel result for', order.payment_id, ':', result.method);
    } catch (e: any) {
      moyasarMethod = 'failed';
      console.warn('[Orders] Moyasar cancel threw:', e?.message);
    }
  }

  const refundedToCard = moyasarMethod === 'void' || moyasarMethod === 'refund';
  const refundMethod: RefundDestination = refundedToCard ? 'card' : 'wallet';
  const refundSar = Number(order.total_sar ?? 0);

  // Wallet credit only fires when card refund was NOT possible. Idempotent
  // on the wallet RPC side via (customer_id, order_id, entry_type='refund').
  if (!refundedToCard && refundSar > 0) {
    try {
      await creditWalletForRefund({
        customerId: order.customer_id,
        merchantId: order.merchant_id,
        amountSar: refundSar,
        orderId,
        complaintId: null,
        note: `Order ${cancelledBy === 'merchant' ? 'refused' : 'auto-cancelled'}: ${reason}`.slice(0, 200),
      });
    } catch (e: any) {
      console.error('[Orders] Wallet credit failed for', orderId, ':', e?.message);
      return { ok: false, error: e?.message || 'Wallet credit failed', status: 500 };
    }
  }

  const { error: updateErr } = await supabaseAdmin
    .from('customer_orders')
    .update({
      status: 'Cancelled',
      cancellation_reason: reason,
      cancelled_by: cancelledBy,
      refund_status: 'refunded',
      refund_amount: refundSar,
      refund_fee: 0,
      refund_method: refundMethod,
      commission_status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId);
  if (updateErr) return { ok: false, error: updateErr.message, status: 500 };

  // Tell Foodics the order is cancelled so the kitchen stops cooking.
  // Best-effort — a Foodics outage must NOT roll back the refund we just
  // issued. The customer is already whole; if Foodics drops the call, the
  // merchant can void manually in the Foodics console (which already
  // triggers the inverse webhook). audit_log on the nooksweb side
  // records every attempt so ops can spot drift.
  if (NOOKS_API_BASE_URL && NOOKS_INTERNAL_SECRET) {
    fetch(`${NOOKS_API_BASE_URL}/api/public/orders/cancel-foodics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
      },
      body: JSON.stringify({ internalOrderId: orderId, reason }),
    })
      .then(async (resp) => {
        if (!resp.ok) {
          console.warn('[Orders] Foodics cancel relay non-2xx:', resp.status);
        }
      })
      .catch((e) => {
        console.warn('[Orders] Foodics cancel relay failed (non-blocking):', e?.message);
      });
  }

  const lead =
    cancelledBy === 'merchant'
      ? 'Your order has been refused by the store.'
      : "We couldn't dispatch a driver for your order.";
  const refundLine =
    refundMethod === 'card'
      ? moyasarMethod === 'void'
        ? `${refundSar} SAR will be returned to your card within a few hours.`
        : `${refundSar} SAR is being returned to your card and will arrive within 1-3 business days.`
      : `${refundSar} SAR has been credited to your wallet — use it on your next order.`;
  sendPushToCustomer(order.customer_id, 'Order Cancelled', `${lead} ${refundLine}`, order.merchant_id);

  return { ok: true, orderId, refundedSar: refundSar, refundMethod };
}

/* ═══════════════════════════════════════════════════════════════════
   MERCHANT REFUSE – merchant declines the order BEFORE preparation. Voids
   the Moyasar auth and credits the FULL order total to the customer's
   wallet. Replaces the previous merchant-cancel route which accepted an
   uncapped `amount` from the body and could refund > order total.
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/:id/merchant-refuse', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const orderId = req.params.id;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!orderId) return res.status(400).json({ error: 'Missing order ID' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const result = await refundOrderToWallet(orderId, 'merchant', reason);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ success: true, orderId: result.orderId, refundedSar: result.refundedSar, refundMethod: result.refundMethod });
  } catch (err: any) {
    console.error('[Orders] merchant-refuse error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to refuse order' });
  }
});

/**
 * BACKWARDS COMPATIBILITY: keep /merchant-cancel as an alias for
 * merchant-refuse so any in-flight nooksweb deploys / queued requests
 * still work during the cutover. The body's old `amount` parameter is
 * now ignored — refunds are always for the full order total per the
 * "all refunds go to the wallet" policy.
 */
ordersRouter.post('/:id/merchant-cancel', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const orderId = req.params.id;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!orderId) return res.status(400).json({ error: 'Missing order ID' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const result = await refundOrderToWallet(orderId, 'merchant', reason);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ success: true, orderId: result.orderId, refundedSar: result.refundedSar, refundMethod: result.refundMethod });
  } catch (err: any) {
    console.error('[Orders] merchant-cancel (alias) error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to cancel order' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   CUSTOMER CANCEL — REMOVED. End users CANNOT cancel orders directly
   per the platform policy. Their only refund path is the complaint
   flow at /api/complaints/:orderId, which credits the customer wallet
   after merchant approval. The old route is gone (any client trying
   to call it gets a 404, which the mobile app handles as "contact the
   store").
   ═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   SYSTEM CANCEL – auto-cancel when no driver / kitchen unavailable.
   Same wallet-credit path as merchant-refuse.
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/:id/system-cancel', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const orderId = req.params.id;
    const reason = (req.body?.reason as string) || 'No delivery driver found within time limit';
    const result = await refundOrderToWallet(orderId, 'system', reason);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ success: true, orderId: result.orderId, refundedSar: result.refundedSar, refundMethod: result.refundMethod });
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
    // Flat 1 SAR per order — same as the Delivered write upstream.
    // Orders delivered before the rate change keep their recorded 0.5 value
    // (this fallback only kicks in for rows with a NULL commission_amount).
    const commissionAmount = order.commission_amount ?? 1;

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

    // canCustomerCancel + cancelTimeRemaining were exposed for the legacy
    // customer-cancel route. That route is gone — customers can no longer
    // cancel directly per platform policy. Return the flags as constant
    // false / 0 so any in-flight mobile build that still reads them shows
    // the cancel button as disabled (instead of crashing on undefined).
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
      canCustomerCancel: false,
      cancelTimeRemaining: 0,
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
    // Flat platform fee — 1 SAR per delivered order, invoiced to
    // the merchant at the next monthly renewal. Keep in sync with
    // the Foodics webhook's Delivered transition in nooksweb.
    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({
        status: 'Delivered',
        delivered_at: now,
        commission_status: 'earned',
        commission_amount: 1,
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
      order.merchant_id ?? undefined,
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
      const mid = order.merchant_id ?? undefined;
      if (status === 'Ready') {
        sendPushToCustomer(order.customer_id, 'Order Ready!', 'Your order is ready for pickup.', mid);
      } else if (status === 'Out for delivery') {
        sendPushToCustomer(order.customer_id, 'Order On The Way!', 'Your order is out for delivery.', mid);
      } else if (status === 'Delivered') {
        sendPushToCustomer(order.customer_id, 'Order Delivered', 'Your order has been delivered. Enjoy!', mid);
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
