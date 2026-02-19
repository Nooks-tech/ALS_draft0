# Supabase Auth (Email & Password + OTP)

## Flow

1. **First screen**: Email + Password → Continue (signs in or creates account)
2. **OTP screen**: 6-digit code sent to email → user enters code → Verify
3. **Complete profile**: Phone number (if missing) → Continue → Menu

## Tables Required

### 1. Profiles Table

Run this SQL in Supabase Dashboard → SQL Editor:

```sql
-- From supabase/migrations/20260217000000_create_profiles.sql
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  phone_number text,
  avatar_url text,
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select using (true);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);
```

### 2. Email OTP Table (for 6-digit verification)

```sql
-- From supabase/migrations/20260217100000_create_email_otp.sql
create table if not exists public.email_otp (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index idx_email_otp_email on public.email_otp (email);
alter table public.email_otp enable row level security;
```

## Server Setup (for OTP)

Add to `server/.env`:

- `SUPABASE_URL` – your project URL
- `SUPABASE_SERVICE_ROLE_KEY` – from Dashboard → Settings → API (keep secret)
- `RESEND_API_KEY` – from resend.com (free tier: 100 emails/day)
- `OTP_FROM_EMAIL` – e.g. `onboarding@resend.dev` for testing

Without Resend, the server logs the OTP to console (for dev).

## Setup

1. Create a project at [supabase.com](https://supabase.com).

2. In **Project Settings → API**, copy:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **anon public** key (long JWT starting with `eyJ...`)

3. Add to `.env`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...your_anon_key
   ```

4. (Optional) To skip email verification and sign in immediately after sign up:
   - Supabase Dashboard → Authentication → Providers → Email
   - Turn off **Confirm email**

## Flow

- **Sign up**: User enters email + password → account created → (if confirmation on) user must click link in email → then sign in
- **Sign in**: User enters email + password → Supabase validates → user is signed in
- **Log out**: User taps Log Out in More tab → session cleared → redirected to login

## Security

- Never commit real keys. Use `.env` and add it to `.gitignore`.
- The `sb_secret_` / `sb_publishable_` format is **Stripe**, not Supabase. Use the JWT-style keys from the Supabase API settings.
