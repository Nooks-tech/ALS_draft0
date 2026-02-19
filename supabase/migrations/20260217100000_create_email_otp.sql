-- Email OTP for verification after password auth
create table if not exists public.email_otp (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists idx_email_otp_email on public.email_otp (email);
create index if not exists idx_email_otp_expires on public.email_otp (expires_at);

-- RLS: anon has no access; backend uses service_role which bypasses RLS
alter table public.email_otp enable row level security;