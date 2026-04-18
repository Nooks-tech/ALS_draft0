-- Mirror of nooksweb migration. See that file for the rationale.
alter table public.customer_orders
  add column if not exists ready_at timestamptz;
