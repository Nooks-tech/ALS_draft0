-- ALS customer orders – persisted so orders survive refresh. Not Nooks' orders table.
-- When Nooks order API exists we can also sync there.

create table if not exists public.customer_orders (
  id text primary key,
  merchant_id uuid,
  branch_id text,
  branch_name text,
  customer_id text not null,
  total_sar numeric not null,
  status text not null default 'Preparing' check (status in ('Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled')),
  items jsonb not null default '[]',
  order_type text not null check (order_type in ('delivery', 'pickup')),
  delivery_address text,
  delivery_lat numeric,
  delivery_lng numeric,
  delivery_city text,
  oto_id integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_customer_orders_customer_id on public.customer_orders (customer_id);
create index if not exists idx_customer_orders_created_at on public.customer_orders (created_at desc);

alter table public.customer_orders enable row level security;

-- Authenticated users: insert/select/update only rows where customer_id = their auth id.
-- Guest orders (customer_id = 'guest') are not persisted to Supabase; they stay in app state.
create policy "Users can insert own orders"
  on public.customer_orders for insert
  with check (auth.uid()::text = customer_id);

create policy "Users can select own orders"
  on public.customer_orders for select
  using (auth.uid()::text = customer_id);

-- No update policy for users: only backend/service role can update status (e.g. when OTO or Nooks updates).
