/**
 * Per-merchant server-side cart.
 *
 * Phase D: the cart is no longer client-side-only. The customer app
 * mirrors the cart to the server with a debounced sync; the server
 * is the authoritative store for the abandoned-cart cron sweep
 * (15-min reminder push + 1-hour abandonment).
 *
 * Endpoints:
 *   GET    /api/cart?merchantId=...    fetch current cart
 *   PUT    /api/cart?merchantId=...    upsert (replaces items + meta)
 *   DELETE /api/cart?merchantId=...    clear (e.g. after order commit)
 *
 * Cart contents are NOT validated against the menu here — that's the
 * /commit endpoint's job. The cart is just stored as a JSON blob with
 * subtotal_sar for the dashboard's abandoned-cart panel.
 */

import { Router, type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuthenticatedAppUser, requireVerifiedAtMerchant } from '../utils/appUserAuth';

const cartRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Hard ceiling on the items blob — defends against a runaway client
// sending us megabytes of payload. The customer cart shouldn't have
// hundreds of items; 50 is generous.
const MAX_CART_ITEMS = 50;

cartRouter.get('/', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId.trim() : '';
    if (!merchantId) return res.status(400).json({ error: 'merchantId is required' });

    const verification = await requireVerifiedAtMerchant(res, user.id, merchantId);
    if (!verification.ok) return;

    res.setHeader('Cache-Control', 'no-store');

    const { data, error } = await supabaseAdmin
      .from('customer_carts')
      .select('items, subtotal_sar, branch_id, order_type, updated_at, notified_at')
      .eq('merchant_id', merchantId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      items: data?.items ?? [],
      subtotal_sar: data?.subtotal_sar ?? 0,
      branch_id: data?.branch_id ?? null,
      order_type: data?.order_type ?? null,
      updated_at: data?.updated_at ?? null,
      notified_at: data?.notified_at ?? null,
    });
  } catch (err: any) {
    console.error('[Cart] GET error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to load cart' });
  }
});

cartRouter.put('/', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId.trim() : '';
    if (!merchantId) return res.status(400).json({ error: 'merchantId is required' });

    const verification = await requireVerifiedAtMerchant(res, user.id, merchantId);
    if (!verification.ok) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length > MAX_CART_ITEMS) {
      return res.status(400).json({
        error: `Cart cannot exceed ${MAX_CART_ITEMS} items.`,
        code: 'CART_TOO_LARGE',
      });
    }

    // Items are kept opaque — we don't validate fields here. /commit
    // does the per-item floor + ceiling check at order time. This
    // route's job is just persistence for the abandonment sweep.
    const subtotalSarRaw = Number(body.subtotal_sar ?? 0);
    const subtotalSar = Number.isFinite(subtotalSarRaw) && subtotalSarRaw >= 0
      ? Number(subtotalSarRaw.toFixed(2))
      : 0;
    const branchId = typeof body.branch_id === 'string' && body.branch_id.trim()
      ? body.branch_id.trim()
      : null;
    const orderTypeRaw = typeof body.order_type === 'string' ? body.order_type.trim() : '';
    const orderType =
      orderTypeRaw === 'delivery' || orderTypeRaw === 'pickup' || orderTypeRaw === 'drivethru'
        ? orderTypeRaw
        : null;

    const { data, error } = await supabaseAdmin
      .from('customer_carts')
      .upsert(
        {
          merchant_id: merchantId,
          customer_id: user.id,
          items: rawItems,
          subtotal_sar: subtotalSar,
          branch_id: branchId,
          order_type: orderType,
          updated_at: new Date().toISOString(),
          // notified_at deliberately left null on writes — the
          // trigger in the migration also clears notified_at when
          // items change, so the cron will re-notify on the next
          // 15-min idle.
        },
        { onConflict: 'merchant_id,customer_id' },
      )
      .select('items, subtotal_sar, updated_at, notified_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      items: data?.items ?? [],
      subtotal_sar: data?.subtotal_sar ?? 0,
      updated_at: data?.updated_at ?? null,
      notified_at: data?.notified_at ?? null,
    });
  } catch (err: any) {
    console.error('[Cart] PUT error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to save cart' });
  }
});

cartRouter.delete('/', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId.trim() : '';
    if (!merchantId) return res.status(400).json({ error: 'merchantId is required' });

    // No verification check on DELETE — clearing the cart should
    // succeed even when the customer's session is about to expire
    // (e.g. after /commit success the client immediately clears).

    const { error } = await supabaseAdmin
      .from('customer_carts')
      .delete()
      .eq('merchant_id', merchantId)
      .eq('customer_id', user.id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[Cart] DELETE error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to clear cart' });
  }
});

export { cartRouter };
