import crypto from 'crypto';
import type { Request, Response } from 'express';

const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

let warnedMissingSecret = false;

function safeHeaderValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost')
  );
}

export function isPrivateIp(ip: string) {
  const normalized = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  return (
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}

export function isLocalOnlyRequest(req: Request) {
  const forwardedFor = safeHeaderValue(req.headers['x-forwarded-for']).split(',')[0] || '';
  const hostHeader = safeHeaderValue(req.headers.host).split(':')[0] || '';
  const remoteAddress = safeHeaderValue(req.socket?.remoteAddress);
  return (
    isLoopbackHost(hostHeader) ||
    isPrivateIp(forwardedFor) ||
    isPrivateIp(remoteAddress)
  );
}

export function hasValidInternalSecret(req: Request) {
  // Internal secret ONLY travels in x-nooks-internal-secret.
  // The Bearer-token fallback was removed 2026-05-18 — it widened
  // the log-exposure surface (most middleware redacts Authorization
  // but not arbitrary custom headers, so accepting the secret in
  // either spot doubled the places it could show up in a log dump).
  // If a caller is using Authorization: Bearer for this secret,
  // update them to send x-nooks-internal-secret instead.
  const headerToken = safeHeaderValue(req.headers['x-nooks-internal-secret']);
  if (!NOOKS_INTERNAL_SECRET || !headerToken) return false;
  return constantTimeEquals(headerToken, NOOKS_INTERNAL_SECRET);
}

/**
 * Protect merchant-to-server actions that must only be triggered by nooksweb.
 * If the shared secret is missing we only allow loopback/private-network calls,
 * never remotely exposed requests.
 */
export function requireNooksInternalRequest(req: Request, res: Response): boolean {
  if (!NOOKS_INTERNAL_SECRET) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn('[InternalAuth] NOOKS_INTERNAL_SECRET is not configured; only local/private-network calls are allowed.');
    }
    if (isLocalOnlyRequest(req)) {
      return true;
    }
    res.status(503).json({ error: 'Internal auth is not configured' });
    return false;
  }

  if (hasValidInternalSecret(req)) {
    return true;
  }

  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

/**
 * Diagnostic routes are never public on remotely reachable environments.
 */
export function requireDiagnosticAccess(req: Request, res: Response): boolean {
  return requireNooksInternalRequest(req, res);
}
