/**
 * Simple in-memory per-IP rate limiter for Express routes.
 *
 * This is per-process state — fine for a single Express server but not for multi-instance
 * deployments. For production scale, replace with Redis (e.g. ioredis + a sliding window).
 *
 * Default: 60 requests per minute per IP. Override per-route via the factory.
 */
import type { Request, Response, NextFunction } from 'express';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Periodically prune expired buckets to prevent unbounded memory growth. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, PRUNE_INTERVAL_MS).unref?.();

export interface RateLimitOptions {
  /** Max requests per window */
  max: number;
  /** Window length in milliseconds */
  windowMs: number;
  /** Optional key prefix for grouping (e.g. 'webhook', 'payment') */
  prefix?: string;
}

export function createRateLimit({ max, windowMs, prefix = '' }: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Use X-Forwarded-For if behind a trusted proxy, otherwise raw IP.
    const fwd = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]) || req.socket.remoteAddress || 'unknown';
    const key = `${prefix}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
    }

    bucket.count += 1;
    return next();
  };
}

/** Common preset: webhooks — 120/min (Moyasar/OTO retry windows can burst briefly). */
export const webhookRateLimit = createRateLimit({ max: 120, windowMs: 60_000, prefix: 'wh' });

/** Common preset: payment initiation — 30/min per IP (well above legitimate user pace). */
export const paymentRateLimit = createRateLimit({ max: 30, windowMs: 60_000, prefix: 'pay' });

/* ════════════════════════════════════════════════════════════════════
   Multi-dimensional rate limiter — Path A hardening 2026-05-24.
   Inline-callable from inside Express handlers so we can AND together
   keys derived from the request body (customer_id, saved_card_id,
   phone, etc.) — middleware can't see those because it runs before
   the body is parsed.

   Same in-memory store as the per-IP limiter above (still single-
   dyno-only). Returns ok=true with a 429 response when ANY dimension
   exceeds its window; counters only increment when ALL pass (so a
   rejected request doesn't keep climbing buckets on retry). PII keys
   (phone, email) MUST be hashed via hashKey() before being passed in.
   ════════════════════════════════════════════════════════════════════ */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export function hashKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export type LimitDim = 'ip' | 'customer' | 'merchant' | 'phone' | 'email' | 'card' | 'token' | 'global';

export type LimitKey = {
  dim: LimitDim;
  /** Value to bucket on. PII MUST be hashed via hashKey() before passing in. */
  value: string;
  max: number;
  windowMs: number;
};

export type LimitsResult =
  | { ok: true }
  | { ok: false; dim: LimitDim; retryAfter: number };

export function previewLimits(keys: LimitKey[]): LimitsResult {
  const now = Date.now();
  // Pass 1 — read every dim, bail at the first one that's over.
  for (const k of keys) {
    const mapKey = `m:${k.dim}:${k.value}`;
    const bucket = buckets.get(mapKey);
    if (bucket && bucket.resetAt >= now && bucket.count >= k.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return { ok: false, dim: k.dim, retryAfter };
    }
  }
  // Pass 2 — all clear, increment every dim.
  for (const k of keys) {
    const mapKey = `m:${k.dim}:${k.value}`;
    const bucket = buckets.get(mapKey);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(mapKey, { count: 1, resetAt: now + k.windowMs });
    } else {
      bucket.count += 1;
    }
  }
  return { ok: true };
}

/**
 * Inline call from inside an Express handler. Writes a 429 + audit_log
 * row on hit; returns false (request was blocked, caller should bail).
 * Returns true on allow — caller continues normally.
 *
 * Usage:
 *   if (!(await enforceLimits(req, res, {
 *     endpoint: 'payment.token-pay',
 *     keys: [
 *       { dim: 'customer', value: user.id, max: 5,  windowMs: 15*60_000 },
 *       { dim: 'card',     value: cardId,  max: 3,  windowMs: 15*60_000 },
 *     ],
 *     supabaseAdmin,
 *     merchantId,
 *   }))) return;
 */
export async function enforceLimits(
  req: Request,
  res: Response,
  opts: {
    endpoint: string;
    keys: LimitKey[];
    supabaseAdmin?: SupabaseClient | null;
    merchantId?: string | null;
  },
): Promise<boolean> {
  const decision = previewLimits(opts.keys);
  if (decision.ok) return true;

  res.setHeader('Retry-After', String(decision.retryAfter));
  res.setHeader('X-RateLimit-Blocked-Dimension', decision.dim);
  res.status(429).json({
    error: 'Rate limit exceeded',
    retryAfter: decision.retryAfter,
    code: 'RATE_LIMIT_EXCEEDED',
    dimension: decision.dim,
  });

  // Best-effort audit. Don't slow the 429; don't throw inside security
  // layer. ip is the same X-Forwarded-For extraction as createRateLimit
  // above — kept here for the audit payload only (not as a bucket key).
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]) || req.socket.remoteAddress || 'unknown';
  if (opts.supabaseAdmin) {
    void opts.supabaseAdmin
      .from('audit_log')
      .insert({
        merchant_id: opts.merchantId ?? null,
        action: 'rate_limit.exceeded',
        payload: {
          endpoint: opts.endpoint,
          dimension: decision.dim,
          retry_after_seconds: decision.retryAfter,
          ip,
        },
      })
      .then(
        () => {},
        (err: unknown) => {
          console.warn('[rate-limit] audit_log write failed:', err instanceof Error ? err.message : String(err));
        },
      );
  }
  return false;
}

/** Quick helper for endpoints that derive an IP key from the request. */
export function ipFromReq(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]) || req.socket.remoteAddress || 'unknown';
}
