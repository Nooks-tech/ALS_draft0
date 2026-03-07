-- SMS OTP for phone-based authentication (replaces email_otp)
create table if not exists public.sms_otp (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists idx_sms_otp_phone on public.sms_otp (phone);
create index if not exists idx_sms_otp_expires on public.sms_otp (expires_at);

alter table public.sms_otp enable row level security;
