import { createClient, type User } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import { writeAudit } from './auditLog';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const authClient = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// Re-OTP TTL — anything older than this on merchant_customers.verified_at
// forces the customer to OTP again at that merchant. Configurable via
// env var for testing; defaults to 6 months per product spec.
const MERCHANT_VERIFICATION_TTL_DAYS = Number(
  process.env.MERCHANT_VERIFICATION_TTL_DAYS ?? 180
);
const MERCHANT_VERIFICATION_TTL_MS = MERCHANT_VERIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;

function getBearerToken(req: Request): string {
  const raw = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export async function requireAuthenticatedAppUser(req: Request, res: Response): Promise<User | null> {
  if (!authClient) {
    res.status(500).json({ error: 'Auth is not configured' });
    return null;
  }

  const accessToken = getBearerToken(req);
  if (!accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const { data, error } = await authClient.auth.getUser(accessToken);
  if (error || !data.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return data.user;
}

/**
 * Phase B helper: enforce that the authenticated customer has a
 * recent OTP verification at THIS merchant. The shared auth.users
 * row means a customer can sign in once (Supabase doesn't care which
 * merchant they're using); without this gate, that single sign-in
 * leaks into every other merchant the same phone has ever touched.
 *
 * Returns:
 *   { ok: true, verifiedAt }  — customer is verified at this merchant
 *                                within the TTL.
 *   { ok: false, reason }      — caller should NOT proceed. The reason
 *                                tells the client what to do:
 *     'not_enrolled'    → never OTP'd here; show OTP screen.
 *     'expired'         → 6+ months since last OTP; re-verify.
 *     'lookup_failed'   → DB hiccup; safe to surface as 500.
 *
 * Sends the appropriate response on failure when `respond` is true
 * (the default) — callers just `return` after a falsey result.
 */
export async function requireVerifiedAtMerchant(
  res: Response,
  customerId: string,
  merchantId: string,
  options: { respond?: boolean } = {},
): Promise<{ ok: true; verifiedAt: Date } | { ok: false; reason: 'not_enrolled' | 'expired' | 'lookup_failed' }> {
  const respond = options.respond !== false;
  if (!authClient) {
    if (respond) res.status(500).json({ error: 'Auth is not configured' });
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!customerId || !merchantId) {
    if (respond) {
      res.status(400).json({
        error: 'customerId and merchantId are required',
        code: 'MERCHANT_VERIFICATION_INPUT_MISSING',
      });
    }
    return { ok: false, reason: 'lookup_failed' };
  }

  const { data, error } = await authClient
    .from('merchant_customers')
    .select('verified_at')
    .eq('merchant_id', merchantId)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error) {
    if (respond) res.status(500).json({ error: 'Verification lookup failed' });
    return { ok: false, reason: 'lookup_failed' };
  }

  if (!data || !data.verified_at) {
    // Phase B: audit every rejection so a sudden spike (= bug or
    // expired cohort) is queryable from the dashboard rather than
    // showing up only as customer complaints.
    void writeAudit({
      merchant_id: merchantId,
      action: 'auth.merchant_verification_rejected',
      payload: { customer_id: customerId, reason: 'not_enrolled' },
    });
    if (respond) {
      res.status(401).json({
        error: 'Please verify your phone to use this app.',
        code: 'MERCHANT_VERIFICATION_REQUIRED',
        reason: 'not_enrolled',
      });
    }
    return { ok: false, reason: 'not_enrolled' };
  }

  const verifiedAt = new Date(data.verified_at);
  const ageMs = Date.now() - verifiedAt.getTime();
  if (ageMs > MERCHANT_VERIFICATION_TTL_MS) {
    void writeAudit({
      merchant_id: merchantId,
      action: 'auth.merchant_verification_rejected',
      payload: {
        customer_id: customerId,
        reason: 'expired',
        verified_at: data.verified_at,
        age_days: Math.round(ageMs / (24 * 60 * 60 * 1000)),
      },
    });
    if (respond) {
      res.status(401).json({
        error: 'Please verify your phone again. It has been a while.',
        code: 'MERCHANT_VERIFICATION_REQUIRED',
        reason: 'expired',
        verifiedAt: data.verified_at,
      });
    }
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, verifiedAt };
}
