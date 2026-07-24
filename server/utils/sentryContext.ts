import * as Sentry from '@sentry/node';

/**
 * Phase A observability — ALS side.
 *
 * tagSentry: attach merchant / customer / order tags to the current
 * Sentry scope so the dashboard can filter by tenant. Call at the top
 * of any route handler that has the context.
 *
 * captureError: explicitly ship a caught exception to Sentry with
 * structured tags + extra context. Use at catch sites where the
 * error matters but the caller doesn't re-throw (so Sentry's express
 * middleware never sees it).
 *
 * Both are safe to call when SENTRY_DSN is unset — Sentry.init was a
 * no-op so these become no-ops too.
 */

const HEADER_DENY_LIST = new Set([
  'authorization',
  'cookie',
  'x-nooks-internal-secret',
  'x-nooks-internal-signature',
  'x-nooks-internal-nonce',
  'x-nooks-internal-timestamp',
  'x-supabase-auth',
  'x-cron-secret',
]);

const BODY_DENY_KEYS = new Set([
  'code',
  'password',
  'secret_key',
  'live_secret_key',
  'test_secret_key',
  'moyasar_secret_key',
  'supabase_service_role_key',
  'nooks_internal_secret',
  'nooks_internal_hmac_key',
  'github_token',
  'build_webhook_secret',
  'madar_sms_api_key',
  'encrypted_value',
  'token', // e.g. the long-lived kiosk JWT (?token=...)
]);

// Query-param names stripped from any URL the scrubber sees — both
// event.request.url and breadcrumb.data.url. Mirror of
// nooksweb/lib/sentry-scrub.ts's URL_PARAM_DENY_LIST.
const URL_PARAM_DENY_LIST = new Set([
  'token',
  'access_token',
  'apikey',
  'api_key',
  'key',
  'secret',
]);

// 2026-07-24 legal review, Tier 1 finding #1 / Tier 1 finding #2: the
// original deny lists above only strip secrets (auth headers, OTP
// codes), so request bodies carrying customer names/phones/emails were
// shipping to Sentry (US) unredacted — a PDPL cross-border-transfer
// problem on top of the "Sentry anonymized" claim in the privacy
// policy being false. These widen coverage to personal data. Field
// names are matched case-insensitively and at any nesting depth.
const PII_KEY_DENY_LIST = new Set([
  'name',
  'full_name',
  'phone',
  'phone_number',
  'mobile',
  'email',
  'address',
  'delivery_address',
]);

// Saudi mobile numbers, international (+9665XXXXXXXX / 9665XXXXXXXX) and
// local (05XXXXXXXX) formats. Matched inside free-text string values too
// (e.g. a note field that pastes a phone number), not just fields named
// in PII_KEY_DENY_LIST above.
const SA_PHONE_PATTERNS = [/\+?9665\d{8}/g, /\b05\d{8}\b/g];
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function redactPiiPatterns(value: string): string {
  let out = value;
  for (const pattern of SA_PHONE_PATTERNS) out = out.replace(pattern, '[redacted]');
  out = out.replace(EMAIL_PATTERN, '[redacted]');
  return out;
}

// Like redactDeep above, but for PII rather than secrets: redacts whole
// values under PII_KEY_DENY_LIST keys, and additionally scans every
// string leaf (regardless of key) for embedded phone numbers / emails.
function redactPiiDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return redactPiiPatterns(value);
  if (Array.isArray(value)) return value.map((v) => redactPiiDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEY_DENY_LIST.has(k.toLowerCase())) out[k] = '[redacted]';
      else out[k] = redactPiiDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Redacts denylisted query params from a URL string, returning it
// unchanged if nothing matched. Handles relative URLs (e.g.
// "/api/kiosk/pending-order?token=...") by returning a relative
// string rather than inventing an origin.
function scrubUrlString(raw: string): string {
  const isRelative = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  try {
    const url = new URL(raw, isRelative ? 'http://sentry-scrub.invalid' : undefined);
    let changed = false;
    for (const key of url.searchParams.keys()) {
      if (URL_PARAM_DENY_LIST.has(key.toLowerCase())) {
        url.searchParams.set(key, '[Filtered]');
        changed = true;
      }
    }
    if (!changed) return raw;
    return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    return raw;
  }
}

function redactStringMap(input: Record<string, unknown> | undefined, deny: Set<string>): void {
  if (!input || typeof input !== 'object') return;
  for (const key of Object.keys(input)) {
    if (deny.has(key.toLowerCase())) input[key] = '[redacted]';
  }
}

function redactDeep(value: unknown, deny: Set<string>, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, deny, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (deny.has(k.toLowerCase())) out[k] = '[redacted]';
      else out[k] = redactDeep(v, deny, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Scrub a Sentry event before send. Strips secret-bearing headers/body
 * fields (auth tokens, OTP codes) AND personal data (names, phones,
 * emails, addresses — by field name and, for phones/emails, by pattern
 * anywhere in a string value) from request bodies, query strings, and
 * breadcrumbs. Started as a mirror of nooksweb/lib/sentry-scrub.ts; the
 * PII redaction below goes further than that file (see PII_KEY_DENY_LIST
 * above, added 2026-07-24).
 */
export function scrubSentryEvent(event: Sentry.Event): Sentry.Event | null {
  try {
    if (event.request) {
      redactStringMap(event.request.headers as Record<string, unknown> | undefined, HEADER_DENY_LIST);
      if (event.request.query_string && typeof event.request.query_string === 'object') {
        redactStringMap(
          event.request.query_string as unknown as Record<string, unknown>,
          BODY_DENY_KEYS,
        );
        event.request.query_string = redactPiiDeep(
          event.request.query_string,
        ) as typeof event.request.query_string;
      }
      if (event.request.data !== undefined) {
        event.request.data = redactDeep(event.request.data, BODY_DENY_KEYS) as typeof event.request.data;
        event.request.data = redactPiiDeep(event.request.data) as typeof event.request.data;
      }
      if (typeof event.request.url === 'string') {
        event.request.url = scrubUrlString(event.request.url);
      }
    }
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map((bc) => {
        if (bc.data && typeof bc.data === 'object') {
          const data = bc.data as Record<string, unknown>;
          if (data.headers) redactStringMap(data.headers as Record<string, unknown>, HEADER_DENY_LIST);
          if (data.body !== undefined) {
            data.body = redactDeep(data.body, BODY_DENY_KEYS);
            data.body = redactPiiDeep(data.body);
          }
          if (typeof data.url === 'string') data.url = scrubUrlString(data.url);
        }
        if (typeof bc.message === 'string') {
          bc.message = redactPiiPatterns(bc.message);
        }
        return bc;
      });
    }
  } catch {
    // Don't let observability throw.
  }
  return event;
}

export function tagSentry(ctx: {
  merchantId?: string | null;
  customerId?: string | null;
  orderId?: string | null;
  paymentId?: string | null;
  route?: string | null;
}) {
  try {
    const scope = Sentry.getCurrentScope();
    if (ctx.merchantId) scope.setTag('merchant_id', ctx.merchantId);
    if (ctx.customerId) scope.setTag('customer_id', ctx.customerId);
    if (ctx.orderId) scope.setTag('order_id', ctx.orderId);
    if (ctx.paymentId) scope.setTag('payment_id', ctx.paymentId);
    if (ctx.route) scope.setTag('route', ctx.route);
  } catch {
    /* no-op */
  }
}

export function captureError(
  error: unknown,
  ctx: {
    component: string;
    merchantId?: string | null;
    customerId?: string | null;
    orderId?: string | null;
    paymentId?: string | null;
    extra?: Record<string, unknown>;
  },
) {
  try {
    Sentry.captureException(error, {
      tags: {
        component: ctx.component,
        ...(ctx.merchantId ? { merchant_id: ctx.merchantId } : {}),
        ...(ctx.customerId ? { customer_id: ctx.customerId } : {}),
        ...(ctx.orderId ? { order_id: ctx.orderId } : {}),
        ...(ctx.paymentId ? { payment_id: ctx.paymentId } : {}),
      },
      extra: ctx.extra,
    });
  } catch {
    /* no-op */
  }
}
