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
