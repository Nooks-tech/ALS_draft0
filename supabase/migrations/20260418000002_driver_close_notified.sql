-- Mirror of nooksweb migration.
alter table public.customer_orders
  add column if not exists driver_close_notified_at timestamptz;
