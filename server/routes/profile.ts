/**
 * Per-merchant customer profile routes — the customer app reads and
 * writes its display name, email, language, avatar, and marketing
 * opt-in here.
 *
 * Phase C: replaces the legacy `src/api/profile.ts` (client) +
 * `profiles` global-table reads. The white-label model is: each
 * merchant gets its own slice of the customer's profile, keyed on
 * (merchant_id, customer_id). Two merchant apps installed on the
 * same phone show two independent profiles — different names,
 * different language prefs, different marketing opt-in states.
 *
 * The global `public.profiles` table is now identity-only (phone
 * number + auth.users link) and is no longer read by the app.
 */

import { Router, type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuthenticatedAppUser, requireVerifiedAtMerchant } from '../utils/appUserAuth';

const profileRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLanguage(value: unknown): 'en' | 'ar' | null {
  const t = normalizeText(value);
  if (t === 'en' || t === 'ar') return t;
  return null;
}

/**
 * GET /api/profile?merchantId=...
 *
 * Returns the customer's profile for THIS merchant. Returns null
 * fields if the customer hasn't filled in their profile yet at this
 * merchant — the app's profile screen treats that as "first time
 * here, please fill in your details".
 */
profileRouter.get('/', async (req: Request, res: Response) => {
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
      .from('customer_merchant_profiles')
      .select('full_name, email, language, avatar_url, marketing_opt_in, updated_at')
      .eq('merchant_id', merchantId)
      .eq('customer_id', user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      full_name: data?.full_name ?? null,
      email: data?.email ?? null,
      language: data?.language ?? null,
      avatar_url: data?.avatar_url ?? null,
      marketing_opt_in: data?.marketing_opt_in ?? false,
      updated_at: data?.updated_at ?? null,
    });
  } catch (err: any) {
    console.error('[Profile] GET error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to load profile' });
  }
});

/**
 * PUT /api/profile?merchantId=...
 * body: { full_name?, email?, language?, avatar_url?, marketing_opt_in? }
 *
 * Upserts the customer's per-merchant profile. Only the keys present
 * in the body get changed; absent keys preserve their existing value.
 * Empty strings are converted to null (clears the field).
 */
profileRouter.put('/', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId.trim() : '';
    if (!merchantId) return res.status(400).json({ error: 'merchantId is required' });

    const verification = await requireVerifiedAtMerchant(res, user.id, merchantId);
    if (!verification.ok) return;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Build the upsert payload one field at a time. We don't allow the
    // customer to set updated_at or merchant_id; those come from the
    // session / URL.
    const upsert: Record<string, unknown> = {
      merchant_id: merchantId,
      customer_id: user.id,
    };
    if ('full_name' in body) upsert.full_name = normalizeText(body.full_name);
    if ('email' in body) upsert.email = normalizeText(body.email);
    if ('language' in body) upsert.language = normalizeLanguage(body.language);
    if ('avatar_url' in body) upsert.avatar_url = normalizeText(body.avatar_url);
    if ('marketing_opt_in' in body) {
      upsert.marketing_opt_in = body.marketing_opt_in === true;
    }
    upsert.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('customer_merchant_profiles')
      .upsert(upsert, { onConflict: 'merchant_id,customer_id' })
      .select('full_name, email, language, avatar_url, marketing_opt_in, updated_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      full_name: data?.full_name ?? null,
      email: data?.email ?? null,
      language: data?.language ?? null,
      avatar_url: data?.avatar_url ?? null,
      marketing_opt_in: data?.marketing_opt_in ?? false,
      updated_at: data?.updated_at ?? null,
    });
  } catch (err: any) {
    console.error('[Profile] PUT error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to update profile' });
  }
});

export { profileRouter };
