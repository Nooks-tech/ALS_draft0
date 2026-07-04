import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createClient, type User } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import { writeAudit } from './auditLog';
import { captureError } from './sentryContext';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const authClient = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// ── Local JWT verification ─────────────────────────────────────────────
// Every authenticated request used to make an HTTP round-trip to Supabase
// GoTrue (auth.getUser) just to validate the bearer token — a ~50-250ms
// latency floor and a shared rate limit/single point of failure for the
// whole customer API. The project signs access tokens with ES256 and
// publishes the public key via JWKS, so we verify locally (exactly the
// trust model PostgREST itself uses) and only fall back to the network
// when local verification can't succeed (unknown kid after refresh, JWKS
// unreachable, legacy HS256 token without SUPABASE_JWT_SECRET set).
const JWKS_TTL_MS = 10 * 60 * 1000;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

let jwksKeys: Map<string, crypto.KeyObject> | null = null;
let jwksFetchedAt = 0;
let jwksFetchInFlight: Promise<void> | null = null;

async function refreshJwks(): Promise<void> {
  if (!SUPABASE_URL) return;
  if (jwksFetchInFlight) return jwksFetchInFlight;
  jwksFetchInFlight = (async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
      if (!res.ok) return;
      const body: any = await res.json().catch(() => null);
      const keys: any[] = Array.isArray(body?.keys) ? body.keys : [];
      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of keys) {
        if (!jwk?.kid) continue;
        try {
          next.set(String(jwk.kid), crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // Unsupported key type — skip; verification falls back to GoTrue.
        }
      }
      if (next.size > 0) {
        jwksKeys = next;
        jwksFetchedAt = Date.now();
      }
    } catch {
      // Network failure — keep any previously-cached keys.
    } finally {
      jwksFetchInFlight = null;
    }
  })();
  return jwksFetchInFlight;
}

function claimsToUser(payload: jwt.JwtPayload): User {
  return {
    id: String(payload.sub ?? ''),
    aud: typeof payload.aud === 'string' ? payload.aud : 'authenticated',
    role: typeof (payload as any).role === 'string' ? (payload as any).role : undefined,
    email: typeof (payload as any).email === 'string' ? (payload as any).email : undefined,
    phone: typeof (payload as any).phone === 'string' ? (payload as any).phone : undefined,
    app_metadata: (payload as any).app_metadata ?? {},
    user_metadata: (payload as any).user_metadata ?? {},
    is_anonymous: Boolean((payload as any).is_anonymous),
    created_at: '',
  } as User;
}

/**
 * Verify the access token locally. Returns the user on success, or null
 * when the caller should fall back to the GoTrue network check (so a key
 * rotation or clock skew never locks real customers out — the fallback
 * simply restores the old behavior for that request).
 */
async function verifyAccessTokenLocally(accessToken: string): Promise<User | null> {
  let decoded: { header: jwt.JwtHeader; payload: jwt.JwtPayload } | null = null;
  try {
    decoded = jwt.decode(accessToken, { complete: true }) as any;
  } catch {
    return null;
  }
  if (!decoded?.header) return null;

  const { alg, kid } = decoded.header;
  try {
    if (alg === 'ES256' || alg === 'RS256') {
      if (!jwksKeys || Date.now() - jwksFetchedAt > JWKS_TTL_MS) await refreshJwks();
      let key = kid ? jwksKeys?.get(kid) : undefined;
      if (!key && kid) {
        // Unknown kid — maybe a fresh rotation; force one refetch.
        await refreshJwks();
        key = jwksKeys?.get(kid);
      }
      if (!key) return null;
      const payload = jwt.verify(accessToken, key, { algorithms: [alg] }) as jwt.JwtPayload;
      if (!payload?.sub) return null;
      return claimsToUser(payload);
    }
    if (alg === 'HS256' && SUPABASE_JWT_SECRET) {
      const payload = jwt.verify(accessToken, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (!payload?.sub) return null;
      return claimsToUser(payload);
    }
  } catch {
    // Invalid/expired signature — let GoTrue give the authoritative answer.
    return null;
  }
  return null;
}

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

  // Local ES256/JWKS verification first (no network); GoTrue only as the
  // authoritative fallback when local verification can't decide.
  const localUser = await verifyAccessTokenLocally(accessToken);
  if (localUser) return localUser;

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
    // 2026-05-22 production hotfix: a DB query error here was
    // blocking legitimate transactions (e.g. wallet topup-finalize
    // after Moyasar had already charged). Could be a transient
    // network blip, a not-yet-applied migration, or a schema drift.
    // Fail OPEN so customers don't lose money in flight — the other
    // auth layers (Supabase JWT, customer_id ownership check, and
    // Moyasar payment re-verify on /commit, etc.) still apply. The
    // verification gate is defense-in-depth, not the only line of
    // defense. We ship a loud Sentry alert + audit row so the
    // operator notices and fixes the underlying schema issue.
    console.error('[requireVerifiedAtMerchant] DB lookup failed — failing OPEN to avoid blocking transactions', {
      merchantId,
      customerId,
      error: error.message,
      code: (error as { code?: string }).code,
      details: (error as { details?: string }).details,
    });
    captureError(new Error(`requireVerifiedAtMerchant DB lookup failed: ${error.message}`), {
      component: 'requireVerifiedAtMerchant.failOpen',
      merchantId,
      customerId,
      extra: {
        db_error_code: (error as { code?: string }).code,
        db_error_details: (error as { details?: string }).details,
      },
    });
    void writeAudit({
      merchant_id: merchantId,
      action: 'auth.merchant_verification_failopen',
      payload: {
        customer_id: customerId,
        db_error: error.message,
        db_error_code: (error as { code?: string }).code,
      },
    });
    return { ok: true, verifiedAt: new Date() };
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
