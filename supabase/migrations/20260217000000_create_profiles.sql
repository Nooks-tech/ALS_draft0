-- Profiles table - linked to auth.users, used by restaurant/driver
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  phone_number text,
  avatar_url text,
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Anyone can view profiles (so drivers/restaurant can see customer name & phone)
create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

-- Users can update only their own profile
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Users can insert their own profile
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);
