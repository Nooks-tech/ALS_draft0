import type { Request, Response } from 'express';

const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

let warnedMissingSecret = false;

/**
 * Protect merchant-to-server actions that must only be triggered by nooksweb.
 * When the shared secret is not configured we allow the request in dev, but
 * we warn once so production does not silently stay unsecured.
 */
export function requireNooksInternalRequest(req: Request, res: Response): boolean {
  if (!NOOKS_INTERNAL_SECRET) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn('[InternalAuth] NOOKS_INTERNAL_SECRET is not configured; internal routes are currently unsecured.');
    }
    return true;
  }

  const headerToken =
    (typeof req.headers['x-nooks-internal-secret'] === 'string' ? req.headers['x-nooks-internal-secret'] : '') ||
    (typeof req.headers.authorization === 'string' ? req.headers.authorization : '');

  if (headerToken === NOOKS_INTERNAL_SECRET || headerToken === `Bearer ${NOOKS_INTERNAL_SECRET}`) {
    return true;
  }

  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
