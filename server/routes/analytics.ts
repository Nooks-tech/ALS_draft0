import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';

/**
 * Phase 5 — cart abandonment tracking.
 *
 * Mobile fires cart events at two points:
 *   - cart screen mount → "cart.opened"
 *   - checkout commit success → "cart.committed"
 *
 * Events land in audit_log so the nooksweb monthly summary can compute
 * abandonment without a new dedicated table — keeps the data model
 * simple, and audit_log already has the right indexes (created_at,
 * action, merchant_id).
 *
 * Auth: same Bearer-token-from-Supabase pattern as other mobile routes.
 * customer_id is taken from the verified token, never from the body.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

export const analyticsRouter: Router = Router();

const ALLOWED_EVENTS = new Set(['cart.opened', 'cart.committed']);

analyticsRouter.post('/cart-event', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { event, merchantId, sessionId, cartItemCount, cartTotalSar } = req.body ?? {};

    if (!event || typeof event !== 'string' || !ALLOWED_EVENTS.has(event)) {
      return res.status(400).json({ error: 'event must be cart.opened or cart.committed' });
    }
    if (!merchantId || typeof merchantId !== 'string') {
      return res.status(400).json({ error: 'merchantId is required' });
    }
    if (sessionId && typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId must be a string' });
    }

    const payload: Record<string, unknown> = {
      customerId: user.id,
      sessionId: sessionId ?? null,
    };
    if (typeof cartItemCount === 'number' && Number.isFinite(cartItemCount)) {
      payload.cartItemCount = Math.max(0, Math.floor(cartItemCount));
    }
    if (typeof cartTotalSar === 'number' && Number.isFinite(cartTotalSar)) {
      payload.cartTotalSar = Math.max(0, cartTotalSar);
    }

    // Fire-and-forget pattern from caller's POV — we still await the
    // insert because we want a 204 to surface insert errors to Sentry.
    // The mobile client never blocks UI on this response.
    const { error } = await supabaseAdmin.from('audit_log').insert({
      action: event,
      merchant_id: merchantId,
      payload,
    });
    if (error) {
      // Don't 500 — surface as 200 with `ok: false` so the mobile fire-
      // and-forget doesn't trigger crash report cycles. The error is in
      // server logs for triage.
      console.warn('[analytics/cart-event] audit_log insert failed', error.message);
      return res.status(200).json({ ok: false, reason: 'log_failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.warn('[analytics/cart-event] unexpected error', err?.message);
    return res.status(200).json({ ok: false, reason: 'unexpected' });
  }
});
