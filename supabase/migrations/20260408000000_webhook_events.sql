-- Webhook idempotency table.
-- Prevents duplicate processing of webhook events from Moyasar, OTO, Foodics.
-- The unique (provider, event_id) constraint enforces idempotency at the DB level.

create table if not exists public.webhook_events (
  id bigserial primary key,
  provider text not null check (provider in ('moyasar', 'oto', 'foodics')),
  event_id text not null,
  processed_at timestamptz not null default now(),
  metadata jsonb,
  unique (provider, event_id)
);

create index if not exists idx_webhook_events_processed_at
  on public.webhook_events (processed_at desc);

-- RLS: only service role can read/write.
alter table public.webhook_events enable row level security;

-- No public policies; service role bypasses RLS.
comment on table public.webhook_events is 'Idempotency log for incoming webhook events. Service-role only.';
