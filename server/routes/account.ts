/**
 * Customer account routes: data export + delete.
 *
 * PDPL (Saudi Personal Data Protection Law) gives the customer a right
 * of access (download everything we hold) and a right of erasure. These
 * endpoints fulfil both.
 *
 * Auth: Supabase JWT in `Authorization: Bearer` — checked by
 * requireAuthenticatedAppUser. The customer can only ever export or
 * delete their own account — we never take a userId from the client.
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';

const accountRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

accountRouter.get('/export', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    // Multi-tenant scoping: a single Supabase auth.uid is shared across
    // every merchant's white-label app. Without merchant scoping this
    // endpoint would let a customer in merchant A's app download orders
    // they made in merchant B's app — same identity, different brand.
    // Required for Tier 2 audit issue: mobile callers MUST pass the
    // current merchant context. Saved addresses + profile stay global
    // (one customer identity), but everything else is per-merchant.
    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId query parameter is required' });
    }

    // saved_addresses is device-local (AsyncStorage in the mobile app's
    // SavedAddressesContext) — there is no Supabase table for it. The
    // previous query against `saved_addresses` returned a 404 schema
    // error and would have either thrown or silently returned []. The
    // mobile app should include its locally-stored addresses in any
    // PDPL data dump itself before uploading, since the server doesn't
    // have them.
    const [profile, orders, complaints, loyaltyTx, stamps, points, cashback, subs] =
      await Promise.all([
        supabaseAdmin.from('profiles').select('*').eq('user_id', user.id).maybeSingle(),
        supabaseAdmin
          .from('customer_orders')
          .select('id, merchant_id, branch_name, total_sar, status, order_type, created_at, delivered_at, items, delivery_address')
          .eq('customer_id', user.id)
          .eq('merchant_id', merchantId)
          .limit(5000),
        supabaseAdmin.from('order_complaints').select('*').eq('customer_id', user.id).eq('merchant_id', merchantId).limit(500),
        supabaseAdmin.from('loyalty_transactions').select('*').eq('customer_id', user.id).eq('merchant_id', merchantId).limit(5000),
        supabaseAdmin.from('loyalty_stamps').select('*').eq('customer_id', user.id).eq('merchant_id', merchantId),
        supabaseAdmin.from('loyalty_points').select('*').eq('customer_id', user.id).eq('merchant_id', merchantId),
        supabaseAdmin.from('loyalty_cashback_balances').select('*').eq('customer_id', user.id).eq('merchant_id', merchantId),
        supabaseAdmin.from('push_subscriptions').select('merchant_id, platform, app_language, marketing_opt_in, last_seen_at').eq('user_id', user.id).eq('merchant_id', merchantId),
      ]);

    await supabaseAdmin.from('data_export_requests').insert({
      requester_type: 'customer',
      requester_id: user.id,
      format: 'json',
      delivered_at: new Date().toISOString(),
    });

    const payload = {
      exported_at: new Date().toISOString(),
      user_id: user.id,
      profile: profile.data ?? null,
      orders: orders.data ?? [],
      complaints: complaints.data ?? [],
      loyalty_transactions: loyaltyTx.data ?? [],
      loyalty_stamps: stamps.data ?? [],
      loyalty_points: points.data ?? [],
      cashback_balances: cashback.data ?? [],
      saved_addresses_note: 'Saved delivery addresses are stored on your device only (in the app\'s local storage), not on our servers. They are not included in this server-side export.',
      push_subscriptions: subs.data ?? [],
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nooks-my-data-${user.id.slice(0,8)}.json"`);
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err: any) {
    console.error('[account/export] error:', err?.message);
    res.status(500).json({ error: err?.message || 'Export failed' });
  }
});

/**
 * DELETE /api/account
 *
 * Per-merchant account erasure. The customer is initiating deletion
 * from inside ONE merchant's white-label app, so by default we only
 * touch that merchant's slice of their data — loyalty_stamps,
 * loyalty_points, loyalty_cashback_balances, order_complaints, and
 * loyalty_transactions filtered on (customer_id, merchant_id);
 * customer_orders anonymised for that merchant only;
 * push_subscriptions for that merchant only.
 *
 * The Supabase auth.uid is GLOBAL — same identity across every
 * merchant's app — so we deliberately do NOT delete the auth user
 * here. Doing so would silently log the customer out of every other
 * merchant's app they have installed and wipe data they didn't ask
 * to delete. A future ?scope=all path (or a Nooks-support-driven
 * flow) can fan deletion across every merchant the customer has a
 * profile with; until then, this endpoint is intentionally
 * single-merchant.
 *
 * Required query param: ?merchantId=<uuid>. Without it we 400 — the
 * pre-2026-05-18 behaviour was a multi-merchant nuke that wiped
 * loyalty balances and complaints across every white-label app
 * sharing the same auth.uid, which violates the customer's intent
 * (they were standing in Mafasa's app and tapped Delete) and
 * destroys other merchants' loyalty bookkeeping without their
 * consent.
 */
accountRouter.delete('/', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId.trim() : '';
    if (!merchantId) {
      return res.status(400).json({
        error: 'merchantId query parameter is required',
        hint: 'Deletion is scoped to one merchant at a time. To delete data from another merchant, repeat the request from that merchant\'s app.',
      });
    }

    // Anonymise this merchant's orders only — replaces the customer_id
    // with a sentinel so the merchant's accounting + aggregates stay
    // intact while PII (delivery address + lat/lng) is wiped. Other
    // merchants' orders for the same auth.uid are untouched.
    await supabaseAdmin
      .from('customer_orders')
      .update({
        customer_id: 'deleted-customer',
        delivery_address: null,
        delivery_lat: null,
        delivery_lng: null,
      })
      .eq('customer_id', user.id)
      .eq('merchant_id', merchantId);

    // Per-merchant deletion of loyalty + complaint + push records.
    // profiles stays — it's a single-row global identity (phone,
    // name, email, photo) that the customer can keep using to sign
    // in to other merchant apps. The mobile app's account-deletion
    // screen should also clear its own AsyncStorage to wipe device-
    // local saved addresses for this merchant.
    await Promise.all([
      supabaseAdmin.from('push_subscriptions').delete().eq('user_id', user.id).eq('merchant_id', merchantId),
      supabaseAdmin.from('loyalty_stamps').delete().eq('customer_id', user.id).eq('merchant_id', merchantId),
      supabaseAdmin.from('loyalty_points').delete().eq('customer_id', user.id).eq('merchant_id', merchantId),
      supabaseAdmin.from('loyalty_cashback_balances').delete().eq('customer_id', user.id).eq('merchant_id', merchantId),
      supabaseAdmin.from('order_complaints').delete().eq('customer_id', user.id).eq('merchant_id', merchantId),
      supabaseAdmin.from('loyalty_transactions').delete().eq('customer_id', user.id).eq('merchant_id', merchantId),
    ]);

    res.json({ success: true, scope: 'merchant', merchantId });
  } catch (err: any) {
    console.error('[account/delete] error:', err?.message);
    res.status(500).json({ error: err?.message || 'Deletion failed' });
  }
});

export { accountRouter };
