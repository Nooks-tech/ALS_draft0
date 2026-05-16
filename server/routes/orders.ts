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
import { cancelPayment, verifyPaidPayment } from '../services/payment';
import { sendOrderReceipt } from '../services/receipt';
import { earnPoints, restoreCashbackForRefund, restoreStampMilestonesForRefund } from './loyalty';
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

// ─── Customer-scoped /commit rate limit (Layer 3) ───
// A single Express process can see far more than 10 /commit calls
// per minute (multi-customer traffic), but per-customer 10/min is
// generously above any legitimate flow. A normal user fires 2
// commits per order (first + final) and orders 1 thing at a time;
// a tester might fire 6-8 across multiple attempts in a minute.
// This blocks a malicious or buggy client from rapid-firing 100s of
// commits to probe for residual exploit surface after Layer 1/2.
const COMMIT_RATE_LIMIT_PER_CUSTOMER_PER_MIN = 10;
const commitRateBuckets = new Map<string, { count: number; resetAt: number }>();
const commitRatePruneInterval: ReturnType<typeof setInterval> = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of commitRateBuckets.entries()) {
    if (b.resetAt < now) commitRateBuckets.delete(k);
  }
}, 5 * 60 * 1000);
(commitRatePruneInterval as unknown as { unref?: () => void }).unref?.();

function checkCommitRateLimit(customerId: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const bucket = commitRateBuckets.get(customerId);
  if (!bucket || bucket.resetAt < now) {
    commitRateBuckets.set(customerId, { count: 1, resetAt: now + 60_000 });
    return { allowed: true };
  }
  if (bucket.count >= COMMIT_RATE_LIMIT_PER_CUSTOMER_PER_MIN) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { allowed: true };
}

ordersRouter.post('/commit', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Layer 3: customer-scoped rate limit (per-process). Multi-instance
    // deployments should swap this for Redis, but Railway runs a
    // single Express dyno today so the in-memory map is fine.
    const rl = checkCommitRateLimit(user.id);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec ?? 60));
      return res.status(429).json({
        error: 'Too many order attempts. Please wait a moment and try again.',
        code: 'COMMIT_RATE_LIMIT',
        retryAfterSec: rl.retryAfterSec,
      });
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
      // Payment composition — used at cancel time to "rewind" each
      // source independently (cashback → cashback balance, stamps →
      // stamp counter + redemption row). Optional; legacy clients that
      // don't send these still commit fine, they just won't get
      // multi-source reversal on cancel.
      cashbackAmountSar,
      stampMilestoneIds,
      stampsConsumed,
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
    const rewardMilestoneIdsInCart: string[] = [];
    for (const it of items as Array<{ price?: unknown; quantity?: unknown; basePrice?: unknown; uniqueId?: unknown }>) {
      const unitPrice = Number(it.basePrice ?? it.price ?? 0);
      const qty = Math.max(1, Math.floor(Number(it.quantity ?? 1)));
      // Free stamp-milestone rewards have price=0 by design — the
      // customer pays nothing for them because they're redeeming
      // stamps. Identified by uniqueId='reward-<milestoneId>-<foodicsId>'.
      // Skip the per-item floor check for these; the floor only
      // protects against tampered REGULAR items.
      const isFreeReward =
        typeof it.uniqueId === 'string' && (it.uniqueId as string).startsWith('reward-');
      if (isFreeReward) {
        // Reward exploit defense: each redeemed milestone yields a
        // SINGLE free item. A cart entry with quantity > 1 means a
        // tampered client tried to multiply the freebie (or the
        // pre-2026-05-16 cart UI let a user bump it). Reject.
        if (qty !== 1) {
          return res.status(400).json({
            error: 'Reward items must be quantity 1. Each stamp milestone yields exactly one free item.',
            code: 'REWARD_QTY_INVALID',
          });
        }
        const uid = String(it.uniqueId ?? '');
        // uniqueId format: 'reward-<milestoneId>-<foodicsProductId>'.
        // Extract milestoneId so we can cross-check against the
        // stampMilestoneIds the client says it redeemed. Mismatched
        // counts = tampering (e.g., two reward items but only one
        // milestone redemption claimed).
        const milestoneMatch = uid.match(/^reward-([0-9a-f-]{36})-/i);
        if (milestoneMatch?.[1]) {
          if (rewardMilestoneIdsInCart.includes(milestoneMatch[1])) {
            return res.status(400).json({
              error: 'Duplicate reward for the same milestone in the cart.',
              code: 'REWARD_DUPLICATE_MILESTONE',
            });
          }
          rewardMilestoneIdsInCart.push(milestoneMatch[1]);
        }
        continue;
      }
      if (!Number.isFinite(unitPrice) || unitPrice < MIN_ITEM_PRICE_SAR) {
        return res.status(400).json({
          error: `Item price below the ${MIN_ITEM_PRICE_SAR} SAR per-unit floor; refusing to commit a likely-tampered order.`,
        });
      }
      computedItemFloor += unitPrice * qty;
    }
    // Cross-check: every reward item in the cart must correspond to
    // a milestone redemption the client claimed. The /commit body
    // carries stamp_milestone_ids — if the cart has more reward items
    // than the client says it redeemed, that's a free-item exploit
    // attempt. (Fewer is fine — a customer can redeem and then remove
    // the reward; the redemption stays usable for the next cart.)
    const claimedMilestones = Array.isArray(stampMilestoneIds)
      ? (stampMilestoneIds as unknown[]).filter((v) => typeof v === 'string')
      : [];
    if (rewardMilestoneIdsInCart.length > claimedMilestones.length) {
      return res.status(400).json({
        error: `Cart has ${rewardMilestoneIdsInCart.length} reward item(s) but only ${claimedMilestones.length} milestone redemption(s) claimed.`,
        code: 'REWARD_MILESTONE_MISMATCH',
      });
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

    // ─── Server-side Moyasar payment verification ───
    // The customer app fires commitOrder when the SDK reports
    // PaymentStatus.paid — that signal comes from the client and is
    // therefore untrustworthy. A buggy SDK build, a tampered client, or
    // an OS that delivers the success callback while Moyasar hasn't yet
    // captured the payment can all produce a paid-looking commit for
    // an unpaid Moyasar payment. We saw exactly this: a Moyasar
    // dashboard payment stuck in `initiated` while our DB row claimed
    // it was placed.
    //
    // Defense: for any card-like payment (paymentId is a Moyasar id,
    // not a wallet:* sentinel), GET the payment from Moyasar and
    // require status ∈ {paid, captured} AND amount matching the order
    // total. Reject otherwise — the row never gets created.
    //
    // Wallet-only / COD paths skip the Moyasar check: their paymentId
    // is either a `wallet:<txn>` sentinel (the wallet debit IS the
    // payment) or null (COD pays cash on delivery). For partial-wallet
    // orders the card still pays the remainder and Moyasar verifies
    // that portion below; we round the expected halalas to match.
    const trimmedPaymentId = typeof paymentId === 'string' ? paymentId.trim() : '';
    // 'wallet:<txn>' is the wallet-only sentinel. 'reward:<orderId>'
    // is the free-order sentinel for rewards-only orders where no
    // money is being charged at all (only stamp-milestone freebies).
    // Both skip Moyasar verification — there's no card payment to
    // verify against.
    const isMoyasarPaymentId =
      trimmedPaymentId
      && !trimmedPaymentId.startsWith('wallet:')
      && !trimmedPaymentId.startsWith('reward:');
    // Compute expected card portion (totalSar minus wallet portion).
    // Cashback / loyalty discounts are NOT subtracted here — the
    // discount is applied as a Foodics line on the POS side and
    // Moyasar charges the post-discount totalSar value the client
    // sent us (which the per-item floor above already sanity-checked).
    const cardPortionSar =
      paymentMethod === 'wallet'
        ? 0
        : typeof walletAmountSar === 'number' && walletAmountSar > 0
          ? Math.max(0, Number(totalSar) - Number(walletAmountSar))
          : Number(totalSar);
    const expectedHalalsForVerify = Math.round(cardPortionSar * 100);
    if (isMoyasarPaymentId && existing?.id !== id) {
      const verification = await verifyPaidPayment(trimmedPaymentId, expectedHalalsForVerify, merchantId);
      if (!verification.ok) {
        console.warn(
          '[Orders] Rejecting commit — Moyasar payment not paid:',
          trimmedPaymentId,
          verification.reason,
          'status:',
          verification.status,
        );
        return res.status(402).json({
          error: `Payment not confirmed (${verification.reason}). The order was not created.`,
          moyasarStatus: verification.status,
        });
      }
    }

    // ─── Side-effect gating: only on the FINAL commit ───
    // The customer app calls /commit twice:
    //   1) relayToNooks=false — registers the order intent. We verify
    //      Moyasar once but do NOT redeem the promo, debit the wallet,
    //      or stamp payment_confirmed_at. The draft row is invisible
    //      to both customer + merchant dashboards (foodics_order_id
    //      filter).
    //   2) relayToNooks=true — re-verifies Moyasar after a delay so
    //      transient 'paid' status can resolve, runs all side effects,
    //      relays to Foodics, and only then stamps the row as
    //      confirmed. If anything in here fails we reverse the side
    //      effects (refundOrderToWallet handles that path on Foodics
    //      failure; the verify-failed path skips them entirely).
    //
    // This is the structural fix for the abandoned-3DS leak the user
    // reported on 2026-05-16: closing the 3DS modal could leave a
    // Moyasar payment in 'initiated' but our verify caught a
    // transient 'paid' window and burned the promo + wallet credit
    // for an order that never reached Foodics.
    const isFinalCommit = relayToNooks === true;
    const trimmedPromoCode =
      typeof promoCode === 'string' && promoCode.trim() ? promoCode.trim().toUpperCase() : null;
    const promoScopeNormalized =
      promoScope === 'delivery' || promoScope === 'total' ? promoScope : null;
    const promoDiscountValue =
      typeof promoDiscountSar === 'number' && Number.isFinite(promoDiscountSar) && promoDiscountSar > 0
        ? promoDiscountSar
        : 0;

    let walletPaymentId: string | null = null;
    let walletAppliedSar = 0;
    if (paymentMethod === 'wallet') {
      walletAppliedSar = Number(totalSar);
    } else if (typeof walletAmountSar === 'number' && walletAmountSar > 0) {
      walletAppliedSar = Math.min(Number(walletAmountSar), Number(totalSar));
    }

    if (isFinalCommit) {
      // ─── Hardened Moyasar re-verify with delay ───
      // Wait 2 seconds before the side effects fire, then verify
      // Moyasar AGAIN. The first verify at the top of /commit can
      // see a transient 'paid' that's about to roll back to
      // 'initiated' if the customer abandoned 3DS post-auth. The
      // delay lets Moyasar's settlement settle; the second verify
      // catches the rollback before we touch wallet / promo. We use
      // the same expectedHalals as the first verify so amount
      // tampering still gets caught.
      if (isMoyasarPaymentId) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const hardenedVerify = await verifyPaidPayment(trimmedPaymentId, expectedHalalsForVerify, merchantId);
        if (!hardenedVerify.ok) {
          console.warn(
            '[Orders] Hardened verify (post-delay) failed — refusing side effects:',
            trimmedPaymentId,
            'status:',
            hardenedVerify.status,
          );
          return res.status(402).json({
            error: `Payment not confirmed (${hardenedVerify.reason}). The order was not created.`,
            moyasarStatus: hardenedVerify.status,
          });
        }
      }

      // ─── Atomic promo redemption ───
      // Idempotent via the redeem_promo RPC (unique on order_id).
      // The cancel path (refundOrderToWallet) calls unredeem_promo
      // which rolls back the row + decrements usage_count.
      if (trimmedPromoCode && promoDiscountValue > 0 && promoScopeNormalized && existing?.id !== id) {
        const { data: redeemRows, error: redeemErr } = await supabaseAdmin.rpc('redeem_promo', {
          p_merchant_id: merchantId,
          p_code: trimmedPromoCode,
          p_order_id: id,
          p_customer_id: user.id,
          p_discount_sar: promoDiscountValue,
          p_scope: promoScopeNormalized,
        });
        if (redeemErr) {
          console.error('[Orders] redeem_promo RPC error:', redeemErr.message);
          return res.status(500).json({ error: 'Promo redemption failed' });
        }
        const redeemResult = Array.isArray(redeemRows) ? redeemRows[0] : redeemRows;
        const ok = redeemResult?.ok ?? false;
        if (!ok) {
          const reason = redeemResult?.reason ?? 'Promo code redemption failed';
          console.warn('[Orders] Rejecting commit — promo redeem failed:', trimmedPromoCode, reason);
          return res.status(400).json({ error: reason, code: 'PROMO_REJECTED' });
        }
      }

      // ─── Wallet debit ───
      // Idempotent on (order_id, customer, merchant) — a retried
      // commit returns the same wallet transaction instead of
      // double-debiting.
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
          // Reverse the promo redemption since the wallet debit was
          // required for this order shape and we can't proceed.
          if (trimmedPromoCode) {
            try {
              await supabaseAdmin.rpc('unredeem_promo', {
                p_merchant_id: merchantId,
                p_order_id: id,
              });
            } catch (_e) { /* non-fatal */ }
          }
          if (e?.message === 'INSUFFICIENT_WALLET_BALANCE') {
            return res.status(400).json({ error: 'INSUFFICIENT_WALLET_BALANCE' });
          }
          return res.status(500).json({ error: e?.message || 'Wallet debit failed' });
        }
      }
    } else {
      // First commit: register the wallet payment id placeholder for
      // wallet-only orders so payload.payment_id below stays sensible.
      // No actual debit happens until the final commit.
      if (paymentMethod === 'wallet') {
        walletPaymentId = `wallet:pending-${id}`;
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
      // Persist the payment-composition breakdown. Card portion is
      // computed from totalSar minus the non-card portions so the four
      // amounts always sum to totalSar (within rounding). loyaltyDiscountSar
      // is the cashback-as-discount portion (only when loyaltyType is
      // 'cashback' on the client). stampMilestoneIds is the JSON array of
      // milestones the customer redeemed at checkout — used at refund time
      // to restore each milestone's stamps.
      wallet_paid_sar: walletAppliedSar > 0 ? walletAppliedSar : 0,
      cashback_paid_sar:
        typeof cashbackAmountSar === 'number' && cashbackAmountSar > 0
          ? Number(cashbackAmountSar.toFixed(2))
          : typeof loyaltyDiscountSar === 'number' && loyaltyDiscountSar > 0
            ? Number(loyaltyDiscountSar.toFixed(2))
            : 0,
      card_paid_sar:
        paymentMethod === 'wallet'
          ? 0
          : Math.max(
              0,
              Number(
                (
                  Number(totalSar) -
                  (walletAppliedSar > 0 ? walletAppliedSar : 0)
                ).toFixed(2),
              ),
            ),
      stamp_milestone_ids:
        Array.isArray(stampMilestoneIds) && stampMilestoneIds.length > 0
          ? stampMilestoneIds.filter((v) => typeof v === 'string')
          : [],
      stamps_consumed:
        typeof stampsConsumed === 'number' && stampsConsumed > 0 ? Math.floor(stampsConsumed) : 0,
      // Promo redemption info — also persisted on promo_redemptions
      // for usage-counting, but stored here so the customer's order
      // detail modal + merchant dashboard can show "Promo (CODE)
      // −X SAR" without an extra join.
      promo_code:
        typeof promoCode === 'string' && promoCode.trim() ? promoCode.trim() : null,
      promo_discount_sar:
        typeof promoDiscountSar === 'number' && Number.isFinite(promoDiscountSar) && promoDiscountSar > 0
          ? Number(promoDiscountSar.toFixed(2))
          : null,
      promo_scope: promoScope === 'delivery' || promoScope === 'total' ? promoScope : null,
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
      // Visibility gate: only orders with payment_confirmed_at + a
      // foodics_order_id appear in the customer app and merchant
      // dashboard. Confirmed only on the FINAL commit, after the
      // hardened post-delay re-verify passed and side effects fired.
      // First-commit drafts have NULL here and stay invisible until
      // the second commit promotes them.
      payment_confirmed_at: isFinalCommit ? new Date().toISOString() : null,
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
      // Re-verify the Moyasar payment IMMEDIATELY before relaying.
      // The first /commit call (relayToNooks=false) verified the
      // payment as paid, but Moyasar can flip a payment from paid →
      // failed between the two commits — happens with 3DS that
      // returned 'paid' optimistically then settled as failed, or
      // bank declined post-auth. Without this re-check the order
      // ships to Foodics with money that the webhook will later
      // cancel — orphan POS row that the cashier still has to deal
      // with. Skipping the relay here means the order sits in our
      // DB but never reaches Foodics; the webhook will mark it
      // Cancelled when it lands. Customer + dashboard query filters
      // exclude these rows (cancellation_reason='Payment failed').
      if (isMoyasarPaymentId) {
        const relayVerify = await verifyPaidPayment(trimmedPaymentId, expectedHalalsForVerify, merchantId);
        if (!relayVerify.ok) {
          console.warn(
            '[Orders] Skipping Foodics relay — payment no longer paid:',
            trimmedPaymentId,
            'status:',
            relayVerify.status,
            'reason:',
            relayVerify.reason,
          );
          return res.json({
            id: savedOrder.id,
            status: savedOrder.status,
            payment_id: savedOrder.payment_id,
            foodics_skipped: 'payment_not_confirmed',
            moyasar_status: relayVerify.status,
          });
        }
      }
      // Wrap the Foodics relay in try/catch so that if it fails AFTER
      // we've already debited the wallet + redeemed the promo, we can
      // reverse those side effects + void the Moyasar charge instead
      // of leaving the customer billed for an order the merchant
      // never received. refundOrderToWallet handles all of that
      // atomically — the row's stamps_consumed / promo_code /
      // wallet_paid_sar columns drive the reversal.
      try {
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
          // Stamp-reward items: customer paid 0 in the cart, but
          // rewardOriginalPriceSar carries the menu price so the
          // relay can send the Foodics line at full price + a
          // matching per-item discount (cleaner accounting than a
          // $0 line that distorts item revenue).
          const rewardOriginalPriceSar =
            typeof item.rewardOriginalPriceSar === 'number' && item.rewardOriginalPriceSar > 0
              ? item.rewardOriginalPriceSar
              : null;
          const isRewardItem =
            typeof item.uniqueId === 'string' && item.uniqueId.startsWith('reward-');
          return {
            product_id: String(item.id ?? item.product_id ?? ''),
            name: String(item.name ?? 'Item'),
            quantity: Number(item.quantity ?? 1),
            // Send reward items at their real menu price so Foodics
            // shows them at face value; the discount lives in the
            // per-item discount field below.
            price_sar: isRewardItem && rewardOriginalPriceSar !== null ? rewardOriginalPriceSar : basePrice,
            ...(isRewardItem && rewardOriginalPriceSar !== null
              ? { reward_discount_sar: rewardOriginalPriceSar }
              : {}),
            ...(item.customizations ? { customizations: item.customizations } : {}),
          };
        }),
      });

      // Store Foodics order ID from relay response. Awaited so the
      // foodics_order_id column is set before this endpoint responds
      // — the customer-app order list filter requires it to be
      // non-null, so a fire-and-forget update would mean the order
      // briefly disappeared from the list right after creation.
      const relayData = relayResult as { foodics?: { ok?: boolean; foodicsOrderId?: string; error?: string } } | null;
      if (relayData?.foodics?.ok && relayData.foodics.foodicsOrderId) {
        const { error: foodicsIdErr } = await supabaseAdmin
          .from('customer_orders')
          .update({ foodics_order_id: relayData.foodics.foodicsOrderId })
          .eq('id', id);
        if (foodicsIdErr) {
          console.warn('[Orders] Failed to store foodics_order_id:', foodicsIdErr.message);
        } else {
          console.log(`[Orders] Stored foodics_order_id for ${id}`);
        }
      } else if (relayData?.foodics && relayData.foodics.ok === false) {
        // Foodics relay returned a non-ok response (e.g., bad
        // modifier mapping, branch closed). Throw so the outer
        // catch reverses the side effects.
        throw new Error(relayData.foodics.error || 'Foodics relay returned ok=false');
      }
      } catch (relayErr: any) {
        console.error('[Orders] Foodics relay failed — reversing side effects:', relayErr?.message);
        // refundOrderToWallet reverses everything: card via Moyasar
        // void/refund, wallet credit back, cashback restore, stamp
        // restore, promo unredeem. The row stays as Cancelled with
        // refund_status set so the merchant dashboard's filter
        // (foodics_order_id IS NOT NULL) still hides it.
        try {
          await refundOrderToWallet(id, 'system', 'Foodics relay failed');
        } catch (refundErr: any) {
          console.error('[Orders] Cleanup refund after Foodics failure also failed:', refundErr?.message);
        }
        return res.status(502).json({
          error: 'Order could not be sent to the merchant POS. Your payment is being refunded.',
          foodics_error: relayErr?.message,
        });
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
 * "Rewind time" reversal for a cancelled order. Reads the order's
 * payment-composition columns (card_paid_sar, wallet_paid_sar,
 * cashback_paid_sar, stamp_milestone_ids, stamps_consumed) and returns
 * each source to where it came from in parallel:
 *
 *   - card_paid_sar    → Moyasar void (free, ~2h) or refund (1-3d).
 *                        Only credit wallet as a fallback if Moyasar
 *                        cannot reverse the charge.
 *   - wallet_paid_sar  → re-credit the in-app wallet via the wallet RPC.
 *   - cashback_paid_sar→ re-credit loyalty_cashback_balances and log a
 *                        +amount loyalty_transactions row.
 *   - stamp_milestone_ids → re-add stamps to loyalty_stamps + clear the
 *                        loyalty_stamp_redemptions rows so the milestone
 *                        is re-eligible. Internal points are also
 *                        restored.
 *
 * Returned refundBreakdown captures what was actually reversed per
 * source, suitable for serialization to customer_orders.refund_method
 * (now a JSON blob) and for naming each source in the push
 * notification.
 *
 * Each sub-action is idempotent at its own helper level, so re-running
 * a cancel (manual retry by ops, webhook replay) cannot double-rewind.
 */
type RefundDestination = 'card' | 'wallet' | 'none';
type ReversalBreakdown = {
  card?: { method: 'void' | 'refund' | 'failed' | 'not_required' | 'skipped'; amountSar: number };
  wallet?: { amountSar: number };
  cashback?: { amountSar: number; alreadyRestored?: boolean };
  stamps?: { count: number; milestones: string[]; alreadyRestored?: boolean };
};
async function refundOrderToWallet(
  orderId: string,
  cancelledBy: 'merchant' | 'system',
  reason: string,
): Promise<
  | { ok: true; orderId: string; refundedSar: number; refundMethod: RefundDestination; breakdown: ReversalBreakdown }
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

  // ─── Read payment composition (the intent on the order row) ───
  // These are the AMOUNTS THE COMMIT INTENDED to deduct from each
  // source. After the Option A refactor (final commit gates side
  // effects) the row can record an intent without the actual
  // deduction having fired — e.g., an abandoned-3DS order's first
  // commit stamped wallet_paid_sar=100 but the wallet was never
  // debited. We must NOT credit back what we never deducted; do
  // that and a customer who toggles "use wallet" then abandons 3DS
  // can mint free SAR every attempt (exploit reproduced
  // 2026-05-16: test wallet showed +500 SAR phantom credit from
  // five abandoned attempts that each charged the customer nothing).
  const totalSar = Number(order.total_sar ?? 0);
  const intentCardPaidSar = Number((order as any).card_paid_sar ?? 0);
  const intentWalletPaidSar = Number((order as any).wallet_paid_sar ?? 0);
  const intentCashbackPaidSar = Number((order as any).cashback_paid_sar ?? 0);
  const milestoneIds: string[] = Array.isArray((order as any).stamp_milestone_ids)
    ? ((order as any).stamp_milestone_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const stampsConsumed = Math.max(0, Math.floor(Number((order as any).stamps_consumed ?? 0)));

  // ─── Read what ACTUALLY happened to each source ───
  // Wallet: query the wallet ledger for a real spend row tied to
  // this order. Without it, any wallet credit we hand back is
  // phantom (= exploit).
  const { data: actualWalletSpend } = await supabaseAdmin
    .from('customer_wallet_transactions')
    .select('id, amount_halalas')
    .eq('order_id', orderId)
    .eq('customer_id', order.customer_id)
    .eq('merchant_id', order.merchant_id)
    .eq('entry_type', 'spend')
    .maybeSingle();
  const actualWalletPaidSar = actualWalletSpend
    ? Math.abs(Number(actualWalletSpend.amount_halalas)) / 100
    : 0;

  // Cashback: query loyalty_transactions for a real redeem row
  // tied to this order. Same exploit class as the wallet — credit
  // only what was actually deducted.
  const { data: actualCashbackRedeem } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, amount_sar')
    .eq('order_id', orderId)
    .eq('customer_id', order.customer_id)
    .eq('merchant_id', order.merchant_id)
    .eq('type', 'redeem')
    .eq('loyalty_type', 'cashback')
    .maybeSingle();
  const actualCashbackPaidSar = actualCashbackRedeem
    ? Math.abs(Number((actualCashbackRedeem as { amount_sar?: number }).amount_sar ?? 0))
    : 0;

  // Legacy-row inference: if all breakdown columns are zero (pre-
  // migration row) AND total_sar > 0, assume the whole total was
  // paid via the primary payment_method. This keeps cancellations
  // working for orders placed before P2 shipped — those rows DID
  // actually deduct because side effects fired in the first commit.
  const hasBreakdown =
    intentCardPaidSar > 0 ||
    intentWalletPaidSar > 0 ||
    intentCashbackPaidSar > 0 ||
    milestoneIds.length > 0;
  // Card reversal still uses the intent because Moyasar IS the
  // source of truth — cancelPayment below queries Moyasar's actual
  // amount and voids/refunds that, regardless of what we recorded.
  // The intent here is the upper bound we'd void if Moyasar agrees.
  const effectiveCardPaid = hasBreakdown
    ? intentCardPaidSar
    : (order.payment_method === 'wallet' ? 0 : totalSar);
  // Wallet + cashback reversal: use the ACTUAL ledger entry. If
  // commit recorded the intent but the ledger doesn't agree, the
  // deduction never happened → credit nothing.
  const effectiveWalletPaid = hasBreakdown
    ? actualWalletPaidSar
    : (order.payment_method === 'wallet' ? actualWalletPaidSar : 0);
  const effectiveCashbackPaid = hasBreakdown ? actualCashbackPaidSar : 0;

  if (intentWalletPaidSar > 0 && actualWalletPaidSar === 0) {
    console.log(
      `[Orders] Order ${orderId} recorded wallet intent ${intentWalletPaidSar} but no actual debit — skipping wallet credit (would be phantom)`,
    );
  }
  if (intentCashbackPaidSar > 0 && actualCashbackPaidSar === 0) {
    console.log(
      `[Orders] Order ${orderId} recorded cashback intent ${intentCashbackPaidSar} but no actual redeem — skipping cashback restore`,
    );
  }

  const breakdown: ReversalBreakdown = {};

  // ─── Card reversal ───
  // Three Moyasar outcomes:
  //   - void / refund   → money is going back to the CARD. No wallet
  //                       fallback.
  //   - not_required    → Moyasar says nothing was charged. No refund
  //                       owed.
  //   - failed / skipped→ if there was a card portion the customer
  //                       paid, we fall back to wallet credit so they
  //                       become whole.
  let moyasarMethod: 'void' | 'refund' | 'failed' | 'not_required' | 'skipped' = 'skipped';
  if (effectiveCardPaid > 0 && order.payment_id) {
    try {
      const result = await cancelPayment(order.payment_id, undefined, order.merchant_id);
      moyasarMethod = result.method;
      console.log('[Orders] Moyasar cancel result for', order.payment_id, ':', result.method);
    } catch (e: any) {
      moyasarMethod = 'failed';
      console.warn('[Orders] Moyasar cancel threw:', e?.message);
    }
  }
  const cardReturnedToCustomer = moyasarMethod === 'void' || moyasarMethod === 'refund';
  const cardNothingOwed = moyasarMethod === 'not_required';
  breakdown.card = { method: moyasarMethod, amountSar: effectiveCardPaid };

  // ─── Wallet reversal ───
  // (a) Re-credit the wallet portion the customer ACTUALLY spent
  //     (not the intent — see note above).
  // (b) If the card portion couldn't be reversed via Moyasar AND
  //     money actually moved (not 'not_required'), credit the card
  //     portion to the wallet too as a fallback. This part uses
  //     the intent because if Moyasar took the money, we still
  //     owe it back even if the intent != actual.
  let walletCreditSar = effectiveWalletPaid;
  if (effectiveCardPaid > 0 && !cardReturnedToCustomer && !cardNothingOwed) {
    walletCreditSar = +(walletCreditSar + effectiveCardPaid).toFixed(2);
  }
  if (walletCreditSar > 0) {
    try {
      await creditWalletForRefund({
        customerId: order.customer_id,
        merchantId: order.merchant_id,
        amountSar: walletCreditSar,
        orderId,
        complaintId: null,
        note: `Order ${cancelledBy === 'merchant' ? 'refused' : 'auto-cancelled'}: ${reason}`.slice(0, 200),
      });
      breakdown.wallet = { amountSar: walletCreditSar };
    } catch (e: any) {
      console.error('[Orders] Wallet credit failed for', orderId, ':', e?.message);
      return { ok: false, error: e?.message || 'Wallet credit failed', status: 500 };
    }
  }

  // ─── Cashback reversal ───
  if (effectiveCashbackPaid > 0) {
    try {
      const r = await restoreCashbackForRefund({
        customerId: order.customer_id,
        merchantId: order.merchant_id,
        amountSar: effectiveCashbackPaid,
        orderId,
      });
      breakdown.cashback = { amountSar: r.restoredSar, alreadyRestored: r.alreadyRestored };
    } catch (e: any) {
      console.warn('[Orders] Cashback restore failed (non-blocking):', e?.message);
    }
  }

  // ─── Stamp reversal ───
  if (milestoneIds.length > 0 && stampsConsumed > 0) {
    try {
      const r = await restoreStampMilestonesForRefund({
        customerId: order.customer_id,
        merchantId: order.merchant_id,
        milestoneIds,
        stampsConsumed,
        orderId,
      });
      breakdown.stamps = {
        count: r.stampsRestored,
        milestones: r.milestonesCleared,
        alreadyRestored: r.alreadyRestored,
      };
    } catch (e: any) {
      console.warn('[Orders] Stamp restore failed (non-blocking):', e?.message);
    }
  }

  // ─── Headline refundMethod for legacy callers + dashboard display ───
  // Pick the destination that's most relevant to the customer:
  //  - card if any card portion went back to the card
  //  - wallet if wallet credit fired
  //  - none if nothing was owed (card portion was never charged AND
  //    there was no wallet/cashback/stamp portion)
  const refundMethod: RefundDestination =
    cardReturnedToCustomer
      ? 'card'
      : breakdown.wallet
        ? 'wallet'
        : breakdown.cashback || breakdown.stamps
          ? 'wallet'
          : cardNothingOwed && effectiveWalletPaid === 0 && effectiveCashbackPaid === 0 && stampsConsumed === 0
            ? 'none'
            : 'wallet';
  const refundedSarHeadline =
    refundMethod === 'card'
      ? effectiveCardPaid
      : refundMethod === 'wallet'
        ? walletCreditSar
        : 0;

  const { error: updateErr } = await supabaseAdmin
    .from('customer_orders')
    .update({
      status: 'Cancelled',
      cancellation_reason: reason,
      cancelled_by: cancelledBy,
      refund_status: refundMethod === 'none' ? 'not_required' : 'refunded',
      refund_amount: refundedSarHeadline,
      refund_fee: 0,
      refund_method: refundMethod,
      commission_status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId);
  if (updateErr) return { ok: false, error: updateErr.message, status: 500 };

  // Give the promo slot back to the merchant's quota. unredeem_promo
  // deletes the promo_redemptions row tied to this order_id and
  // decrements promo_codes.usage_count by 1. Idempotent — re-running
  // a cancel on an already-unredeemed order is a no-op (returns 0).
  // Non-blocking: a failure here doesn't roll back the refund.
  if (order.merchant_id) {
    try {
      await supabaseAdmin.rpc('unredeem_promo', {
        p_merchant_id: order.merchant_id,
        p_order_id: orderId,
      });
    } catch (e: any) {
      console.warn('[Orders] unredeem_promo failed (non-blocking):', e?.message);
    }
  }

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

  // Compose a multi-source push message that names each restored
  // source. Order: card → wallet → cashback → stamps. We skip the
  // "no charge" message unless literally nothing was reversed.
  //
  // Suppress the push entirely for abandoned-payment sweeps on orders
  // that never reached Foodics. The customer in that scenario closed
  // 3DS / abandoned card entry; the order never showed up on the
  // merchant POS and the cart-side flow already gave them an inline
  // payment error. Pushing "Order Cancelled — couldn't dispatch a
  // driver" on top is misleading (no driver was ever in scope), and
  // worse, the order is hidden from the customer's Orders tab by the
  // foodics_order_id filter so they have no way to reconcile the
  // notification with anything they can see. The wallet/cashback/
  // stamp reversals still happen silently — the ledger is the
  // source of truth.
  const isAbandonedPaymentSweep =
    cancelledBy === 'system' &&
    typeof reason === 'string' &&
    reason.toLowerCase().startsWith('abandoned payment') &&
    !order.foodics_order_id;
  if (!isAbandonedPaymentSweep) {
    const lead =
      cancelledBy === 'merchant'
        ? 'Your order has been refused by the store.'
        : "We couldn't dispatch a driver for your order.";
    const pieces: string[] = [];
    if (cardReturnedToCustomer && effectiveCardPaid > 0) {
      pieces.push(
        moyasarMethod === 'void'
          ? `${effectiveCardPaid} SAR will be returned to your card within a few hours`
          : `${effectiveCardPaid} SAR is being returned to your card (1-3 business days)`,
      );
    }
    if (breakdown.wallet && breakdown.wallet.amountSar > 0) {
      pieces.push(`${breakdown.wallet.amountSar} SAR credited to your wallet`);
    }
    if (breakdown.cashback && breakdown.cashback.amountSar > 0 && !breakdown.cashback.alreadyRestored) {
      pieces.push(`${breakdown.cashback.amountSar} SAR cashback restored`);
    }
    if (breakdown.stamps && breakdown.stamps.count > 0 && !breakdown.stamps.alreadyRestored) {
      pieces.push(`${breakdown.stamps.count} stamps restored`);
    }
    const refundLine = pieces.length
      ? `${pieces.join(', ')}.`
      : 'No charge was made to your card, so nothing needs to be refunded.';
    sendPushToCustomer(order.customer_id, 'Order Cancelled', `${lead} ${refundLine}`, order.merchant_id);
  } else {
    console.log(
      `[Orders] Suppressing cancellation push for abandoned-payment sweep on order ${orderId} (never reached Foodics)`,
    );
  }

  // Audit row — one record per order_id. Replays UPSERT into the same
  // row so a retried cancel doesn't create duplicate audit entries
  // (the sub-actions are already idempotent at their own layer). This
  // is what ops queries to answer "what happened when this order was
  // cancelled — where did the money / stamps / cashback go?"
  await supabaseAdmin
    .from('order_reversals')
    .upsert(
      {
        order_id: orderId,
        cancelled_by: cancelledBy,
        reason: reason || null,
        refund_method: refundMethod,
        refunded_sar: refundedSarHeadline,
        breakdown,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'order_id' },
    )
    .then(({ error }) => {
      if (error) console.warn('[Orders] order_reversals upsert failed (non-blocking):', error.message);
    });

  return {
    ok: true,
    orderId,
    refundedSar: refundedSarHeadline,
    refundMethod,
    breakdown,
  };
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

/* ═══════════════════════════════════════════════════════════════════
   SWEEP ABANDONED PAYMENTS — defense-in-depth cron target. P1's
   commit-time Moyasar verification already blocks new orphan rows in
   the normal path; this sweep covers the edge cases where (a) the
   server's verification saw 'paid' but Moyasar later reverted, (b) a
   future SDK quirk slips a row past P1, or (c) anything pre-P1 that
   exists in the wild post-deploy. Looks for orders stuck in 'Placed'
   older than 10 min with a non-wallet payment_id; for each, asks
   Moyasar for the current payment status and reverses the order
   if Moyasar isn't paid/captured.

   refundOrderToWallet already handles the not_required case (no card
   refund, but DOES restore wallet/cashback/stamps that were applied
   pre-payment) — so we just call it like any other system cancel.

   Schedule from outside (GitHub Actions / Vercel cron / external cron)
   every 5 min with the internal secret header.
   ═══════════════════════════════════════════════════════════════════ */
ordersRouter.post('/internal/sweep-abandoned-payments', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    // 3-minute floor — Moyasar 3DS typically clears in <60s, and the
    // user-facing complaint is that abandoned orders sat as "Placed"
    // on both customer + merchant screens for the whole 10-min window
    // before the previous cutoff fired. Dropping to 3 min keeps a
    // small safety buffer for genuinely-slow 3DS settles while wiping
    // the dashboard clutter within a single sweep cycle.
    const cutoffIso = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: candidates, error: queryErr } = await supabaseAdmin
      .from('customer_orders')
      .select('id, payment_id, merchant_id, customer_id, total_sar, card_paid_sar, created_at, payment_confirmed_at')
      .eq('status', 'Placed')
      .lt('created_at', cutoffIso)
      .not('payment_id', 'is', null)
      .limit(100);
    if (queryErr) return res.status(500).json({ error: queryErr.message });

    let swept = 0;
    let skipped = 0;
    const results: Array<{ orderId: string; action: 'swept' | 'kept' | 'error'; reason: string }> = [];

    for (const order of candidates ?? []) {
      const paymentId = String(order.payment_id ?? '');
      // Skip wallet-only orders — their payment_id is a wallet:* sentinel
      // and the wallet debit IS the payment. Nothing to sweep.
      if (!paymentId || paymentId.startsWith('wallet:')) {
        skipped += 1;
        results.push({ orderId: order.id, action: 'kept', reason: 'wallet-only' });
        continue;
      }

      // ─── Layer 2: never-confirmed drafts skip the refund path ───
      // payment_confirmed_at IS NULL means the final commit never ran
      // (or its hardened verify rejected the payment). With the Option
      // A refactor, no side effects fired on our side for this row —
      // no wallet debit, no promo redeem, no cashback redeem, no
      // stamp redeem. Calling refundOrderToWallet here would either
      // be a no-op (after Layer 1's actual-ledger checks) or, worse,
      // mint phantom credits if Layer 1 ever drifted. Skip the whole
      // refund flow; just void Moyasar if money moved on the card
      // side (token-pay charged before the second commit's verify
      // rejected) and mark the row Cancelled. Customer is whole
      // because: (a) Moyasar returns the card amount, (b) nothing
      // else was deducted to begin with.
      if (!order.payment_confirmed_at) {
        let moyasarOutcome = 'skipped';
        if (!paymentId.startsWith('reward:')) {
          try {
            const r = await cancelPayment(paymentId, undefined, order.merchant_id);
            moyasarOutcome = r.method;
          } catch (e: any) {
            moyasarOutcome = `failed: ${e?.message || 'unknown'}`;
          }
        }
        await supabaseAdmin
          .from('customer_orders')
          .update({
            status: 'Cancelled',
            cancelled_by: 'system',
            cancellation_reason: `Abandoned payment (never confirmed; moyasar: ${moyasarOutcome})`,
            refund_status: 'not_required',
            refund_amount: 0,
            refund_method: 'none',
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        swept += 1;
        results.push({ orderId: order.id, action: 'swept', reason: `draft_never_confirmed (moyasar: ${moyasarOutcome})` });
        continue;
      }

      // ─── Confirmed orders: existing flow ───
      // Use the card-portion amount for verification (matches what was
      // actually charged to Moyasar). If breakdown columns are zero
      // (legacy row), fall back to total_sar.
      const expectedHalals = Math.round(Number(order.card_paid_sar ?? order.total_sar ?? 0) * 100);
      const verification = await verifyPaidPayment(paymentId, expectedHalals, order.merchant_id);
      if (verification.ok) {
        // Payment cleared — leave the order alone. Probably the Foodics
        // relay was just slow; another path will pick it up.
        skipped += 1;
        results.push({ orderId: order.id, action: 'kept', reason: `paid (status: ${verification.status})` });
        continue;
      }
      // Moyasar says payment didn't clear. Reverse the order — this
      // refunds wallet/cashback/stamps if applied, no card refund
      // because no money moved.
      try {
        const result = await refundOrderToWallet(order.id, 'system', `Abandoned payment (Moyasar: ${verification.status})`);
        if (result.ok) {
          swept += 1;
          results.push({ orderId: order.id, action: 'swept', reason: verification.status });
        } else {
          results.push({ orderId: order.id, action: 'error', reason: result.error });
        }
      } catch (e: any) {
        results.push({ orderId: order.id, action: 'error', reason: e?.message || 'reverse threw' });
      }
    }

    res.json({ swept, skipped, total: (candidates ?? []).length, results });
  } catch (err: any) {
    console.error('[Orders] sweep-abandoned-payments error:', err?.message);
    res.status(500).json({ error: err?.message || 'Sweep failed' });
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
