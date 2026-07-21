-- Persist checkout channel so browser orders can remain operationally visible
-- to merchants while staying out of the branded native customer app.

alter table public.customer_orders
  add column if not exists order_source text;

update public.customer_orders
set order_source = case
  when id like 'web-%' then 'web'
  else 'native'
end
where order_source is null;

alter table public.customer_orders
  alter column order_source set default 'native',
  alter column order_source set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_orders_order_source_valid'
      and conrelid = 'public.customer_orders'::regclass
  ) then
    alter table public.customer_orders
      add constraint customer_orders_order_source_valid
      check (order_source in ('native', 'web', 'kiosk', 'pos'));
  end if;
end $$;

create index if not exists idx_customer_orders_customer_native_history
  on public.customer_orders (customer_id, merchant_id, created_at desc, id)
  where order_source <> 'web' and foodics_order_id is not null;

-- This is RESTRICTIVE, so it is ANDed with the existing select-own policy.
-- It protects already-installed app versions that do not yet add the explicit
-- order_source filter. service_role continues to bypass RLS for merchant and
-- operational workflows.
drop policy if exists "customer_orders_hide_web_from_authenticated"
  on public.customer_orders;
create policy "customer_orders_hide_web_from_authenticated"
  on public.customer_orders
  as restrictive
  for select
  to authenticated
  using (order_source <> 'web');

comment on column public.customer_orders.order_source is
  'Checkout channel. Web orders remain merchant-visible but are hidden from authenticated native-app reads and customer order pushes.';
