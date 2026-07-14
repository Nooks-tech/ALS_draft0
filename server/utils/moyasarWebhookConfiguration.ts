export const NOOKS_MOYASAR_WEBHOOK_URL = 'https://nooks.space/api/webhooks/moyasar';
export const REQUIRED_MOYASAR_PAYMENT_EVENTS = [
  'payment_paid',
  'payment_failed',
  'payment_voided',
  'payment_captured',
  'payment_refunded',
] as const;

export type MoyasarWebhook = {
  id?: string;
  http_method?: string;
  url?: string;
  events?: string[];
};

function normalizedUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

export function hasRequiredMoyasarEvents(events: unknown): boolean {
  if (!Array.isArray(events)) return false;
  const actual = new Set(events.filter((value): value is string => typeof value === 'string'));
  return REQUIRED_MOYASAR_PAYMENT_EVENTS.every((event) => actual.has(event));
}

export function isCorrectNooksMoyasarWebhook(webhook: MoyasarWebhook): boolean {
  const actual = normalizedUrl(webhook.url);
  const expected = normalizedUrl(NOOKS_MOYASAR_WEBHOOK_URL);
  return Boolean(
    actual &&
    expected &&
    actual.protocol === 'https:' &&
    actual.hostname === expected.hostname &&
    actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') &&
    (webhook.http_method ?? '').toLowerCase() === 'post' &&
    hasRequiredMoyasarEvents(webhook.events),
  );
}

export function isLegacyRailwayRootWebhook(webhook: MoyasarWebhook): boolean {
  const url = normalizedUrl(webhook.url);
  return Boolean(
    url &&
    url.hostname === 'alsdraft0-production.up.railway.app' &&
    (url.pathname === '/' || url.pathname === '') &&
    (webhook.http_method ?? '').toLowerCase() === 'post',
  );
}
