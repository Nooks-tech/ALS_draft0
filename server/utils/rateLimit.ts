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
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

/* ──────────────────────────────────────────────────────────────────
   Upstash backend (Path B) — multi-dyno-safe sliding window.
   Activates when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
   are set. Falls back to the in-memory bucket store otherwise so
   dev/local environments work without Redis.
   ────────────────────────────────────────────────────────────────── */

let upstashRedis: Redis | null = null;
const upstashLimiters = new Map<string, Ratelimit>();

function getUpstash(): Redis | null {
  if (upstashRedis) return upstashRedis;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  try {
    upstashRedis = new Redis({ url, token });
    return upstashRedis;
  } catch (err) {
    console.warn('[rate-limit] Upstash init failed, falling back to in-memory:', err);
    return null;
  }
}

function msToUpstashDuration(ms: number): `${number} s` | `${number} m` | `${number} h` | `${number} d` {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h`;
  return `${Math.round(ms / (24 * 60 * 60_000))} d`;
}

function getUpstashLimiter(max: number, windowMs: number): Ratelimit | null {
  const redis = getUpstash();
  if (!redis) return null;
  const cacheKey = `${max}:${windowMs}`;
  let limiter = upstashLimiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, msToUpstashDuration(windowMs)),
      // Prefix includes (max, windowMs) so different limit configs
      // over the same dim+value land in separate Redis keyspaces.
      // Without this, two endpoints with different limits would
      // share + corrupt each other's counters.
      prefix: `als:${process.env.RATE_LIMIT_NAMESPACE ?? process.env.NODE_ENV ?? 'dev'}:${max}:${windowMs}`,
      analytics: true,
    });
    upstashLimiters.set(cacheKey, limiter);
  }
  return limiter;
}

async function previewLimitsUpstash(keys: LimitKey[]): Promise<LimitsResult> {
  try {
    const results = await Promise.all(
      keys.map(async (k) => {
        const limiter = getUpstashLimiter(k.max, k.windowMs);
        if (!limiter) return { k, success: true, reset: 0, remaining: k.max };
        const res = await limiter.limit(`${k.dim}:${k.value}`);
        return { k, ...res };
      }),
    );
    const blocked = results.find((r) => !r.success);
    if (blocked) {
      const retryAfter = Math.max(1, Math.ceil((blocked.reset - Date.now()) / 1000));
      return { ok: false, dim: blocked.k.dim, retryAfter };
    }
    return { ok: true };
  } catch (err) {
    console.warn(
      '[rate-limit] Upstash check failed, allowing through:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: true };
  }
}

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
  // Pass 1 — read every dim. Bucket key includes (max, windowMs) so
  // different limit configs over the same dim+value (e.g., per-customer
  // 5/15m for token-pay vs per-customer 3/15m for attach) don't share
  // buckets. Without this they'd corrupt each other.
  for (const k of keys) {
    const mapKey = `m:${k.max}:${k.windowMs}:${k.dim}:${k.value}`;
    const bucket = buckets.get(mapKey);
    if (bucket && bucket.resetAt >= now && bucket.count >= k.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return { ok: false, dim: k.dim, retryAfter };
    }
  }
  // Pass 2 — all clear, increment every dim.
  for (const k of keys) {
    const mapKey = `m:${k.max}:${k.windowMs}:${k.dim}:${k.value}`;
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
  // Upstash when configured (Path B — multi-dyno-safe sliding window);
  // in-memory otherwise (Path A fallback).
  const useUpstash = !!getUpstash();
  const decision = useUpstash
    ? await previewLimitsUpstash(opts.keys)
    : previewLimits(opts.keys);
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
