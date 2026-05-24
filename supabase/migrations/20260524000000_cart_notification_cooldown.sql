-- ============================================================================
-- CART-ABANDONMENT NOTIFICATION COOLDOWN
-- ----------------------------------------------------------------------------
-- Founder spec 2026-05-24: "the notification get send but i only need to be
-- send once". The 15-min idle push was firing repeatedly for the same
-- customer because the customer-app's CartContext silently re-syncs the
-- local cart back to the server after the cron abandons it. Every
-- recreation restarted the 15-min clock and re-fired a notification ~50
-- minutes after the previous one.
--
-- Per-customer cooldown stamp on merchant_customers solves it at the
-- server: the cart cron checks last_cart_notification_at before sending
-- a push and skips (still stamping notified_at on the cart row so the
-- cron stops re-checking it). Cooldown duration lives in the cron
-- (NOTIFY_COOLDOWN_MS) — currently 24h.
--
-- Index on (merchant_id, last_cart_notification_at) supports the cron's
-- batch lookup of "everyone we've recently notified" without a full
-- scan; the WHERE clause skips rows with NULL since those have never
-- been notified.
-- ============================================================================

alter table public.merchant_customers
  add column if not exists last_cart_notification_at timestamptz;

create index if not exists idx_merchant_customers_cart_notif
  on public.merchant_customers (merchant_id, last_cart_notification_at)
  where last_cart_notification_at is not null;

comment on column public.merchant_customers.last_cart_notification_at is
  'Most recent cart-abandonment push timestamp. Cron skips notifying this (merchant, customer) pair while a row is within the cooldown window — prevents the silent-resync recreate-loop from re-pinging the same person every 50 min.';
