/**
 * Order management routes — commit, merchant refuse (full void + wallet
 * credit), system no-accept-timeout cancel (5 min after Foodics relay
 * with cashier still hasn't tapped Accept → void Moyasar + restore all
 * sources + cancel on Foodics POS), edit-hold, commission, status. End
 * users CANNOT cancel orders directly — their only refund path is the
 * complaint flow (server/routes/complaints.ts), which always credits
 * the customer wallet and never issues a card refund.
 *
 * Delivery-side cancellation (driver unavailable, dispatch failure,
 * out-for-delivery returns) was intentionally REMOVED here on
 * 2026-05-17 and will be implemented separately when the delivery
 * cancellation policy is designed. Any driver/dispatch wording in
 * customer notifications is gone for now.
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';
import { checkBranchOrderable } from '../lib/storeGate';
import { cancelPayment, verifyPaidPayment } from '../services/payment';
import { isPaymentStillSettling } from '../utils/paymentSettling';
import { sendOrderReceipt } from '../services/receipt';
import { consumeOrderMilestones, earnForOrder, restoreCashbackForRefund, restoreStampMilestonesForRefund } from './loyalty';
import { requireAuthenticatedAppUser, requireVerifiedAtMerchant } from '../utils/appUserAuth';
import { requireNooksInternalRequest } from '../utils/nooksInternal';
import { enforceLimits, ipFromReq } from '../utils/rateLimit';
import { creditWalletForRefund } from './wallet';
import { notifyPassUpdateSafe } from './walletPass';

export const ordersRouter = Router();

/**
 * Best-effort void of a card charge when a commit is rejected by a
 * policy gate (store closed / loyalty misuse). Called on BOTH commits:
 * the Apple Pay / SDK card paths charge BEFORE the first commit, so a
 * first-commit rejection would otherwise strand a captured payment
 * with NO customer_orders row — invisible even to the abandoned-
 * payments sweep. No-ops when paymentId isn't a real Moyasar id
 * (saved-card first commits carry none; wallet/reward sentinels skip).
 * Failures only log — the sweep remains the backstop for orders that
 * do have a row.
 */
async function voidChargeOnRejectedCommit(
  paymentId: unknown,
  merchantId: string,
  context: string,
): Promise<void> {
  const pid = typeof paymentId === 'string' ? paymentId.trim() : '';
  if (!pid || pid.startsWith('wallet:') || pid.startsWith('reward:')) return;
  try {
    const result = await cancelPayment(pid, undefined, merchantId);
    if (result.method === 'failed') {
      console.error(`[Orders] ${context}: void of Moyasar payment ${pid} failed:`, result.error);
    } else {
      console.warn(`[Orders] ${context}: ${result.method} Moyasar payment ${pid} after rejecting final commit`);
    }
  } catch (e: any) {
    console.error(`[Orders] ${context}: void of Moyasar payment ${pid} threw:`, e?.message);
  }
}

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
  merchantId: string,
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
    // L5: merchantId is REQUIRED and the filter always applies —
    // an unscoped call is now a compile error instead of a silent
    // cross-brand fan-out.
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('expo_push_token')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId);
    const tokens = (subs ?? []).map((s: any) => s.expo_push_token).filter(Boolean);

    // 2026-05-22: detailed observability. Pre-fix, this function was a
    // black hole — no log on success, no log on "no tokens found", no
    // inspection of Expo's per-message response. The mofosos test
    // surfaced exactly this: a Cancelled push fired but the customer
    // got nothing on the app, and the Railway logs were silent.
    // Now: every code path emits a log line + audit row.
    if (tokens.length === 0) {
      console.warn('[Push] No tokens found', { customerId, merchantId, title });
      void (async () => {
        try {
          const { writeAudit } = await import('../utils/auditLog');
          await writeAudit({
            merchant_id: merchantId ?? null,
            action: 'push.no_tokens',
            payload: { customer_id: customerId, title },
          });
        } catch { /* never let audit throw */ }
      })();
      return;
    }

    // channelId='orders' (transactional channel) — pre-fix this was
    // 'marketing' which is wrong for order-status / cancellation
    // pushes. iOS ignores channelId anyway, but on Android a
    // mis-channeled transactional notification can land in a
    // category the customer has muted. 'orders' is the channel name
    // the Localized push helper uses.
    const messages = tokens.map((token: string) => ({
      to: token,
      sound: 'default',
      title,
      body,
      channelId: 'orders',
    }));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });

    // Expo returns { data: [{ status: 'ok' | 'error', message?, details? }, ...] }
    // — one element per message we sent. We inspect each so a single
    // dead token (DeviceNotRegistered) doesn't silently sink the whole
    // batch and we know which token to prune.
    let okCount = 0;
    let errorCount = 0;
    const tokenErrors: Array<{ token: string; status: string; message?: string; code?: string }> = [];
    if (res.ok) {
      try {
        const json = (await res.json()) as { data?: Array<{ status?: string; message?: string; details?: { error?: string } }> };
        const receipts = Array.isArray(json?.data) ? json.data : [];
        receipts.forEach((rcpt, idx) => {
          if (rcpt?.status === 'ok') okCount += 1;
          else {
            errorCount += 1;
            tokenErrors.push({
              token: String(tokens[idx] ?? '').slice(-12),
              status: rcpt?.status ?? 'unknown',
              message: rcpt?.message,
              code: rcpt?.details?.error,
            });
          }
        });
      } catch (parseErr: any) {
        console.warn('[Push] Could not parse Expo response', { customerId, merchantId, error: parseErr?.message });
      }
    } else {
      errorCount = tokens.length;
      const errBody = await res.text().catch(() => '');
      console.warn('[Push] Expo HTTP non-2xx', {
        customerId,
        merchantId,
        status: res.status,
        body: errBody.slice(0, 200),
      });
    }

    if (errorCount === 0 && okCount > 0) {
      console.log(`[Push] Sent`, { customerId, merchantId, title, tokenCount: okCount });
    } else if (errorCount > 0) {
      console.warn('[Push] Partial / total failure', {
        customerId,
        merchantId,
        title,
        ok: okCount,
        errors: errorCount,
        tokenErrors,
      });
      // Audit + Sentry so partial-deliveries don't disappear into the void.
      void (async () => {
        try {
          const [{ writeAudit }, { captureError }] = await Promise.all([
            import('../utils/auditLog'),
            import('../utils/sentryContext'),
          ]);
          await writeAudit({
            merchant_id: merchantId ?? null,
            action: 'push.delivery_partial_failure',
            payload: {
              customer_id: customerId,
              title,
              ok_count: okCount,
              error_count: errorCount,
              token_errors: tokenErrors,
            },
          });
          if (tokenErrors.some((t) => t.code === 'DeviceNotRegistered')) {
            captureError(new Error('Expo DeviceNotRegistered — stale push token'), {
              component: 'push.deviceNotRegistered',
              merchantId: merchantId ?? undefined,
              customerId,
              extra: { tokenErrors },
            });
          }
        } catch { /* never let observability throw */ }
      })();
    }
  } catch (e: any) {
    console.warn('[Push] Failed to send', { customerId, merchantId, error: e?.message });
    void (async () => {
      try {
        const { captureError } = await import('../utils/sentryContext');
        captureError(e, {
          component: 'orders.sendPushToCustomer',
          merchantId: merchantId ?? undefined,
          customerId,
        });
      } catch { /* never let observability throw */ }
    })();
  }
}

import { debitWalletForOrder } from './wallet';
import { captureError, tagSentry } from '../utils/sentryContext';

/**
 * M15 canonical loyalty earn base: net-of-loyalty. Earn only on the new money
 * the customer actually paid — exclude the wallet- and redeemed-cashback-funded
 * portions (total_sar = card_paid + wallet_paid + cashback_paid, verified to sum).
 * Promo discounts are already reflected in total_sar (marketing, not loyalty) so
 * they stay in the base. This matches the walk-in and internal /earn paths, which
 * pass net POS amounts — so one physical purchase earns on the same base regardless
 * of channel. Clamped ≥ 0.
 */
function netOfLoyaltyEarnBase(order: {
  total_sar?: number | null;
  wallet_paid_sar?: number | null;
  cashback_paid_sar?: number | null;
}): number {
  const total = Number(order.total_sar ?? 0);
  const wallet = Number(order.wallet_paid_sar ?? 0);
  const cashback = Number(order.cashback_paid_sar ?? 0);
  return Math.max(0, Number((total - wallet - cashback).toFixed(2)));
}

async function relayOrderToNooks(
  payload: Record<string, unknown>,
  options: { customerJwt?: string | null } = {},
) {
  if (!NOOKS_API_BASE_URL) {
    throw new Error('NOOKS_API_BASE_URL is not configured');
  }
  if (!NOOKS_INTERNAL_SECRET) {
    throw new Error('NOOKS_INTERNAL_SECRET is not configured');
  }

  // Forward the customer's access token in a separate header so
  // nooksweb can re-verify that body.customer_id actually belongs to
  // the authenticated user — a leaked NOOKS_INTERNAL_SECRET would
  // otherwise let an attacker impersonate any customer at any
  // merchant by posting a fake customer_id with the leaked header.
  // Without this, internal-secret alone is the only auth, and one
  // leak nukes tenant isolation across the platform.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
  };
  if (options.customerJwt) {
    headers['x-customer-jwt'] = options.customerJwt;
  }

  const response = await fetch(`${NOOKS_API_BASE_URL}/api/public/orders`, {
    method: 'POST',
    headers,
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

    // ─── ORDER-RELAY-1: strict mirror of an already-finalized order ───
    // This route used to spread the client request body straight through
    // to nooksweb's service-role order-creation endpoint, replacing only
    // customer_id. An authenticated customer could therefore inject an
    // arbitrary total_sar, payment_id, items, discounts, and delivery fee
    // and have a free-or-fake-paid order inserted and relayed to Foodics
    // (bypassing /commit, Moyasar verification, wallet/reward deduction,
    // and authoritative pricing entirely). The internal secret only proves
    // "ALS sent this"; it does NOT prove the order passed the authoritative
    // commit/payment state machine.
    //
    // It is now a pure MIRROR: /commit is the single path allowed to
    // create/finalize an order and it already relays every finalized order
    // itself. Here we accept ONLY an order id, load the authoritative row
    // scoped to the caller, require it to be finalized by /commit
    // (payment_confirmed_at set on the hardened final commit), and relay
    // STRICTLY from the stored server-side economics — never the request
    // body. If the row isn't the caller's or isn't finalized we no-op; the
    // order still reaches Foodics via /commit's own relay (and the
    // reconcile-web-orders cron is the backstop). No client field can
    // influence price, tender, items, or discounts on this path anymore.
    const orderId = String(req.body?.id ?? req.body?.orderId ?? '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'order id is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured' });
    }
    const db = supabaseAdmin;

    const { data: order, error: loadErr } = await db
      .from('customer_orders')
      .select('id, merchant_id, branch_id, branch_name, customer_id, total_sar, status, items, order_type, delivery_address, delivery_lat, delivery_lng, delivery_city, delivery_fee, payment_id, payment_method, promo_code, promo_discount_sar, promo_scope, loyalty_discount_sar, wallet_amount_sar, car_details, qr_code_id, foodics_table_id, foodics_table_name, guests, payment_confirmed_at')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .maybeSingle();

    if (loadErr) {
      return res.status(500).json({ error: loadErr.message });
    }
    if (!order || !order.payment_confirmed_at) {
      // Not the caller's order, or /commit hasn't finalized it yet. Do NOT
      // relay client-supplied economics from here — /commit owns relay.
      return res.json({
        success: true,
        relayed: false,
        reason: !order ? 'not_found_or_not_owned' : 'not_finalized',
      });
    }

    const customerJwt = (req.headers.authorization || '').toString().replace(/^Bearer\s+/i, '').trim() || null;
    const data = await relayOrderToNooks(
      {
        id: order.id,
        merchant_id: order.merchant_id,
        branch_id: order.branch_id,
        branch_name: order.branch_name,
        customer_id: order.customer_id,
        total_sar: order.total_sar,
        status: order.status,
        order_type: order.order_type,
        items: order.items,
        delivery_address: order.delivery_address,
        delivery_lat: order.delivery_lat,
        delivery_lng: order.delivery_lng,
        delivery_city: order.delivery_city,
        delivery_fee: order.delivery_fee,
        payment_id: order.payment_id,
        payment_method: order.payment_method,
        promo_code: order.promo_code,
        promo_discount_sar: order.promo_discount_sar,
        promo_scope: order.promo_scope,
        loyalty_discount_sar: order.loyalty_discount_sar,
        wallet_amount_sar: order.wallet_amount_sar,
        car_details: order.car_details,
        qr_code_id: order.qr_code_id,
        table_id: order.foodics_table_id,
        foodics_table_name: order.foodics_table_name,
        guests: order.guests,
      },
      { customerJwt },
    );

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
// SCAL-005: the per-process commit limiter (in-memory map) was replaced by
// the shared Upstash-backed enforceLimits — with a bounded in-memory
// emergency fallback on Upstash outage — so the commit limit stays correct
// once the API runs on more than one Railway replica. See the /commit
// handler below.

ordersRouter.post('/commit', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Layer 3: customer-scoped commit rate limit. SCAL-005 — shared across
    // replicas via Upstash (enforceLimits), with a bounded in-memory
    // emergency fallback on Upstash outage, so it stays correct once the API
    // scales past one Railway dyno. 10/min/customer + 30/min/IP backstop.
    if (
      !(await enforceLimits(req, res, {
        endpoint: 'orders.commit',
        keys: [
          { dim: 'customer', value: user.id, max: 10, windowMs: 60_000 },
          { dim: 'ip', value: ipFromReq(req), max: 30, windowMs: 60_000 },
        ],
        supabaseAdmin,
        merchantId: typeof req.body?.merchantId === 'string' ? req.body.merchantId : null,
      }))
    ) {
      return;
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
      // QR-code attribution. Set when the customer arrived via a
      // scanned QR. qrCodeId links the order back to the QR for
      // analytics + the dashboard "Table 5" chip. tableId is the
      // Foodics-side UUID that gets sent in the relay body for
      // dine_in orders. foodicsTableName is cached on the order row
      // so the dashboard can render the table label even if the
      // merchant later renames it in Foodics. guests defaults to 1
      // server-side if omitted.
      qrCodeId,
      tableId,
      foodicsTableName,
      guests,
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

    // Phase B: customer must have OTP'd at THIS merchant within the
    // verification TTL (6 months). The white-label model treats each
    // merchant's app as independent; a Supabase session minted at
    // merchant A doesn't grant access to merchant B without a fresh
    // OTP. requireVerifiedAtMerchant sends the 401 itself; we just
    // return early.
    const verification = await requireVerifiedAtMerchant(res, user.id, merchantId);
    if (!verification.ok) return;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items are required' });
    }
    if (typeof totalSar !== 'number' || !Number.isFinite(totalSar) || totalSar < 0) {
      return res.status(400).json({ error: 'totalSar must be a valid non-negative number' });
    }

    // ─── QR + dine-in validation ──────────────────────────────────────
    // Server is the source of truth on QR ↔ branch ↔ table linkage —
    // client can't lie about which table they're at. If a qrCodeId is
    // supplied, verify it's active + belongs to this merchant + matches
    // the order type. Dine-in orders MUST have a tableId from an active
    // QR (Foodics rejects type=1 without table_id).
    let resolvedQrCode:
      | { foodics_table_id: string | null; foodics_table_name: string | null; branch_id: string | null; order_type_hint: string | null }
      | null = null;
    if (qrCodeId) {
      const { data: qr } = await supabaseAdmin
        .from('merchant_qr_codes')
        .select('id, merchant_id, branch_id, foodics_table_id, foodics_table_name, order_type_hint, active')
        .eq('id', qrCodeId)
        .maybeSingle();
      if (!qr || qr.merchant_id !== merchantId || !qr.active) {
        return res.status(400).json({ error: 'Invalid or inactive QR code' });
      }
      resolvedQrCode = qr;
    }
    if (orderType === 'dine_in') {
      if (!resolvedQrCode || !resolvedQrCode.foodics_table_id) {
        return res.status(400).json({ error: 'dine_in orders require a QR code linked to a Foodics table' });
      }
      // Force server-side values over any client-supplied ones — client
      // can request dine_in but the table identity comes from the QR row.
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
      // Absurdity ceiling — no single F&B item realistically lists at
      // > 10,000 SAR. Without an upper bound, a tampered client could
      // inflate basePrice (say 100,000 SAR for a 5 SAR item) so the
      // 95%-discount floor passes for an absurd low totalSar — a
      // 5%-of-100k=5,000 acceptance for what's actually a 5 SAR cart
      // would let the customer order anything at 5 SAR. Matches the
      // mirror ceiling on the nooksweb relay side
      // (foodics-orders.ts).
      if (unitPrice > 10000) {
        return res.status(400).json({
          error: 'Item price exceeds the 10,000 SAR per-unit ceiling; refusing to commit.',
          code: 'ITEM_PRICE_CEILING',
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

    // #11: menu-authoritative price validation. The floor above is built from
    // CLIENT-supplied basePrice, which a tampered client can understate. Cross-
    // check each non-reward item's unit price against the merchant's actual menu
    // (products table, honoring per-branch overrides) and reject anything priced
    // BELOW the menu price — the "client lies about item prices to underpay"
    // vector the older comment flagged as pending nooksweb integration. Items
    // not found in the menu (just-synced / edge) fall back to the floor checks
    // above rather than hard-rejecting, to avoid false rejections.
    {
      const productItemIds = Array.from(new Set(
        (items as Array<{ id?: unknown; uniqueId?: unknown }>)
          .filter((it) => !(typeof it.uniqueId === 'string' && (it.uniqueId as string).startsWith('reward-')))
          .map((it) => (typeof it.id === 'string' ? (it.id as string) : null))
          .filter((v): v is string => !!v),
      ));
      if (productItemIds.length > 0) {
        const { data: menuRows } = await supabaseAdmin
          .from('products')
          .select('id, price, branch_prices_json')
          .eq('merchant_id', merchantId)
          .in('id', productItemIds);
        const priceById = new Map<string, number>();
        for (const p of (menuRows ?? []) as Array<{ id: string; price: number | null; branch_prices_json: Record<string, unknown> | null }>) {
          const override = p.branch_prices_json && typeof p.branch_prices_json === 'object'
            ? Number((p.branch_prices_json as Record<string, unknown>)[branchId as string])
            : NaN;
          const authoritative = Number.isFinite(override) && override > 0 ? override : Number(p.price ?? 0);
          if (Number.isFinite(authoritative) && authoritative > 0) priceById.set(p.id, authoritative);
        }
        for (const it of items as Array<{ id?: unknown; basePrice?: unknown; price?: unknown; uniqueId?: unknown; name?: unknown }>) {
          if (typeof it.uniqueId === 'string' && (it.uniqueId as string).startsWith('reward-')) continue;
          const pid = typeof it.id === 'string' ? (it.id as string) : null;
          if (!pid) continue;
          const authoritative = priceById.get(pid);
          if (authoritative == null) continue; // not in menu — defer to floor checks above
          const claimed = Number(it.basePrice ?? it.price ?? 0);
          if (claimed < authoritative - 0.01) {
            console.warn('[Orders] Item price understated vs menu — refusing', {
              merchantId, orderId: id, productId: pid, claimed, authoritative,
            });
            return res.status(400).json({
              error: `Item "${typeof it.name === 'string' ? it.name : pid}" is priced below the menu price; refusing to commit.`,
              code: 'ITEM_PRICE_TAMPERED',
            });
          }
        }
      }
    }

    if (orderType !== 'delivery' && orderType !== 'pickup' && orderType !== 'drivethru') {
      return res.status(400).json({ error: 'orderType must be delivery, pickup, or drivethru' });
    }
    // Curbside / "receive from your car" orders carry car identifiers
    // in car_details so the staff can find the vehicle in the lot.
    // All four fields are required when the order type is drivethru —
    // without them the order is operationally useless. We tolerate
    // extra unknown keys (some legacy clients may still send `make` /
    // `plate`) but require the four canonical fields to be non-empty.
    if (orderType === 'drivethru') {
      const cd = carDetails as Record<string, unknown> | null | undefined;
      const needs = ['plate_letters', 'plate_numbers', 'model', 'color'] as const;
      const ok =
        cd != null &&
        typeof cd === 'object' &&
        needs.every((k) => typeof cd[k] === 'string' && (cd[k] as string).trim().length > 0);
      if (!ok) {
        return res.status(400).json({
          error:
            'carDetails must include non-empty plate_letters, plate_numbers, model, and color when orderType=drivethru',
        });
      }
    }

    // ─── Subscription enforcement (REG-1): effective order-intake policy ───
    // This gate previously blocked only merchants whose raw merchants.status
    // was literally 'suspended'. But billing state lives on the SUBSCRIPTION
    // row, not merchants.status (which is only pending/active/suspended): a
    // subscription that lapsed, expired, was cancelled past its period, or is
    // past_due beyond its grace window leaves merchants.status untouched until
    // a sync cron runs — so a merchant whose plan lapsed could keep taking
    // mobile orders. Mirror nooksweb's canonical
    // getMerchantSubscriptionPolicy.orderIntakeEnabled (lib/subscription-policy.ts)
    // so the mobile commit path and the web storefront agree on who may order.
    // Merchants that pass: in an active free trial, a healthy active
    // subscription, cancelled/expired but still inside the paid period, or in
    // the post-renewal grace window. Denied: deleted, suspended, expired
    // trial with no sub, or a lapsed/past-due sub past grace.
    let merchantInTrial = false;
    if (supabaseAdmin) {
      const SUBSCRIPTION_GRACE_MS = 2 * 24 * 60 * 60 * 1000; // SUBSCRIPTION_GRACE_PERIOD_DAYS (nooksweb)
      const nowMs = Date.now();
      const [{ data: merchantRow }, { data: latestSub }] = await Promise.all([
        supabaseAdmin
          .from('merchants')
          .select('status, trial_ends_at, trial_started_at, deleted_at')
          .eq('id', merchantId)
          .maybeSingle(),
        supabaseAdmin
          .from('subscriptions')
          .select('status, current_period_end_at, expires_at')
          .eq('merchant_id', merchantId)
          .order('current_period_end_at', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const parseMs = (v: string | null | undefined): number | null => {
        if (!v) return null;
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
      };

      // Only apply the gate when we actually resolved the merchant row. A
      // null/failed merchant lookup falls through un-blocked (as before) so a
      // transient read can't lock out a legitimately-active merchant; the
      // order still validates the merchant/branch elsewhere.
      if (merchantRow) {
        const trialEndsMs = parseMs(merchantRow.trial_ends_at);
        const trialActive = trialEndsMs != null && trialEndsMs > nowMs;

        const merchantStatus =
          typeof merchantRow.status === 'string' ? merchantRow.status.toLowerCase() : null;

        let orderIntakeEnabled: boolean;
        let inTrial = false;
        if (merchantRow.deleted_at) {
          // Soft-deleted merchant — terminal suspended.
          orderIntakeEnabled = false;
        } else if (merchantStatus === 'suspended') {
          // Explicit admin/billing suspension — preserve the original hard
          // block regardless of any lingering active subscription row.
          orderIntakeEnabled = false;
        } else if (!latestSub) {
          // Never subscribed: fully open only while the free trial runs.
          orderIntakeEnabled = trialActive;
          inTrial = trialActive;
        } else {
          const subStatus = typeof latestSub.status === 'string' ? latestSub.status : '';
          const periodEndMs =
            parseMs(latestSub.current_period_end_at) ?? parseMs(latestSub.expires_at);
          if (subStatus === 'cancelled' || subStatus === 'expired') {
            // Auto-renew off / ended: valid until the paid period actually ends.
            orderIntakeEnabled = periodEndMs != null && periodEndMs > nowMs;
          } else if (
            subStatus === 'past_due' ||
            (subStatus === 'active' && periodEndMs != null && periodEndMs <= nowMs)
          ) {
            // Renewal failed or the period lapsed — allowed only within grace.
            const graceEndMs = periodEndMs != null ? periodEndMs + SUBSCRIPTION_GRACE_MS : null;
            orderIntakeEnabled = graceEndMs != null && nowMs <= graceEndMs;
          } else {
            // Healthy active subscription (period still open / renewed).
            orderIntakeEnabled = true;
          }
        }

        if (!orderIntakeEnabled) {
          return res.status(403).json({ error: 'Merchant is currently suspended. Orders cannot be placed.' });
        }

        // Trial merchants accrue NO payment-processing fee. Trial only ever
        // applies to merchants without any subscription row — the moment a
        // subscription exists (they subscribed mid-trial), fees resume.
        merchantInTrial = inTrial;
      }
    }

    // ─── Branch effectively-closed gate ───
    // Manual close / busy timer / outside scheduled hours all reject the
    // order HERE, on BOTH commits. The first commit (relayToNooks=false)
    // runs before the card charge, so a customer at a closed branch is
    // blocked before paying. The final commit re-checks (store may have
    // closed mid-checkout); since the card was charged between the two
    // commits, a final-commit rejection voids the charge first. This
    // lookup also closes the old hole where branchId was never verified
    // to belong to the merchant. Billing closure is handled by the REG-1
    // gate above.
    if (supabaseAdmin) {
      const storeGate = await checkBranchOrderable(supabaseAdmin, { merchantId, branchId, orderType });
      if (!storeGate.ok) {
        // Both commits: Apple Pay / SDK card charges land BEFORE the
        // first commit, so a first-commit rejection must void too (the
        // helper no-ops when there's no real Moyasar payment id).
        await voidChargeOnRejectedCommit(paymentId, merchantId, `store gate (${storeGate.code})`);
        return res.status(storeGate.status).json({
          error: storeGate.error,
          code: storeGate.code,
          ...(storeGate.closedReason ? { closed_reason: storeGate.closedReason } : {}),
          ...(storeGate.reopensAt !== undefined ? { reopens_at: storeGate.reopensAt } : {}),
        });
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
    // SCAL-003: the final commit verifies the card payment EXACTLY ONCE (below,
    // where the fixed 2s sleep used to be). This request-local holds that
    // result so the pre-relay gate can reuse it instead of a third Moyasar
    // round-trip.
    let finalPaymentVerification: Awaited<ReturnType<typeof verifyPaidPayment>> | null = null;
    // Final commits skip this entry verify: nothing between here and the
    // hardened post-delay verify below has side effects, so that gate (plus
    // the pre-relay one) still rejects unpaid payments before any money
    // moves — running a third verify here just added a Moyasar round-trip
    // to every checkout. First commits (relayToNooks=false) keep it as
    // their only verification.
    if (isMoyasarPaymentId && existing?.id !== id && relayToNooks !== true) {
      const verification = await verifyPaidPayment(trimmedPaymentId, expectedHalalsForVerify, merchantId, id);
      if (!verification.ok) {
        // M9: transient Moyasar error (429/5xx/timeout/network) — the
        // payment may well be paid; ask the client to retry instead of
        // declining a possibly-paid order with a 402.
        if (verification.retryable) {
          console.warn(
            '[Orders] Verify hit transient Moyasar error — asking client to retry:',
            trimmedPaymentId,
            verification.reason,
          );
          return res.status(503).json({
            error: 'Payment verification is temporarily unavailable. Please retry in a moment — you have not been charged twice.',
            retryable: true,
            ...(verification.retryAfter ? { retryAfter: verification.retryAfter } : {}),
          });
        }
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
      promoScope === 'delivery' || promoScope === 'total' || promoScope === 'order_total' ? promoScope : null;
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

    // ─── Server-validated cashback amount (R2 fix) ───
    // The client sends `cashbackAmountSar` / `loyaltyDiscountSar` on
    // /commit and we'd previously relay it straight to Foodics. The
    // actual cashback deduction lives in loyalty_transactions, written
    // by /redeem-cashback BEFORE /commit. A tampered client could send
    // loyaltyDiscountSar=1000 for a 100 SAR order even though only
    // 5 SAR was actually redeemed — Foodics would mint a 900 SAR ghost
    // "cashback payment" line on the receipt and the merchant POS
    // reconciliation would be junk.
    //
    // Fix: read the actual redeem row, require the client claim to
    // match within 0.01 SAR, and use the DB value (not the client
    // value) downstream. The amount that hits Foodics is now always
    // the value the customer actually paid from cashback.
    const claimedCashbackSar = Math.max(
      typeof cashbackAmountSar === 'number' && cashbackAmountSar > 0 ? Number(cashbackAmountSar) : 0,
      typeof loyaltyDiscountSar === 'number' && loyaltyDiscountSar > 0 ? Number(loyaltyDiscountSar) : 0,
    );
    let validatedCashbackSar = 0;
    let loyaltyCfgConfigVersion: number | null = null;
    if (claimedCashbackSar > 0.009) {
      // ─── Loyalty-type gate ───
      // A SAR money-discount at checkout is a CASHBACK feature. Points
      // merchants' customers redeem points for reward ITEMS (milestones)
      // only — the old app had a toggle that converted points into a cash
      // discount at point_value_sar; the server now refuses that outright
      // on BOTH commits (the first commit runs before the card charge, so
      // stale clients are blocked before paying). The one legitimate
      // exception: a customer still draining a legacy cashback balance
      // after the merchant switched cashback→points — their member
      // profile keeps active_loyalty_type='cashback' until it drains.
      const [{ data: loyaltyCfg }, { data: memberProfile }] = await Promise.all([
        supabaseAdmin
          .from('loyalty_config')
          .select('loyalty_type, max_cashback_per_order_sar, config_version')
          .eq('merchant_id', merchantId)
          .maybeSingle(),
        supabaseAdmin
          .from('loyalty_member_profiles')
          .select('active_loyalty_type')
          .eq('merchant_id', merchantId)
          .eq('customer_id', user.id)
          .maybeSingle(),
      ]);
      const cashbackAllowed =
        loyaltyCfg?.loyalty_type === 'cashback' || memberProfile?.active_loyalty_type === 'cashback';
      if (!cashbackAllowed) {
        // Both commits — see the store gate note (charge may precede
        // the first commit on the Apple Pay / SDK card paths).
        await voidChargeOnRejectedCommit(paymentId, merchantId, 'loyalty-type gate');
        return res.status(400).json({
          error:
            'Points can only be redeemed for rewards from the loyalty page — not as a cash discount. Remove the discount and try again.',
          code: 'LOYALTY_CASH_DISCOUNT_NOT_ALLOWED',
        });
      }
      const capSar =
        loyaltyCfg?.max_cashback_per_order_sar != null ? Number(loyaltyCfg.max_cashback_per_order_sar) : null;
      if (capSar != null && Number.isFinite(capSar) && capSar > 0 && claimedCashbackSar - capSar > 0.01) {
        await voidChargeOnRejectedCommit(paymentId, merchantId, 'cashback cap gate');
        return res.status(400).json({
          error: `Maximum cashback per order is ${capSar} SAR.`,
          code: 'CASHBACK_OVER_CAP',
        });
      }

      // Gates passed. The actual atomic deduction happens further down,
      // AFTER the hardened Moyasar re-verify (no side effects may run
      // before it) — see the "active server-side cashback redemption"
      // block. First commits never deduct.
      validatedCashbackSar = +claimedCashbackSar.toFixed(2);
      loyaltyCfgConfigVersion =
        typeof loyaltyCfg?.config_version === 'number' ? loyaltyCfg.config_version : null;
    }

    if (isFinalCommit) {
      // ─── ORD-4 guard: refuse re-commit of an already-reversed order ───
      // The final commit deducts wallet/promo/cashback/milestone below and
      // only THEN upserts the confirmed row. If that upsert fails we reverse
      // the deductions (see the commitError branch), which for wallet orders
      // writes a compensating 'refund' entry. But the wallet spend is guarded
      // by a per-order unique index, so a re-debit is impossible — re-committing
      // the SAME order id after a reversal would reuse the netted-out spend and
      // mint a $0 "free" order. The client keeps the same order id across a
      // manual retry, so this is reachable. If a wallet refund already exists
      // for this order, it was reversed: reject and make the customer start a
      // fresh order (their balance was already restored).
      const { data: priorReversal } = await supabaseAdmin
        .from('customer_wallet_transactions')
        .select('id')
        .eq('customer_id', user.id)
        .eq('merchant_id', merchantId)
        .eq('order_id', id)
        .eq('entry_type', 'refund')
        .maybeSingle();
      if (priorReversal) {
        return res.status(409).json({
          error: 'This order was reversed after a failed attempt. Please start a new order.',
          code: 'ORDER_ALREADY_REVERSED',
        });
      }
      // Same guard for cashback-covers-all orders (no wallet ledger row
      // to catch them): the reversal machinery writes a cashback restore
      // marker (type='earn', loyalty_type='cashback', source='refund').
      // Without this, a retried commit of the SAME order id would hit the
      // redeem RPC's 'duplicate' path (the original redeem row survives
      // the reversal), sail through with a matching amount, and mint the
      // discount a second time against a balance that was already
      // restored — a free order funded by the merchant.
      if (claimedCashbackSar > 0.009) {
        const { data: priorCashbackRestore } = await supabaseAdmin
          .from('loyalty_transactions')
          .select('id')
          .eq('customer_id', user.id)
          .eq('merchant_id', merchantId)
          .eq('order_id', id)
          .eq('type', 'earn')
          .eq('loyalty_type', 'cashback')
          .eq('source', 'refund')
          .maybeSingle();
        if (priorCashbackRestore) {
          return res.status(409).json({
            error: 'This order was reversed after a failed attempt. Please start a new order.',
            code: 'ORDER_ALREADY_REVERSED',
          });
        }
      }

      // ─── Phase 6: auto-enroll (customer, merchant) ───
      // Establish a row in merchant_customers so future code can rely
      // on a single source of truth for "is C enrolled at M". The
      // RPC is idempotent on the primary key so retried commits are
      // safe. Non-fatal — if it fails we still process the order.
      try {
        await supabaseAdmin.rpc('enroll_merchant_customer', {
          p_merchant_id: merchantId,
          p_customer_id: user.id,
          p_via: 'order_commit',
        });
      } catch (e: any) {
        console.warn('[Orders] enroll_merchant_customer failed (non-fatal):', e?.message);
      }

      // ─── Single Moyasar verification (no fixed sleep) ───
      // SCAL-003: verify ONCE, immediately — the old code slept 2s on every
      // card checkout to let a 3DS-just-authorized 'initiated' state settle to
      // 'paid'. That 2s is now spent by the CLIENT, and only when needed: if
      // the payment is still settling (or the verify hit a transient error)
      // we return 202 PAYMENT_SETTLING and the client retries the SAME commit
      // (same order + payment id ⇒ idempotent, NO new charge) at 1s/2s/4s.
      // This still runs BEFORE any side effect (cashback/wallet/promo below),
      // so an unpaid payment can never move money; amount tampering is still
      // caught by expectedHalalsForVerify. A terminal decline is a hard 402.
      if (isMoyasarPaymentId) {
        finalPaymentVerification = await verifyPaidPayment(trimmedPaymentId, expectedHalalsForVerify, merchantId, id);
        if (!finalPaymentVerification.ok) {
          if (isPaymentStillSettling(finalPaymentVerification.status, !!finalPaymentVerification.retryable)) {
            console.warn(
              '[Orders] Final verify — payment still settling, asking client to retry:',
              trimmedPaymentId,
              'status:',
              finalPaymentVerification.status,
              finalPaymentVerification.reason,
            );
            return res.status(202).json({
              success: false,
              pending: true,
              code: 'PAYMENT_SETTLING',
              // Fixed hint; the client owns the escalating 1s/2s/4s backoff.
              retryAfterMs: 1000,
            });
          }
          console.warn(
            '[Orders] Final verify failed — refusing side effects:',
            trimmedPaymentId,
            'status:',
            finalPaymentVerification.status,
          );
          return res.status(402).json({
            error: `Payment not confirmed (${finalPaymentVerification.reason}). The order was not created.`,
            moyasarStatus: finalPaymentVerification.status,
          });
        }
      }

      // ─── Active server-side cashback redemption ───
      // Replaces the old passive "a /redeem-cashback ledger row must
      // already exist" match: the app fires /redeem-cashback only AFTER
      // a successful final commit, so requiring the row here deadlocked
      // every cashback order — and a client that skipped the call kept
      // both the discount and the balance. The commit itself now performs
      // the atomic deduction via the same idempotent RPC /redeem-cashback
      // uses (partial unique index per order), so old clients' post-commit
      // call dedupes and commit retries are safe. Runs after the hardened
      // verify (first side effect); reversal on downstream failure remains
      // restoreCashbackForRefund (amount-based) — unchanged. The loyalty-
      // type + cap gates already ran pre-charge on both commits.
      if (validatedCashbackSar > 0.009) {
        const { data: balRow } = await supabaseAdmin
          .from('loyalty_cashback_balances')
          .select('balance_sar, config_version')
          .eq('customer_id', user.id)
          .eq('merchant_id', merchantId)
          .order('config_version', { ascending: false })
          .limit(1)
          .maybeSingle();
        const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('redeem_loyalty_cashback', {
          p_customer_id: user.id,
          p_merchant_id: merchantId,
          p_amount_sar: validatedCashbackSar,
          p_order_id: id,
          p_reference_type: null,
          p_reference_id: null,
          p_source: 'app',
          p_description: `Used ${validatedCashbackSar} SAR cashback`,
          p_config_version: balRow?.config_version ?? loyaltyCfgConfigVersion,
          p_branch_id: branchId,
        });
        if (rpcErr) {
          // Nothing else has been deducted yet — a retry is safe and the
          // RPC is idempotent per order.
          console.error('[Orders] redeem_loyalty_cashback RPC error:', rpcErr.message);
          return res.status(503).json({
            error: 'Could not apply the cashback discount. Please retry in a moment.',
            retryable: true,
          });
        }
        const cashbackRpcResult = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
          | { status?: string }
          | null;
        if (cashbackRpcResult?.status === 'insufficient') {
          await voidChargeOnRejectedCommit(paymentId, merchantId, 'cashback insufficient');
          return res.status(400).json({
            error: 'Insufficient cashback balance for the claimed discount. The card payment was reversed.',
            code: 'INSUFFICIENT_CASHBACK',
          });
        }
        if (cashbackRpcResult?.status === 'duplicate') {
          // A redemption for this order already exists (client pre-redeem
          // or a commit retry). Amounts must agree — otherwise the claim
          // and the ledger diverge and Foodics would show a ghost line.
          const { data: redeemTxn } = await supabaseAdmin
            .from('loyalty_transactions')
            .select('amount_sar')
            .eq('customer_id', user.id)
            .eq('merchant_id', merchantId)
            .eq('order_id', id)
            .eq('type', 'redeem')
            .eq('loyalty_type', 'cashback')
            .maybeSingle();
          const actualRedeemedSar = redeemTxn ? Math.abs(Number(redeemTxn.amount_sar ?? 0)) : 0;
          if (Math.abs(validatedCashbackSar - actualRedeemedSar) > 0.01) {
            await voidChargeOnRejectedCommit(paymentId, merchantId, 'cashback mismatch');
            return res.status(400).json({
              error: `Cashback amount mismatch: order claims ${validatedCashbackSar.toFixed(2)} SAR but ${actualRedeemedSar.toFixed(2)} SAR was redeemed. The card payment was reversed.`,
              code: 'CASHBACK_MISMATCH',
            });
          }
        }
        // The balance changed outside /redeem-cashback (which used to
        // notify) — push the Apple/Google Wallet pass so it doesn't show
        // the stale pre-redemption cashback.
        notifyPassUpdateSafe(user.id, merchantId);
      }

      // ─── Atomic promo redemption ───
      // Idempotent via the redeem_promo RPC's `on conflict (merchant,
      // code, order_id) do nothing` — a retried final commit returns
      // ok=true 'Already redeemed' without re-incrementing usage_count.
      // The cancel path (refundOrderToWallet) calls unredeem_promo
      // which rolls back the row + decrements usage_count.
      //
      // Note: we deliberately do NOT gate on `existing?.id !== id`.
      // The first commit (relayToNooks=false) creates the order row,
      // so by the time the final commit runs, `existing` ALWAYS
      // matches `id`. The old gate skipped redeem_promo on every
      // final commit, leaving promo_redemptions empty — which let
      // the same customer reuse a "1 per user" code on a second
      // order because neither the validate endpoint nor the next
      // final commit's RPC could find a prior redemption to block
      // against. The RPC's own idempotency is the right defense
      // against retries; the `existing` check was the bug.
      if (trimmedPromoCode && promoDiscountValue > 0 && promoScopeNormalized) {
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
            } catch (unredeemErr: any) {
              // #15: was a silent catch. A failed unredeem burns the promo
              // slot (usage_count stays incremented, the redemption row
              // lingers) with zero visibility — surface it so ops can fix it.
              console.error('[Orders] unredeem_promo failed after wallet-debit failure (promo slot may be stuck)', {
                merchantId,
                orderId: id,
                error: unredeemErr?.message,
              });
              captureError(unredeemErr, {
                component: 'orders.commit.unredeemPromo',
                merchantId,
                customerId: user.id,
                orderId: id,
              });
            }
          }
          // #7: cashback is redeemed via a separate /redeem-cashback call
          // BEFORE commit. The catch previously reversed promo but NOT
          // cashback, so a wallet-debit failure burned the customer's
          // cashback. Give it back (idempotent — no-ops if already restored).
          if (validatedCashbackSar > 0) {
            try {
              await restoreCashbackForRefund({
                customerId: user.id,
                merchantId,
                amountSar: validatedCashbackSar,
                orderId: id,
              });
            } catch (_e) { /* non-fatal */ }
          }
          if (e?.message === 'INSUFFICIENT_WALLET_BALANCE') {
            return res.status(400).json({ error: 'INSUFFICIENT_WALLET_BALANCE' });
          }
          // Phase A/E: wallet debit failures other than INSUFFICIENT_
          // WALLET_BALANCE are DB/RPC errors that previously surfaced
          // as a generic 500 with no tenant context. Ship to Sentry
          // with full IDs so the right merchant pops in the dashboard.
          console.error('[Orders] Wallet debit failed during /commit', {
            merchantId,
            customerId: user.id,
            orderId: id,
            walletAppliedSar,
            error: e?.message,
          });
          captureError(e, {
            component: 'orders.commit.walletDebit',
            merchantId,
            customerId: user.id,
            orderId: id,
            extra: { walletAppliedSar },
          });
          return res.status(500).json({ error: e?.message || 'Wallet debit failed' });
        }
      }

      // ─── Free-reward milestone redemption (server-authoritative) ───
      // The mobile app used to fire a deprecated /redeem-stamp-milestone call
      // AFTER commit with no idempotencyKey, so it 400'd and the customer's
      // points were NEVER deducted — a free item they could re-claim forever.
      // Deduct here instead, keyed to this order so a retried commit can't
      // double-deduct. Non-blocking: a failure (not enough points / inactive /
      // race) is logged, never blocks the order. The cancel path reverses
      // these via restoreStampMilestonesForRefund.
      if (claimedMilestones.length > 0) {
        try {
          const r = await consumeOrderMilestones(user.id, merchantId, claimedMilestones, id);
          if (r.failed.length > 0) {
            console.warn('[Orders] Some milestone redemptions did not deduct', {
              merchantId,
              customerId: user.id,
              orderId: id,
              failed: r.failed,
            });
          }
        } catch (e: any) {
          console.error('[Orders] consumeOrderMilestones threw (non-blocking)', {
            merchantId,
            customerId: user.id,
            orderId: id,
            error: e?.message,
          });
          captureError(e, {
            component: 'orders.commit.milestoneConsume',
            merchantId,
            customerId: user.id,
            orderId: id,
          });
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
      // Use validatedCashbackSar (DB-truth on final commit, client
      // claim on first commit) instead of the raw client field — R2 fix.
      cashback_paid_sar: validatedCashbackSar > 0 ? Number(validatedCashbackSar.toFixed(2)) : 0,
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
      promo_scope: promoScope === 'delivery' || promoScope === 'total' || promoScope === 'order_total' ? promoScope : null,
      car_details:
        orderType === 'drivethru' && carDetails && typeof carDetails === 'object'
          ? {
              plate_letters: String((carDetails as Record<string, unknown>).plate_letters ?? '').trim(),
              plate_numbers: String((carDetails as Record<string, unknown>).plate_numbers ?? '').trim(),
              model: String((carDetails as Record<string, unknown>).model ?? '').trim(),
              color: String((carDetails as Record<string, unknown>).color ?? '').trim(),
            }
          : null,
      // QR + dine-in attribution. We pull server-truth values from the
      // resolved QR row (validation block above) instead of trusting
      // client-supplied tableId/foodicsTableName — prevents a tampered
      // client from claiming a table they aren't at.
      qr_code_id: qrCodeId && resolvedQrCode ? qrCodeId : null,
      foodics_table_id: resolvedQrCode?.foodics_table_id ?? null,
      foodics_table_name: resolvedQrCode?.foodics_table_name ?? null,
      guests:
        orderType === 'dine_in'
          ? Math.max(1, Math.floor(Number(guests ?? 1)))
          : null,
      // Per-order processing fee billed to the merchant (NOT to the
      // end customer — the customer's total never includes it). Recorded
      // at commit so cancelled / refused orders flip to 'cancelled' and
      // delivered orders flip to 'earned' downstream. Aggregated monthly
      // and invoiced to the merchant out-of-band. Pickup + delivery both
      // count; the customer-received handler only updates the status,
      // not the amount. Trial merchants accrue nothing ('trial' status
      // keeps the Moyasar-webhook fallback from re-accruing later).
      commission_amount: merchantInTrial ? 0 : 1,
      commission_rate: 0,
      commission_status: merchantInTrial ? 'trial' : 'pending',
      // Visibility gate: only orders with payment_confirmed_at + a
      // foodics_order_id appear in the customer app and merchant
      // dashboard. Confirmed only on the FINAL commit, after the
      // hardened post-delay re-verify passed and side effects fired.
      // First-commit drafts have NULL here and stay invisible until
      // the second commit promotes them.
      payment_confirmed_at: isFinalCommit ? new Date().toISOString() : null,
      // ─── SCAL-004 shadow enqueue (ADDITIVE — worker disabled by default) ───
      // On the FINAL commit, stamp the durable Foodics-dispatch queue
      // metadata so the finalized paid order is ALSO a claimable job for the
      // (currently disabled) order-dispatch worker + due-aware reconciler.
      // This is strict SHADOW mode: the inline relay below stays the single
      // source of truth and still runs synchronously exactly as before — on
      // success it overwrites foodics_relay_status to 'ok' and sets
      // foodics_order_id, which removes the row from the claim set; on failure
      // it refunds and flips status to 'Cancelled', which also removes it.
      // These two columns therefore only make the row claimable in the window
      // before the inline relay finishes (or if it never landed a Foodics id),
      // which is precisely the durable backstop SCAL-004 introduces. No
      // behaviour changes today because ORDER_DISPATCH_WORKER_ENABLED gates
      // the worker off. First-commit drafts (isFinalCommit=false) get nothing
      // here — they stay invisible and are never claimable.
      ...(isFinalCommit
        ? {
            foodics_relay_status: 'pending',
            foodics_relay_next_attempt_at: new Date().toISOString(),
          }
        : {}),
      updated_at: new Date().toISOString(),
    };

    const { data: savedOrder, error: commitError } = await supabaseAdmin
      .from('customer_orders')
      .upsert(payload, { onConflict: 'id' })
      .select('id, status, payment_id, created_at, updated_at')
      .single();

    if (commitError || !savedOrder) {
      console.error('[Orders] Order upsert failed during /commit', {
        merchantId,
        customerId: user.id,
        orderId: id,
        isFinalCommit,
        error: commitError?.message,
      });
      captureError(commitError ?? new Error('Order upsert returned no row'), {
        component: 'orders.commit.upsert',
        merchantId,
        customerId: user.id,
        orderId: id,
      });
      // ─── ORD-4: reverse the deductions this failed commit already applied ───
      // On the FINAL commit the promo redeem, wallet debit, milestone consume,
      // and (pre-commit) cashback redeem — plus the card charge — all fire
      // ABOVE this upsert. A failed upsert must NOT leave the customer's
      // balances burned with no order (the reported ORD-4 loss). Reverse with
      // the same helpers the refund path uses. Prefer refundOrderToWallet: it
      // drives off the order row + the ACTUAL ledger (never phantom-credits)
      // and is fully idempotent. For the two-commit card flow the draft row
      // exists, so this reverses card+wallet+cashback+milestone+promo in one
      // consistent path; a later retry is blocked because the Moyasar charge is
      // now voided (verify → 402). For the SINGLE-commit wallet/reward flow the
      // failing upsert WAS the row's own creation, so refundOrderToWallet 404s
      // — fall back to reversing each applied deduction directly off the
      // (customer, merchant, order_id) ledgers, which don't need the row. Each
      // deduction is known to have succeeded (a failure would have returned
      // before this upsert), so these credit-backs are exact, not phantom.
      if (isFinalCommit) {
        let reversedViaRow = false;
        try {
          const rev = await refundOrderToWallet(id, 'system', 'Order commit failed — reversing side effects');
          if (rev.ok) {
            reversedViaRow = true;
          } else if (rev.status === 404) {
            reversedViaRow = false; // row never landed — use the direct fallback below
          } else {
            // Row existed but the reversal only partially completed; it is
            // idempotent and the abandoned-payment sweep will retry it. Do NOT
            // also run the direct fallback (that would be a second pass over
            // the same row).
            reversedViaRow = true;
            console.error('[Orders] commit-failure reversal via refundOrderToWallet returned not-ok', {
              merchantId,
              customerId: user.id,
              orderId: id,
              error: rev.error,
              status: rev.status,
            });
            captureError(new Error(`commit-failure reversal not-ok: ${rev.error}`), {
              component: 'orders.commit.upsertReversal',
              merchantId,
              customerId: user.id,
              orderId: id,
            });
          }
        } catch (revErr: any) {
          reversedViaRow = false;
          console.error('[Orders] commit-failure reversal via refundOrderToWallet threw', {
            merchantId,
            customerId: user.id,
            orderId: id,
            error: revErr?.message,
          });
          captureError(revErr, {
            component: 'orders.commit.upsertReversal',
            merchantId,
            customerId: user.id,
            orderId: id,
          });
        }

        if (!reversedViaRow) {
          // Direct, row-less reversal. Promo unredeem / cashback restore /
          // milestone restore are self-guarding (they read the actual ledger
          // by order_id and no-op if nothing was applied). The wallet credit
          // is safe because reaching this branch with walletAppliedSar > 0
          // implies a successful debit (walletPaymentId is set), and
          // creditWalletForRefund is idempotent per order_id. The card, if any,
          // is voided so the customer is whole and a retry is verify-blocked.
          if (trimmedPromoCode) {
            try {
              await supabaseAdmin.rpc('unredeem_promo', { p_merchant_id: merchantId, p_order_id: id });
            } catch (e: any) {
              console.error('[Orders] commit-failure direct unredeem_promo failed', { merchantId, orderId: id, error: e?.message });
              captureError(e, { component: 'orders.commit.upsertReversal.promo', merchantId, customerId: user.id, orderId: id });
            }
          }
          if (
            walletAppliedSar > 0 &&
            typeof walletPaymentId === 'string' &&
            walletPaymentId.startsWith('wallet:') &&
            !walletPaymentId.startsWith('wallet:pending')
          ) {
            try {
              await creditWalletForRefund({
                customerId: user.id,
                merchantId,
                amountSar: walletAppliedSar,
                orderId: id,
                complaintId: null,
                note: 'Order commit failed — wallet refund',
              });
            } catch (e: any) {
              console.error('[Orders] commit-failure direct wallet credit failed', { merchantId, customerId: user.id, orderId: id, amountSar: walletAppliedSar, error: e?.message });
              captureError(e, { component: 'orders.commit.upsertReversal.wallet', merchantId, customerId: user.id, orderId: id });
            }
          }
          if (validatedCashbackSar > 0) {
            try {
              await restoreCashbackForRefund({ customerId: user.id, merchantId, amountSar: validatedCashbackSar, orderId: id });
            } catch (e: any) {
              console.warn('[Orders] commit-failure direct cashback restore failed (non-blocking)', { merchantId, customerId: user.id, orderId: id, error: e?.message });
              captureError(e, { component: 'orders.commit.upsertReversal.cashback', merchantId, customerId: user.id, orderId: id });
            }
          }
          if (claimedMilestones.length > 0) {
            try {
              await restoreStampMilestonesForRefund({
                customerId: user.id,
                merchantId,
                milestoneIds: claimedMilestones,
                stampsConsumed: typeof stampsConsumed === 'number' && stampsConsumed > 0 ? Math.floor(stampsConsumed) : 0,
                orderId: id,
              });
            } catch (e: any) {
              console.warn('[Orders] commit-failure direct milestone restore failed (non-blocking)', { merchantId, customerId: user.id, orderId: id, error: e?.message });
              captureError(e, { component: 'orders.commit.upsertReversal.milestone', merchantId, customerId: user.id, orderId: id });
            }
          }
          if (isMoyasarPaymentId) {
            try {
              await cancelPayment(trimmedPaymentId, undefined, merchantId);
            } catch (e: any) {
              console.error('[Orders] commit-failure direct card void failed', { merchantId, orderId: id, error: e?.message });
              captureError(e, { component: 'orders.commit.upsertReversal.card', merchantId, customerId: user.id, orderId: id });
            }
          }
        }
      }
      return res.status(500).json({ error: commitError?.message || 'Failed to commit order' });
    }

    if (isFinalCommit) {
      // Recovery stamping — the cart-abandonment cron (server/cron/
      // cartAbandonment.ts) records abandoned carts but nothing marked
      // them recovered until now. A confirmed order within 24h of the
      // abandonment claims the most recent unrecovered rows.
      try {
        await supabaseAdmin
          .from('abandoned_carts')
          .update({ recovered_at: new Date().toISOString(), recovered_order_id: id })
          .eq('merchant_id', merchantId)
          .eq('customer_id', user.id)
          .is('recovered_at', null)
          .gte('abandoned_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      } catch (recoveryErr) {
        console.warn('[commit] abandoned-cart recovery stamping failed (non-fatal):', recoveryErr);
      }
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
      // SCAL-003: reuse the single verification from above instead of a third
      // Moyasar round-trip. Item 3 already returned 402/202 unless the card
      // payment verified, so for a Moyasar payment finalPaymentVerification.ok
      // is guaranteed true here — this is a defensive invariant that should
      // never fire (a fired invariant means a code path reached relay without
      // verifying, which must fail loudly rather than ship an unverified order
      // to Foodics). The old pre-relay re-verify guarded a paid→failed flip in
      // the window between verify and relay; without the 2s sleep that window
      // is sub-second, and the Foodics webhook + reconciliation still cancel a
      // charge that flips after relay.
      if (isMoyasarPaymentId && !finalPaymentVerification?.ok) {
        throw new Error('Invariant violation: Foodics relay attempted without a verified payment');
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
        promo_scope: promoScope === 'delivery' || promoScope === 'total' || promoScope === 'order_total' ? promoScope : null,
        customer_note: typeof customerNote === 'string' ? customerNote.trim() || null : null,
        // R2 fix: send the server-validated cashback amount to Foodics,
        // not the raw client claim. validatedCashbackSar == the actual
        // loyalty_transactions redeem amount for this order.
        loyalty_discount_sar: validatedCashbackSar > 0 ? validatedCashbackSar : null,
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
        // Curbside / drivethru orders ship to Foodics as a pickup
        // (Foodics has no curbside type), so the plate + car identifiers
        // ride in customer_notes — see nooksweb/lib/foodics-orders.ts.
        // Only forward when the order type warrants it; pickup /
        // delivery orders have no car_details to send.
        car_details:
          orderType === 'drivethru' && carDetails && typeof carDetails === 'object'
            ? {
                plate_letters: String((carDetails as Record<string, unknown>).plate_letters ?? '').trim(),
                plate_numbers: String((carDetails as Record<string, unknown>).plate_numbers ?? '').trim(),
                model: String((carDetails as Record<string, unknown>).model ?? '').trim(),
                color: String((carDetails as Record<string, unknown>).color ?? '').trim(),
              }
            : null,
        // Dine-in: tableId is REQUIRED by Foodics (type=1 without
        // table_id returns 422). foodicsTableName + guests are
        // display-only — nooksweb relay maps them into customer_notes
        // for the printed receipt. qrCodeId rides along so a
        // table-deleted-in-Foodics 422 can auto-archive the QR.
        qr_code_id: resolvedQrCode ? qrCodeId : null,
        table_id: resolvedQrCode?.foodics_table_id ?? null,
        foodics_table_name: resolvedQrCode?.foodics_table_name ?? null,
        guests:
          orderType === 'dine_in'
            ? Math.max(1, Math.floor(Number(guests ?? 1)))
            : null,
      }, {
        customerJwt: (req.headers.authorization || '').toString().replace(/^Bearer\s+/i, '').trim() || null,
      });

      // Store Foodics order ID from relay response. Awaited so the
      // foodics_order_id column is set before this endpoint responds
      // — the customer-app order list filter requires it to be
      // non-null, so a fire-and-forget update would mean the order
      // briefly disappeared from the list right after creation.
      const relayData = relayResult as {
        foodics?: {
          ok?: boolean;
          foodicsOrderId?: string | null;
          error?: string;
          tableUnavailable?: boolean;
          skipped?: boolean;
          reason?: string;
        };
      } | null;
      const foodics = relayData?.foodics;
      const producedFoodicsId =
        foodics?.ok && typeof foodics.foodicsOrderId === 'string' && foodics.foodicsOrderId.trim()
          ? foodics.foodicsOrderId.trim()
          : null;
      if (producedFoodicsId) {
        const { error: foodicsIdErr } = await supabaseAdmin
          .from('customer_orders')
          .update({
            foodics_order_id: producedFoodicsId,
            foodics_relay_status: 'ok',
            foodics_relay_error: null,
            foodics_relay_last_attempt_at: new Date().toISOString(),
          })
          .eq('id', id);
        if (foodicsIdErr) {
          console.warn('[Orders] Failed to store foodics_order_id:', foodicsIdErr.message);
        } else {
          console.log(`[Orders] Stored foodics_order_id for ${id}`);
        }
        // Audit the QR attribution so analytics can answer
        // "what's the order count per QR?" without a join.
        if (qrCodeId && resolvedQrCode) {
          try {
            await supabaseAdmin.from('audit_log').insert({
              merchant_id: merchantId,
              action: 'customer_order.qr_attached',
              payload: {
                order_id: id,
                qr_code_id: qrCodeId,
                foodics_table_id: resolvedQrCode.foodics_table_id ?? null,
                order_type: orderType,
              },
            });
          } catch { /* audit never blocks the commit response */ }
        }
      } else if (foodics && foodics.ok === false) {
        // Foodics relay returned a non-ok response (e.g., bad
        // modifier mapping, branch closed). For dine-in:
        // tableUnavailable=true means the merchant deleted the
        // Foodics table — surface that distinctly so the client
        // shows "Ask staff" instead of a generic error. Both throw
        // into the catch below, which voids the charge + refunds.
        if (foodics.tableUnavailable) {
          throw Object.assign(
            new Error('TABLE_UNAVAILABLE'),
            { code: 'TABLE_UNAVAILABLE' },
          );
        }
        throw new Error(foodics.error || 'Foodics relay returned ok=false');
      } else {
        // ─── PAY-2: relay returned ok:true WITHOUT a foodics order id ───
        // (a `skipped` outcome such as already_created / branch_not_enabled /
        // foodics_not_connected, OR a success return whose id was unparseable).
        // Previously this hit NEITHER branch above, so the row was left
        // payment_confirmed_at + foodics_order_id null + not-Cancelled: a paid
        // order invisible to everyone that nothing reversed. Disambiguate using
        // the shared audit_log: nooksweb writes `foodics.order.created` (with the
        // foodics_order_id) the moment an order actually reaches the POS, and
        // returns reason='already_created' on a later relay for the same order.
        //   • audit row found WITH an id  → the order IS in the POS. Backfill the
        //     id so it becomes visible (covers already_created and an
        //     id-unparseable success). Do NOT refund.
        //   • audit row found WITHOUT an id → in the POS but id unrecoverable →
        //     mark needs-attention, leave the money for reconciliation.
        //   • no audit row → the order was genuinely skipped and never created
        //     in the POS → treat as a relay failure: mark needs-attention, then
        //     throw into the catch to reverse + refund (app-path policy).
        const skipReason =
          foodics && typeof foodics.reason === 'string' && foodics.reason
            ? foodics.reason
            : foodics
              ? 'no_foodics_order_id'
              : 'relay_no_order';
        let loggedFoodicsId: string | null = null;
        let auditRowFound = false;
        try {
          const { data: createdLog } = await supabaseAdmin
            .from('audit_log')
            .select('payload')
            .eq('action', 'foodics.order.created')
            .contains('payload', { internal_order_id: id })
            .maybeSingle();
          if (createdLog) {
            auditRowFound = true;
            const p = (createdLog.payload ?? null) as { foodics_order_id?: string | null } | null;
            loggedFoodicsId =
              p && typeof p.foodics_order_id === 'string' && p.foodics_order_id.trim()
                ? p.foodics_order_id.trim()
                : null;
          }
        } catch (e: any) {
          console.warn('[Orders] relay-skip audit lookup failed', { orderId: id, error: e?.message });
        }

        if (loggedFoodicsId) {
          // Order is in the POS — recover the id, mark relay ok, keep the money.
          const { error: backfillErr } = await supabaseAdmin
            .from('customer_orders')
            .update({
              foodics_order_id: loggedFoodicsId,
              foodics_relay_status: 'ok',
              foodics_relay_error: null,
              foodics_relay_last_attempt_at: new Date().toISOString(),
            })
            .eq('id', id);
          if (backfillErr) {
            console.warn('[Orders] Failed to backfill foodics_order_id from audit_log:', backfillErr.message);
          } else {
            console.log(`[Orders] Backfilled foodics_order_id for ${id} (relay skip: ${skipReason})`);
          }
        } else if (auditRowFound) {
          // Order reached the POS but we can't recover its id. Do NOT refund
          // (that would cancel a real POS order). Surface for reconciliation.
          await supabaseAdmin
            .from('customer_orders')
            .update({
              foodics_relay_status: 'failed',
              foodics_relay_error: `${skipReason}:foodics_id_unrecoverable`.slice(0, 300),
              foodics_relay_attempts: 1,
              foodics_relay_last_attempt_at: new Date().toISOString(),
            })
            .eq('id', id);
          console.error('[Orders] Relay reached POS but foodics id unrecoverable — left for reconciliation', {
            merchantId,
            customerId: user.id,
            orderId: id,
            reason: skipReason,
          });
          captureError(new Error(`Relay in-POS without recoverable foodics id (${skipReason})`), {
            component: 'orders.commit.relaySkip.unrecoverableId',
            merchantId,
            customerId: user.id,
            orderId: id,
          });
        } else {
          // Never reached the POS → relay failure. Stamp attention columns for
          // diagnostics, then throw into the catch to void + refund (matches the
          // ok===false and app-path auto-refund policy). The customer is made
          // whole rather than left with a paid order that never existed.
          try {
            await supabaseAdmin
              .from('customer_orders')
              .update({
                foodics_relay_status: 'failed',
                foodics_relay_error: skipReason.slice(0, 300),
                foodics_relay_attempts: 1,
                foodics_relay_last_attempt_at: new Date().toISOString(),
              })
              .eq('id', id);
          } catch (e: any) {
            console.warn('[Orders] Failed to stamp relay-skip attention columns', { orderId: id, error: e?.message });
          }
          console.error('[Orders] Foodics relay produced no order — treating as failure', {
            merchantId,
            customerId: user.id,
            orderId: id,
            reason: skipReason,
          });
          throw new Error(`Foodics relay produced no order (${skipReason})`);
        }
      }
      } catch (relayErr: any) {
        console.error('[Orders] Foodics relay failed — reversing side effects', {
          merchantId,
          customerId: user.id,
          orderId: id,
          error: relayErr?.message,
        });
        captureError(relayErr, {
          component: 'orders.commit.foodicsRelay',
          merchantId,
          customerId: user.id,
          orderId: id,
        });
        // refundOrderToWallet reverses everything: card via Moyasar
        // void/refund, wallet credit back, cashback restore, stamp
        // restore, promo unredeem. The row stays as Cancelled with
        // refund_status set so the merchant dashboard's filter
        // (foodics_order_id IS NOT NULL) still hides it.
        try {
          const refundResult = await refundOrderToWallet(id, 'system', 'Foodics relay failed');
          if (!refundResult.ok) {
            // refundOrderToWallet returns {ok:false} WITHOUT throwing on
            // partial failure (e.g. wallet credit failed mid-reversal). Don't
            // let that look like success — surface it loudly. The order is left
            // visible/Placed and only partially reversed; the abandoned-payment
            // sweep cron will retry refundOrderToWallet, which is now idempotent
            // at the DB level (credit_customer_wallet dedupes on order_id), so
            // the retry completes the refund without double-crediting.
            console.error('[Orders] Cleanup refund after Foodics failure returned not-ok', {
              merchantId,
              customerId: user.id,
              orderId: id,
              refundError: refundResult.error,
              refundStatus: refundResult.status,
            });
            captureError(new Error(`Incomplete cleanup refund: ${refundResult.error}`), {
              component: 'orders.commit.foodicsRelay.cleanupRefund.notOk',
              merchantId,
              customerId: user.id,
              orderId: id,
            });
          }
        } catch (refundErr: any) {
          console.error('[Orders] Cleanup refund after Foodics failure also failed', {
            merchantId,
            customerId: user.id,
            orderId: id,
            error: refundErr?.message,
          });
          captureError(refundErr, {
            component: 'orders.commit.foodicsRelay.cleanupRefund',
            merchantId,
            customerId: user.id,
            orderId: id,
          });
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
        // Curbside receipt — surface the four car fields the customer
        // entered. carDetails was already shape-validated above.
        carDetails:
          orderType === 'drivethru' && carDetails && typeof carDetails === 'object'
            ? {
                plate_letters: String((carDetails as Record<string, unknown>).plate_letters ?? ''),
                plate_numbers: String((carDetails as Record<string, unknown>).plate_numbers ?? ''),
                model: String((carDetails as Record<string, unknown>).model ?? ''),
                color: String((carDetails as Record<string, unknown>).color ?? ''),
              }
            : null,
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
// Exported (SCAL-004) so the out-of-band Foodics dispatch worker can reuse
// the SAME idempotent cancel/refund the inline relay-failure path uses,
// rather than inventing a new money movement. Export is visibility-only —
// it changes no behaviour of the inline /commit relay.
export async function refundOrderToWallet(
  orderId: string,
  cancelledBy: 'merchant' | 'system',
  reason: string,
): Promise<
  | { ok: true; orderId: string; refundedSar: number; refundMethod: RefundDestination; breakdown: ReversalBreakdown; deduplicated?: boolean }
  | { ok: false; error: string; status: number }
> {
  if (!supabaseAdmin) return { ok: false, error: 'Database not configured', status: 500 };

  const { data: order, error: fetchErr } = await supabaseAdmin
    .from('customer_orders')
    .select('*')
    .eq('id', orderId)
    .single();
  if (fetchErr || !order) return { ok: false, error: 'Order not found', status: 404 };
  // R12 fix: a re-cancellation of an already-cancelled order returns
  // the prior refund info instead of a 4xx error. Lets the dashboard
  // safely retry a 500-on-network without showing the merchant a
  // misleading "already cancelled" error and without triggering a
  // double refund. Delivered orders still block (no refund path).
  if (order.status === 'Cancelled') {
    return {
      ok: true,
      orderId,
      refundedSar: Number(order.refund_amount ?? 0),
      refundMethod: (order.refund_method ?? 'none') as RefundDestination,
      breakdown: {},
      deduplicated: true,
    };
  }
  if (order.status === 'Delivered') {
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
      // Phase A/E: enrich the log with merchant/customer/order context
      // AND ship to Sentry. Pre-fix this was a "non-blocking" warn
      // with no IDs — a customer whose cashback never got restored
      // had no traceable signal beyond a generic log line.
      console.warn('[Orders] Cashback restore failed (non-blocking)', {
        merchantId: order.merchant_id,
        customerId: order.customer_id,
        orderId,
        amountSar: effectiveCashbackPaid,
        error: e?.message,
      });
      captureError(e, {
        component: 'refundOrderToWallet.cashbackRestore',
        merchantId: order.merchant_id,
        customerId: order.customer_id,
        orderId,
        extra: { amountSar: effectiveCashbackPaid },
      });
    }
  }

  // ─── Milestone reversal ───
  // Gate on milestoneIds only — points-based milestones leave stamps_consumed=0,
  // so the old `&& stampsConsumed > 0` skipped their reversal entirely.
  if (milestoneIds.length > 0) {
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
      console.warn('[Orders] Stamp restore failed (non-blocking)', {
        merchantId: order.merchant_id,
        customerId: order.customer_id,
        orderId,
        stampsConsumed,
        milestoneIds,
        error: e?.message,
      });
      captureError(e, {
        component: 'refundOrderToWallet.stampRestore',
        merchantId: order.merchant_id,
        customerId: order.customer_id,
        orderId,
        extra: { stampsConsumed, milestoneIds },
      });
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

  const { data: updatedRows, error: updateErr } = await supabaseAdmin
    .from('customer_orders')
    .update({
      status: 'Cancelled',
      cancellation_reason: reason,
      cancelled_by: cancelledBy,
      refund_status: refundMethod === 'none' ? 'not_required' : 'refunded',
      refund_amount: refundedSarHeadline,
      refund_fee: 0,
      refund_method: refundMethod,
      // #14: stamp when the refund happened so the timeline is recoverable
      // for disputes/reconciliation (refund_status alone carried no time).
      refunded_at: refundMethod === 'none' ? null : new Date().toISOString(),
      // Note: do NOT flip commission_status to 'cancelled' here.
      // Moyasar still charged Nooks for the original payment
      // attempt regardless of the refund, so the platform fee
      // remains billable. Whatever the Moyasar webhook stamped
      // (typically 'earned') stays as-is until the renewal cron
      // marks it 'invoiced'.
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    // #10: CAS guard. Don't clobber a terminal state the order reached
    // concurrently (e.g. a Foodics 'Delivered' webhook landing mid-refund) —
    // the top-of-function check guards Delivered/Cancelled only at read time.
    // The money side-effects already ran, so on a 0-row miss we surface it for
    // reconciliation rather than fail (which could trigger a retry).
    .neq('status', 'Delivered')
    .neq('status', 'Cancelled')
    .select('id');
  if (updateErr) return { ok: false, error: updateErr.message, status: 500 };
  if (!updatedRows || updatedRows.length === 0) {
    console.error('[Orders] Refund status update matched 0 rows — order reached a terminal state mid-refund', {
      orderId,
      cancelledBy,
      refundMethod,
    });
    captureError(new Error('Refund status CAS miss: order terminal mid-refund'), {
      component: 'refundOrderToWallet.statusCAS',
      orderId,
    });
  }

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
  // Suppress the push entirely for abandoned-payment sweeps on
  // orders that never reached Foodics. The customer never saw the
  // order appear (the foodics_order_id filter hides drafts), so
  // notifying them about a cancellation creates a notification for
  // an order they didn't know existed. Wallet/cashback/stamp
  // reversals still happen silently — the ledger is the source of
  // truth.
  //
  // Lead lines are intentionally store-centric. All driver/delivery
  // dispatch wording was removed 2026-05-17: delivery cancellation
  // (driver unavailable, dispatch failure) will get its own
  // separately-designed notification when that path is built out.
  const isAbandonedPaymentSweep =
    cancelledBy === 'system' &&
    typeof reason === 'string' &&
    reason.toLowerCase().startsWith('abandoned payment') &&
    !order.foodics_order_id;
  if (!isAbandonedPaymentSweep) {
    // Customer language preference — per-(merchant, customer), falls back
    // to English when no profile exists. We localize the cancel push here
    // because it's the SOLE cancellation notification the customer sees
    // now (the nooksweb foodics-webhook used to fire a separate bilingual
    // "couldn't make it work" push — removed because it duplicated this
    // one and raced under Foodics webhook retries). Single localized
    // detailed push instead of one brief + one detailed.
    let customerLang: 'en' | 'ar' = 'en';
    try {
      const { data: profile } = await supabaseAdmin
        .from('customer_merchant_profiles')
        .select('language')
        .eq('merchant_id', order.merchant_id)
        .eq('customer_id', order.customer_id)
        .maybeSingle();
      const raw = (profile as { language?: string | null } | null)?.language ?? null;
      if (raw === 'ar') customerLang = 'ar';
    } catch {
      // Profile lookup is best-effort — keep the English default.
    }
    const isArabic = customerLang === 'ar';
    const title = isArabic ? 'تم إلغاء الطلب' : 'Order Cancelled';
    const lead = isArabic
      ? cancelledBy === 'merchant'
        ? 'اضطر المتجر يرفض طلبك.'
        : 'انتهت مهلة الطلب — المتجر ما قبله في الوقت المحدد.'
      : cancelledBy === 'merchant'
        ? 'Your order has been refused by the store.'
        : 'Your order timed out — the store did not accept it in time.';
    const pieces: string[] = [];
    if (cardReturnedToCustomer && effectiveCardPaid > 0) {
      if (isArabic) {
        pieces.push(
          moyasarMethod === 'void'
            ? `${effectiveCardPaid} ريال راح ترجع لبطاقتك خلال ساعات`
            : `${effectiveCardPaid} ريال راجعة لبطاقتك (خلال 1-3 أيام عمل)`,
        );
      } else {
        pieces.push(
          moyasarMethod === 'void'
            ? `${effectiveCardPaid} SAR will be returned to your card within a few hours`
            : `${effectiveCardPaid} SAR is being returned to your card (1-3 business days)`,
        );
      }
    }
    if (breakdown.wallet && breakdown.wallet.amountSar > 0) {
      pieces.push(
        isArabic
          ? `${breakdown.wallet.amountSar} ريال أُضيفت لمحفظتك`
          : `${breakdown.wallet.amountSar} SAR credited to your wallet`,
      );
    }
    if (breakdown.cashback && breakdown.cashback.amountSar > 0 && !breakdown.cashback.alreadyRestored) {
      pieces.push(
        isArabic
          ? `${breakdown.cashback.amountSar} ريال كاش باك مستردّة`
          : `${breakdown.cashback.amountSar} SAR cashback restored`,
      );
    }
    if (breakdown.stamps && breakdown.stamps.count > 0 && !breakdown.stamps.alreadyRestored) {
      pieces.push(
        isArabic
          ? `${breakdown.stamps.count} أختام مستردّة`
          : `${breakdown.stamps.count} stamps restored`,
      );
    }
    const refundLine = pieces.length
      ? `${pieces.join(isArabic ? '، ' : ', ')}.`
      : isArabic
        ? 'ما تم خصم أي مبلغ من بطاقتك، لذلك ما في شي يحتاج استرداد.'
        : 'No charge was made to your card, so nothing needs to be refunded.';
    sendPushToCustomer(order.customer_id, title, `${lead} ${refundLine}`, order.merchant_id);
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
    // Two cases the sweep handles:
    //   1) ABANDONED PAYMENT (foodics_order_id IS NULL) — the order
    //      never reached the merchant's POS. Customer either closed
    //      3DS mid-flow or the final commit's hardened verify
    //      rejected. Just mark Cancelled, void Moyasar if needed.
    //      No side effects fired on our side (Option A refactor) so
    //      no refunds to issue.
    //   2) NO-ACCEPT TIMEOUT (foodics_order_id IS NOT NULL but still
    //      'Placed' after 5 min) — the cashier hasn't tapped Accept
    //      within 5 min. Auto-cancel: void Moyasar, credit wallet,
    //      restore cashback, restore stamps, unredeem promo, and
    //      tell Foodics so the POS shows it as Void.
    //
    // Bound: only sweep orders 5-30 min old. The lower bound is the
    // grace window for the cashier to accept; the upper bound stops
    // the sweep from retroactively nuking stale test rows from
    // before the timeout policy existed (e.g., yesterday's
    // 1778926829026 sitting at 24h shouldn't get auto-cancelled).
    const minAgeIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const maxAgeIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: candidates, error: queryErr } = await supabaseAdmin
      .from('customer_orders')
      .select('id, payment_id, merchant_id, customer_id, total_sar, card_paid_sar, created_at, payment_confirmed_at, foodics_order_id')
      .eq('status', 'Placed')
      .lt('created_at', minAgeIso)
      .gte('created_at', maxAgeIso)
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
        // ─── ORD-4: verify the ledger before assuming nothing was deducted ───
        // The "never-confirmed ⇒ no side effects" assumption holds for a clean
        // abandoned draft, but a final commit that deducted wallet/cashback/
        // promo and then died at the upsert (or was killed mid-flight) can leave
        // a row that never got payment_confirmed_at yet whose ledgers ARE
        // debited. Blindly marking such a row Cancelled + not_required would
        // permanently burn the customer's balance (the exact ORD-4 loss). Check
        // the actual ledgers first; if anything really moved, run the full
        // idempotent reversal (refundOrderToWallet reads the ledger and never
        // phantom-credits) instead of the skip-path.
        let ledgerHadDeduction = false;
        try {
          const [{ data: walletSpend }, { data: loyaltyRedeem }] = await Promise.all([
            supabaseAdmin
              .from('customer_wallet_transactions')
              .select('id')
              .eq('order_id', order.id)
              .eq('customer_id', order.customer_id)
              .eq('merchant_id', order.merchant_id)
              .eq('entry_type', 'spend')
              .limit(1)
              .maybeSingle(),
            supabaseAdmin
              .from('loyalty_transactions')
              .select('id')
              .eq('order_id', order.id)
              .eq('customer_id', order.customer_id)
              .eq('merchant_id', order.merchant_id)
              .eq('type', 'redeem')
              .limit(1)
              .maybeSingle(),
          ]);
          ledgerHadDeduction = Boolean(walletSpend || loyaltyRedeem);
        } catch (e: any) {
          // On a lookup error, prefer the safe reversal path over the burn path:
          // refundOrderToWallet only credits what the ledger actually holds, so
          // a false positive is a no-op, whereas a false "nothing deducted" burns.
          console.warn('[Orders] sweep Layer-2 ledger check failed — routing to reversal', { orderId: order.id, error: e?.message });
          ledgerHadDeduction = true;
        }

        if (ledgerHadDeduction) {
          try {
            const result = await refundOrderToWallet(
              order.id,
              'system',
              'Abandoned payment — reversing applied deductions',
            );
            if (result.ok) {
              swept += 1;
              results.push({ orderId: order.id, action: 'swept', reason: 'draft_never_confirmed_had_ledger' });
            } else {
              results.push({ orderId: order.id, action: 'error', reason: result.error });
            }
          } catch (e: any) {
            results.push({ orderId: order.id, action: 'error', reason: e?.message || 'reverse threw' });
          }
          continue;
        }

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

      // ─── Confirmed + Foodics-relayed orders: no-accept timeout ───
      // The order made it to the merchant's POS (foodics_order_id set,
      // payment_confirmed_at set) but the cashier hasn't tapped
      // Accept within 5 minutes. Reverse everything: void Moyasar,
      // credit wallet back, restore cashback, restore stamps, give
      // the promo slot back, and tell Foodics to mark the POS row as
      // Void. Customer gets a single 'store didn't accept in time'
      // push.
      //
      // Foodics-side race: if the cashier tapped Accept right around
      // the 5-min mark and the webhook hasn't landed yet, our DB
      // still says 'Placed'. The cancelFoodicsOrderForMerchant call
      // inside refundOrderToWallet will hit Foodics and either
      // succeed (still Pending → goes Void cleanly) or get the
      // post-accept rejection (logged as cancel_post_accept). Either
      // way we refund — the customer has waited 5 min and shouldn't
      // be left in limbo. Merchants who routinely brush past 5 min
      // can configure a longer threshold later.
      try {
        const result = await refundOrderToWallet(
          order.id,
          'system',
          'Timeout — store did not accept order in time',
        );
        if (result.ok) {
          swept += 1;
          results.push({ orderId: order.id, action: 'swept', reason: 'no_accept_timeout' });
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
      .select('id, customer_id, status, order_type, ready_at, total_sar, wallet_paid_sar, cashback_paid_sar, merchant_id')
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
      earnForOrder(order.customer_id, order.id, netOfLoyaltyEarnBase(order), order.merchant_id).catch(
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

/*
 * ── POST /api/orders/:id/customer-arrived ──
 *
 * Curbside ("receive from your car") arrival ping. The customer taps
 * "I've arrived" on their order card after parking at the branch.
 * We:
 *   1) validate the order is theirs, drivethru, foodics-relayed,
 *      not cancelled/delivered, and not already marked arrived
 *   2) stamp customer_arrived_at = now() in customer_orders
 *   3) relay to nooksweb so it calls Foodics
 *      /v5/devices/push_notifications with order_customer_arrived,
 *      which highlights the ticket on the cashier device
 *
 * The Foodics call is best-effort — a Foodics outage must NOT roll
 * back the local timestamp because the customer is still physically
 * there. nooksweb's audit_log records every attempt so ops can see
 * drift. The customer can re-tap if their first tap got a network
 * error, since the DB write was idempotent on customer_arrived_at.
 *
 * Rate-limit: per-customer 10/hour. A real arrival is one tap; 10
 * absorbs flaky-network retries while still blocking trivial spam.
 */
ordersRouter.post('/:id/customer-arrived', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const orderId = req.params.id;
    const { data: order, error } = await supabaseAdmin
      .from('customer_orders')
      .select('id, customer_id, status, order_type, foodics_order_id, merchant_id, customer_arrived_at')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.order_type !== 'drivethru') {
      return res.status(400).json({ error: 'This action is only for curbside (receive-from-car) orders' });
    }
    if (!order.foodics_order_id) {
      // Order never made it to Foodics — nothing to ping. The customer
      // shouldn't be seeing the button in this case (the OrderCard
      // gates on foodicsOrderId), so this is a belt-and-braces 400.
      return res.status(400).json({ error: 'Order has not been accepted by the store yet' });
    }
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: 'Order is already closed' });
    }
    if (order.customer_arrived_at) {
      // Idempotent success — surface the existing timestamp so the
      // app can render its "Notified at HH:MM" state without
      // re-firing the Foodics call.
      return res.json({ success: true, alreadyArrived: true, customerArrivedAt: order.customer_arrived_at });
    }

    if (
      !(await enforceLimits(req, res, {
        endpoint: 'orders.customer-arrived',
        keys: [{ dim: 'customer', value: user.id, max: 10, windowMs: 60 * 60_000 }],
        supabaseAdmin,
        merchantId: order.merchant_id ?? undefined,
      }))
    )
      return;

    const now = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update({ customer_arrived_at: now, updated_at: now })
      .eq('id', orderId)
      .is('customer_arrived_at', null);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Relay to nooksweb. Fire-and-forget so a slow Foodics call
    // doesn't keep the customer staring at a spinner — they tapped
    // arrived, the local state is durable, and the cashier ping is
    // a downstream concern.
    if (NOOKS_API_BASE_URL && NOOKS_INTERNAL_SECRET) {
      fetch(`${NOOKS_API_BASE_URL}/api/public/orders/customer-arrived`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
        },
        body: JSON.stringify({ internalOrderId: orderId }),
      })
        .then(async (resp) => {
          if (!resp.ok) {
            console.warn('[Orders] Foodics arrived relay non-2xx:', resp.status);
          }
        })
        .catch((e) => {
          console.warn('[Orders] Foodics arrived relay failed (non-blocking):', e?.message);
        });
    }

    res.json({ success: true, customerArrivedAt: now });
  } catch (err: any) {
    console.error('[orders] customer-arrived error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to mark arrived' });
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
      .select('id, customer_id, status, total_sar, wallet_paid_sar, cashback_paid_sar, merchant_id')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // ─── R4 fix: enforce lifecycle state machine ───
    // Pre-fix, a malicious or buggy dashboard call (or insider with
    // branch-manager access) could jump 'Ready' → 'Delivered' without
    // a dispatch, marking goods delivered that never left the kitchen.
    // That triggers earnPoints (line below) and closes the commission
    // window on undelivered inventory. The transition map below is the
    // canonical lifecycle; everything else is rejected.
    //
    // Idempotent self-transitions (same → same) are allowed so a
    // dashboard retry doesn't 4xx; terminal states block all moves.
    const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
      Placed: ['Accepted', 'Preparing', 'Cancelled', 'On Hold', 'Pending'],
      Pending: ['Placed', 'Accepted', 'Cancelled'],
      'On Hold': ['Placed', 'Accepted', 'Cancelled'],
      Accepted: ['Preparing', 'Ready', 'Cancelled'],
      Preparing: ['Ready', 'Cancelled'],
      // Pickup / drivethru orders skip 'Out for delivery' and go
      // straight Ready → Delivered. Delivery orders need the dispatch.
      Ready: ['Out for delivery', 'Delivered', 'Cancelled'],
      'Out for delivery': ['Delivered', 'Cancelled'],
      // Terminal — no further transitions.
      Delivered: [],
      Cancelled: [],
    };
    const currentStatus = String(order.status ?? '');
    if (currentStatus !== status) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(status)) {
        return res.status(409).json({
          error: `Invalid status transition: ${currentStatus} → ${status}. Allowed: ${
            allowed.length > 0 ? allowed.join(', ') : '(terminal state, no transitions)'
          }.`,
          code: 'STATUS_TRANSITION_INVALID',
          currentStatus,
        });
      }
    }

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
        earnForOrder(order.customer_id, orderId, netOfLoyaltyEarnBase(order), order.merchant_id ?? '').catch(
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
