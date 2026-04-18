-- Mirror of nooksweb/supabase/migrations/20260417000000_expand_order_status.sql
-- Both repos target the same Supabase project, so keeping them in sync avoids
-- divergence when either tree's migrations get replayed against a fresh DB.

alter table public.customer_orders
  drop constraint if exists customer_orders_status_check;

alter table public.customer_orders
  add constraint customer_orders_status_check
  check (status in (
    'Placed',
    'Accepted',
    'Preparing',
    'Ready',
    'Out for delivery',
    'Delivered',
    'Cancelled',
    'On Hold',
    'Pending'
  ));

alter table public.customer_orders
  alter column status set default 'Placed';
