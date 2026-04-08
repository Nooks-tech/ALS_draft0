/**
 * Webhook idempotency: prevent duplicate processing of webhook events.
 *
 * Moyasar retries 5x over ~3.5 hours on non-2xx responses. OTO will retry on
 * connection errors. We dedupe by (provider, event_id) — recording rows in
 * `webhook_events` table after a webhook is successfully processed.
 *
 * Schema (created by migration 20260408000000_webhook_events.sql):
 *   create table public.webhook_events (
 *     id bigserial primary key,
 *     provider text not null,         -- 'moyasar' | 'oto' | 'foodics'
 *     event_id text not null,          -- provider-supplied event id (or fallback hash)
 *     processed_at timestamptz not null default now(),
 *     metadata jsonb,
 *     unique (provider, event_id)
 *   );
 *
 * Older rows can be pruned periodically; the unique constraint is what enforces idempotency.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

export type WebhookProvider = 'moyasar' | 'oto' | 'foodics';

/** Returns true if this (provider, event_id) was already processed. */
export async function hasProcessedWebhookEvent(
  provider: WebhookProvider,
  eventId: string,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (!eventId) return false;
  const { data, error } = await supabaseAdmin
    .from('webhook_events')
    .select('id')
    .eq('provider', provider)
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) {
    console.warn('[webhookIdempotency] lookup failed (treating as new):', error.message);
    return false;
  }
  return Boolean(data);
}

/** Record that this event was processed. Safe to call after a successful handler run. */
export async function recordWebhookEvent(
  provider: WebhookProvider,
  eventId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!supabaseAdmin) return;
  if (!eventId) return;
  const { error } = await supabaseAdmin
    .from('webhook_events')
    .insert({
      provider,
      event_id: eventId,
      metadata: metadata ?? null,
    });
  if (error && !/duplicate key/i.test(error.message)) {
    console.warn('[webhookIdempotency] insert failed:', error.message);
  }
}
