-- Dispatch retry tracking for delivery orders.
-- Replaces the previous fire-and-forget OTO dispatch with a tracked, retryable job.
-- A cron worker reprocesses 'failed' rows whose next_retry_at has passed.

alter table public.customer_orders
  add column if not exists dispatch_status text
    check (dispatch_status in ('pending', 'in_progress', 'success', 'failed', 'abandoned'))
    default 'pending',
  add column if not exists dispatch_attempts integer not null default 0,
  add column if not exists dispatch_last_error text,
  add column if not exists dispatch_next_retry_at timestamptz,
  add column if not exists dispatch_last_attempt_at timestamptz;

-- Index for the cron worker's "find retryable jobs" query
create index if not exists idx_customer_orders_dispatch_retry
  on public.customer_orders (dispatch_status, dispatch_next_retry_at)
  where dispatch_status in ('failed', 'pending');

comment on column public.customer_orders.dispatch_status is 'OTO dispatch state machine: pending → in_progress → success | failed → in_progress (retry) → ... → abandoned';
comment on column public.customer_orders.dispatch_attempts is 'Number of dispatch attempts made (max 5 before abandoned).';
comment on column public.customer_orders.dispatch_last_error is 'Most recent dispatch error message for debugging.';
comment on column public.customer_orders.dispatch_next_retry_at is 'When the next retry should be attempted (exponential backoff).';
