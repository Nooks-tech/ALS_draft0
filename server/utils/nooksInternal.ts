import crypto from 'crypto';
import type { Request, Response } from 'express';

const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();
const NOOKS_INTERNAL_HMAC_KEY = (process.env.NOOKS_INTERNAL_HMAC_KEY || '').trim();
// 5-minute window — long enough for legit network/clock skew, short
// enough that a Sentry / log replay of an old signed request expires
// before an attacker can resend it.
const HMAC_FRESHNESS_MS = 5 * 60 * 1000;

let warnedMissingSecret = false;
let warnedHmacEnforcement = false;

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
 * R3 fix: HMAC verification adds a second layer on top of the shared
 * secret. The shared secret travels in a header on every internal
 * request and ends up in many places that could leak (Sentry breadcrumbs,
 * access logs, Railway/Vercel request logs). The HMAC key is used to
 * SIGN each request but never travels over the wire, so it doesn't
 * leak when the secret does.
 *
 * Soft rollout: enforcement only kicks in when NOOKS_INTERNAL_HMAC_KEY
 * is configured on this side. nooksweb's helper sends signed headers
 * when its NOOKS_INTERNAL_HMAC_KEY is configured. Set the env on both
 * sides simultaneously to turn on enforcement; otherwise the system
 * behaves exactly like before (secret-only).
 *
 * Header format:
 *   x-nooks-internal-timestamp: <unix-ms>
 *   x-nooks-internal-nonce:     <random>
 *   x-nooks-internal-signature: hex(HMAC-SHA256(key,
 *       `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256(body)}`))
 *
 * Body hash includes the raw request body (or empty string for no-body
 * GETs). The 5-minute timestamp window bounds how long any signature can
 * live; within that window the nonce replay guard (PRIV-06) rejects a
 * second use of the same signed request so a captured-but-still-fresh
 * request can't be replayed verbatim.
 */
export function isInternalHmacEnabled() {
  return NOOKS_INTERNAL_HMAC_KEY.length > 0;
}

// PRIV-06 (2026-07-10): in-memory nonce replay guard. A valid signature is
// accepted at most once within its freshness window; a replay of the exact
// same signed request (same nonce) is rejected. Keyed on nonce → expiry epoch
// ms (= the timestamp past which the signature is stale anyway, so the entry
// can be forgotten). Single-replica today; a multi-replica ALS deployment
// needs a shared store (Redis) for this to hold across processes — noted for
// the scale lift. Pruned opportunistically so the map can't grow unbounded
// under a bad-actor nonce flood (only *verified* signatures ever land here).
const seenHmacNonces = new Map<string, number>();
const MAX_TRACKED_NONCES = 5000;

function recordFreshNonce(nonce: string, expiryMs: number): boolean {
  const now = Date.now();
  const existing = seenHmacNonces.get(nonce);
  if (existing !== undefined && existing > now) {
    return false; // already seen and still within its freshness window → replay
  }
  if (seenHmacNonces.size >= MAX_TRACKED_NONCES) {
    for (const [key, exp] of seenHmacNonces) {
      if (exp <= now) seenHmacNonces.delete(key);
    }
  }
  seenHmacNonces.set(nonce, expiryMs);
  return true;
}

function getRawBodyString(req: Request): string {
  // Express's json middleware sets req.body; we re-stringify it the
  // same way the caller did. The caller MUST send the body as
  // JSON.stringify(...) without extra whitespace for the hash to match.
  // GET / no-body requests hash an empty string.
  if (req.body === undefined || req.body === null || (typeof req.body === 'object' && Object.keys(req.body).length === 0 && !Array.isArray(req.body))) {
    // empty body: hash the empty string. Body-less GETs land here.
    if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return '';
    return '';
  }
  try {
    return JSON.stringify(req.body);
  } catch {
    return '';
  }
}

let warnedHmacUnset = false;

export function verifyInternalHmac(req: Request): { ok: true } | { ok: false; reason: string } {
  if (!isInternalHmacEnabled()) {
    // Soft rollout / backward-compat: HMAC not configured on this side, accept.
    // PRIV-06: with the key unset there is no signature to verify and no nonce
    // to track, so the replay guard is inactive — warn once so this weaker
    // posture is visible in logs. Callers are NOT broken (secret-only still
    // gates the endpoint via requireNooksInternalRequest).
    if (!warnedHmacUnset) {
      warnedHmacUnset = true;
      console.warn('[InternalAuth] NOOKS_INTERNAL_HMAC_KEY is not configured; HMAC signature + nonce replay protection are disabled (secret-only auth).');
    }
    return { ok: true };
  }
  const timestampStr = safeHeaderValue(req.headers['x-nooks-internal-timestamp']);
  const nonce = safeHeaderValue(req.headers['x-nooks-internal-nonce']);
  const signature = safeHeaderValue(req.headers['x-nooks-internal-signature']);
  if (!timestampStr || !nonce || !signature) {
    return { ok: false, reason: 'missing signature headers' };
  }
  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  const skew = Math.abs(Date.now() - timestamp);
  if (skew > HMAC_FRESHNESS_MS) {
    return { ok: false, reason: `stale signature (skew ${Math.round(skew / 1000)}s)` };
  }
  const bodyString = getRawBodyString(req);
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');
  // We use originalUrl (path + querystring) because the signed path
  // upstream is the request URL nooksweb fetched, which includes
  // any query params.
  const path = (req.originalUrl ?? req.url ?? '').toString();
  const payload = `${req.method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const expected = crypto
    .createHmac('sha256', NOOKS_INTERNAL_HMAC_KEY)
    .update(payload)
    .digest('hex');
  if (!constantTimeEquals(signature, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  // PRIV-06: replay guard. Only record AFTER the signature verifies, so an
  // attacker can't fill the nonce map with unsigned junk. A second use of the
  // same nonce inside its freshness window is a replay. The signature is bound
  // to the nonce, so a distinct legit request always carries a distinct nonce.
  if (!recordFreshNonce(nonce, timestamp + HMAC_FRESHNESS_MS)) {
    return { ok: false, reason: 'nonce replay' };
  }
  return { ok: true };
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
    // In production an unset secret FAILS CLOSED — the private-IP
    // fallback relies on x-forwarded-for, which is spoofable enough
    // that it must never gate a remotely reachable deployment. The
    // local/private-network path remains for development only.
    if (process.env.NODE_ENV !== 'production' && isLocalOnlyRequest(req)) {
      return true;
    }
    res.status(503).json({ error: 'Internal auth is not configured' });
    return false;
  }

  if (!hasValidInternalSecret(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  // R3 fix: when HMAC enforcement is on, the secret alone is not
  // enough. The HMAC key is the second factor; both must validate.
  const hmacResult = verifyInternalHmac(req);
  if (!hmacResult.ok) {
    if (!warnedHmacEnforcement) {
      warnedHmacEnforcement = true;
      console.warn('[InternalAuth] HMAC verification enforced; rejecting request without valid signature:', hmacResult.reason);
    }
    // Phase B: audit EVERY rejection (not just the first via the
    // warnedHmacEnforcement flag). An attacker probing with bad
    // signatures, or a misconfigured caller, otherwise leaves zero
    // signal after the first event.
    void (async () => {
      try {
        const { writeAudit } = await import('./auditLog');
        await writeAudit({
          merchant_id: null,
          action: 'internal.hmac_rejected',
          payload: {
            reason: hmacResult.reason,
            method: req.method,
            path: (req.originalUrl ?? req.url ?? '').toString().slice(0, 200),
            ip: safeHeaderValue(req.headers['x-forwarded-for']).split(',')[0] || 'unknown',
          },
        });
      } catch { /* never let audit throw */ }
    })();
    res.status(401).json({ error: `Unauthorized: ${hmacResult.reason}` });
    return false;
  }

  return true;
}

/**
 * Diagnostic routes are never public on remotely reachable environments.
 */
export function requireDiagnosticAccess(req: Request, res: Response): boolean {
  return requireNooksInternalRequest(req, res);
}
