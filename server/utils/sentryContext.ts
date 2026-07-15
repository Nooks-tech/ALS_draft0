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
 * Scrub a Sentry event before send. Strips secret-bearing headers and
 * body fields. Mirror of nooksweb/lib/sentry-scrub.ts.
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
      }
      if (event.request.data !== undefined) {
        event.request.data = redactDeep(event.request.data, BODY_DENY_KEYS) as typeof event.request.data;
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
          if (data.body !== undefined) data.body = redactDeep(data.body, BODY_DENY_KEYS);
          if (typeof data.url === 'string') data.url = scrubUrlString(data.url);
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
