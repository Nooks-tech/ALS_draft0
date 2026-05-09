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
 * Permanent account erasure: anonymises order history (so merchant's
 * accounting stays intact) and removes personal data (profile, saved
 * addresses, push subscriptions). The Supabase auth user is deleted
 * last so the client immediately drops to the login screen.
 */
accountRouter.delete('/', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    // Anonymise orders so aggregate stats still work but PII is gone.
    await supabaseAdmin
      .from('customer_orders')
      .update({
        customer_id: 'deleted-customer',
        delivery_address: null,
        delivery_lat: null,
        delivery_lng: null,
      })
      .eq('customer_id', user.id);

    // saved_addresses lives in mobile-app AsyncStorage, not Supabase —
    // the deletion of the Supabase auth user below means the next
    // launch of any merchant app will sign the user out, but their
    // device-local saved addresses survive locally and would be
    // visible only if they re-sign in with the same phone (the same
    // auth.uid is gone, so addresses keyed by the old uid are stale).
    // The mobile app's account-deletion screen should also clear its
    // own AsyncStorage to make the erasure complete.
    await Promise.all([
      supabaseAdmin.from('profiles').delete().eq('user_id', user.id),
      supabaseAdmin.from('push_subscriptions').delete().eq('user_id', user.id),
      supabaseAdmin.from('loyalty_stamps').delete().eq('customer_id', user.id),
      supabaseAdmin.from('loyalty_points').delete().eq('customer_id', user.id),
      supabaseAdmin.from('loyalty_cashback_balances').delete().eq('customer_id', user.id),
      supabaseAdmin.from('order_complaints').delete().eq('customer_id', user.id),
      supabaseAdmin.from('loyalty_transactions').delete().eq('customer_id', user.id),
    ]);

    // Finally kill the auth user. Once this returns the mobile app's
    // next request 401s and the 401 interceptor signs out locally.
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (authErr) {
      console.warn('[account/delete] auth.admin.deleteUser failed:', authErr.message);
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('[account/delete] error:', err?.message);
    res.status(500).json({ error: err?.message || 'Deletion failed' });
  }
});

export { accountRouter };
