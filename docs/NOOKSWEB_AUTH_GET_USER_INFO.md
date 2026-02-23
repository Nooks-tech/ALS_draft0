# Nooksweb: How to Use Auth to Get User Info (Very Detailed)

This document explains **exactly** how auth works in nooksweb and how to get the current user’s information (and their merchant record) in every part of your app. Use it when implementing signup, login, dashboard, API routes, and protected pages.

---

## 1. What “user” means in nooksweb

In nooksweb there are two linked concepts:

1. **Auth user** – The person who signed up or signed in. Stored in Supabase **`auth.users`**. Has an **`id`** (UUID), **`email`**, and other auth fields. This is who is “logged in.”
2. **Merchant** – The business (café) record. Stored in **`public.merchants`**. Each row has **`user_id`** = the auth user’s `id`. So: **one auth user → one merchant** (for your current design).

When we say “get user info,” we usually mean:

- **Auth info:** who is logged in (`auth.users.id`, `email`, etc.).
- **Merchant info:** the merchant row for that user (`merchants.id`, `full_name`, `cafe_name`, `status`, etc.), which you use for dashboard, branding, and public APIs.

This doc covers both: how to get the **auth user** and how to get the **merchant** for that user.

---

## 2. Where the data lives (Supabase)

### 2.1 Auth schema (Supabase-managed)

Supabase manages **`auth.users`**. You don’t create this table; it exists by default. Relevant columns (conceptually):

| Column        | Type   | Description |
|---------------|--------|-------------|
| `id`          | uuid   | **Primary key.** Use this as “the user’s id.” Same as `auth.uid()` in RLS. |
| `email`       | text   | Email address (for email signup/signin). |
| `encrypted_password` | text | Only for email provider; don’t read this in app code. |
| `email_confirmed_at`  | timestamptz | When email was confirmed (if you use confirm email). |
| `created_at`, `updated_at` | timestamptz | |
| `raw_user_meta_data` | jsonb | Optional metadata you pass on signup (e.g. `full_name`). |
| `raw_app_meta_data`  | jsonb | Optional app-specific metadata. |

You **never** query `auth.users` directly from your app with a normal Supabase client. You get the current user via:

- **Client:** `supabase.auth.getUser()` or `supabase.auth.getSession()`.
- **Server:** Same methods, but with a **server-side** Supabase client that has access to the session (e.g. from cookies).

The **session** contains a JWT. The JWT’s `sub` claim is the user’s `id` (same as `auth.users.id`). So “current user id” = `session.user.id` = `auth.uid()` in RLS.

### 2.2 Your schema: `public.merchants`

Your migrations create **`public.merchants`**. Typical shape (align with your actual migration):

| Column      | Type   | Description |
|-------------|--------|-------------|
| `id`        | uuid   | **Primary key.** This is the **merchant id** you use everywhere: dashboard, public APIs, build webhook. |
| `user_id`   | uuid   | **Foreign key to `auth.users.id`.** Links this merchant to the logged-in user. One-to-one: one user → one merchant. |
| `full_name` | text   | Merchant’s display name (person). |
| `cafe_name` | text   | Business/café name. |
| `status`    | text   | e.g. `'pending'` \| `'active'` \| `'suspended'`. |
| `created_at`, `updated_at` | timestamptz | |

So:

- **Auth user id** = `auth.users.id` = `session.user.id` = what you use as “who is logged in.”
- **Merchant id** = `merchants.id` = what you use for “which business” (branding API, operations, branches, build webhook).
- **Link:** `merchants.user_id = auth.users.id`.

### 2.3 Trigger: create merchant on signup

You should have a trigger that **creates a row in `merchants`** when a new user signs up, so every auth user has exactly one merchant row. Example (conceptual; match your migration):

```sql
-- After insert on auth.users, insert a row into public.merchants
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.merchants (id, user_id, full_name, cafe_name, status)
  values (
    gen_random_uuid(),
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'cafe_name', ''),
    'pending'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

So after **email signup**, you have:

1. New row in `auth.users` (Supabase does this).
2. New row in `public.merchants` with `user_id = auth.users.id` (trigger does this).

**Foodics sign-in:** If the user signs in with Foodics and you don’t create an `auth.users` row, you must **create** both the auth user (if you use Supabase for sessions) and the merchant row yourself in the Foodics callback. If you only store a Foodics token and don’t use Supabase Auth for that flow, then “user info” might come from Foodics until you link it to a Supabase user (see Section 8).

---

## 3. How the session works (high level)

1. User signs in (email/password or OAuth).
2. Supabase returns a **session** (access token JWT + refresh token). Your client stores it (e.g. in cookies or localStorage, depending on how you create the client).
3. Every request that sends the session (e.g. cookie) is “logged in”; the JWT’s `sub` is the **user id**.
4. In RLS, `auth.uid()` is that same user id.
5. To get “user info” you: (a) get the session (and thus `session.user`), (b) optionally load the merchant row where `merchants.user_id = session.user.id`.

---

## 4. Getting the current user: client-side (Next.js)

In the browser you use a **Supabase client** that can read the session (usually from cookies if you use the server-cookie pattern, or from localStorage if you use a pure client-only setup).

### 4.1 Create the client (client component)

You must use the **anon (public) key** in the browser, and the URL. In Next.js, env vars that are available in the browser must be prefixed with `NEXT_PUBLIC_`.

```ts
// lib/supabase/client.ts or utils/supabase/client.ts
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

If you don’t have `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` set in `.env.local`, the client will be misconfigured and you may get “Failed to fetch” on signUp/signIn.

### 4.2 Get current user (client component)

```ts
'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'

export default function SomeClientComponent() {
  const [user, setUser] = useState(null)
  const supabase = createClient()

  useEffect(() => {
    const load = async () => {
      const { data: { user: u } } = await supabase.auth.getUser()
      setUser(u)
    }
    load()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [supabase])

  if (!user) return <div>Not logged in</div>
  return <div>Logged in as {user.email} (id: {user.id})</div>
}
```

- **`supabase.auth.getUser()`** – Returns the current user from the session (and refreshes the session if needed). Prefer this over `getSession()` when you need the user object, because it validates the JWT server-side.
- **`supabase.auth.getSession()`** – Returns the current session (includes `session.user`). Slightly faster but may return a cached session; use when you only need to check “is there a session?” quickly.
- **`onAuthStateChange`** – Subscribe to sign-in / sign-out so your UI updates when the user logs in or out.

What you get in **`user`** (from `getUser()` or `session.user`):

- **`user.id`** – UUID (same as `auth.users.id`). Use this to load the merchant: `merchants.user_id = user.id`.
- **`user.email`** – string or undefined.
- **`user.user_metadata`** – object (e.g. `full_name` if you passed it on signUp).
- **`user.app_metadata`** – object.

So in the client, “user info” from auth is: **`user.id`**, **`user.email`**, and **`user.user_metadata`**.

### 4.3 Get the merchant for the current user (client)

After you have `user.id`, fetch the merchant row:

```ts
const { data: merchant, error } = await supabase
  .from('merchants')
  .select('id, full_name, cafe_name, status, created_at')
  .eq('user_id', user.id)
  .single()
```

- If your trigger creates one merchant per user, **`.single()`** is correct (exactly one row).
- **`merchant.id`** is the **merchant id** you use for dashboard, branding API, build webhook, etc.
- **`merchant.user_id`** equals `user.id`.

You can wrap this in a small hook, e.g. `useMerchant()`, that calls `getUser()`, then loads the merchant by `user_id`, and returns `{ user, merchant, loading, error }`.

---

## 5. Getting the current user: server-side (Next.js App Router)

On the server you don’t have “current tab” state; you have the **incoming request**. The session must be read from **cookies** (or from a header if you use a different pattern). Supabase’s recommended way is to use a **server client** that reads/writes the auth cookie.

### 5.1 Create the server client (reads cookies)

```ts
// lib/supabase/server.ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Can happen in Server Components; ignore or handle
          }
        },
      },
    }
  )
}
```

This client uses the **same anon key** as the browser; the difference is it gets the session from the request’s cookies. So after sign-in, your auth middleware or login flow must **set the auth cookies** (the Supabase client does this when you call `signInWithPassword` or when you set the session after OAuth).

### 5.2 Get current user in a Server Component

```ts
// app/dashboard/page.tsx (Server Component)
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/signin')
  }

  // user.id, user.email, user.user_metadata available here
  const { data: merchant } = await supabase
    .from('merchants')
    .select('id, full_name, cafe_name, status')
    .eq('user_id', user.id)
    .single()

  if (!merchant) {
    // Should not happen if trigger creates merchant on signup
    return <div>Merchant record not found</div>
  }

  return (
    <div>
      <h1>Dashboard</h1>
      <p>User: {user.email}</p>
      <p>Merchant: {merchant.cafe_name} (id: {merchant.id})</p>
    </div>
  )
}
```

So on the server, “user info” is:

1. **Auth:** `user` from `await supabase.auth.getUser()` (same `user.id`, `user.email`, etc.).
2. **Merchant:** one row from `merchants` where `user_id = user.id`.

### 5.3 Get current user in an API route (Route Handler)

Same idea: create the server client (so it gets the session from cookies), then get user and optionally merchant.

```ts
// app/api/me/route.ts
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: userError } = await supabase.auth.getUser()

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: merchant } = await supabase
    .from('merchants')
    .select('id, full_name, cafe_name, status')
    .eq('user_id', user.id)
    .single()

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      user_metadata: user.user_metadata,
    },
    merchant: merchant ?? null,
  })
}
```

This gives you a “current user + merchant” API that you can call from the client or use for internal checks.

### 5.4 Middleware: protect routes and refresh session

You want to (a) refresh the session if the JWT is close to expiry, and (b) redirect unauthenticated users away from protected routes (e.g. `/dashboard`, `/wizard`).

```ts
// middleware.ts (at project root)
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            response.cookies.set(name, value)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const isProtected = request.nextUrl.pathname.startsWith('/dashboard') ||
    request.nextUrl.pathname.startsWith('/wizard') ||
    request.nextUrl.pathname.startsWith('/billing')

  if (isProtected && !user) {
    const signInUrl = new URL('/signin', request.url)
    signInUrl.searchParams.set('next', request.nextUrl.pathname)
    return NextResponse.redirect(signInUrl)
  }

  // If logged in and hitting signin/signup, redirect to dashboard
  if (user && (request.nextUrl.pathname === '/signin' || request.nextUrl.pathname === '/signup')) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*', '/wizard/:path*', '/billing/:path*', '/signin', '/signup'],
}
```

Middleware runs on the edge; you typically only check “is there a user?” here and do the full “load merchant” in the page or API route.

---

## 6. Passing user/merchant into the rest of the app

- **Server Components:** Create the server client, call `getUser()`, then load `merchants` by `user_id`. Pass `user` and `merchant` as props to client components if needed.
- **Client Components:** Use the browser client, `getUser()`, and optionally a `useMerchant()` hook that loads the merchant by `user_id`. Or fetch from your own API (e.g. `GET /api/me`) that returns user + merchant.
- **API routes:** Create the server client, `getUser()`. If the route is merchant-scoped, load the merchant by `user_id` and use `merchant.id` for any DB or business logic.

You never need to “pass the password” or the raw JWT to the front; the session (in the cookie) is enough for the server to know who the user is.

---

## 7. Signup flow and when the merchant row exists

### 7.1 Email signup

1. User submits email + password on `/signup`.
2. You call `supabase.auth.signUp({ email, password, options: { emailRedirectTo: ... } })`.
3. Supabase creates a row in `auth.users` and (if you have the trigger) the trigger creates a row in `merchants` with `user_id = new.id`.
4. If “Confirm email” is on, Supabase sends an email; the user clicks the link and is redirected to your site (e.g. `/verify-email`). Until then, `email_confirmed_at` may be null and you might restrict access.
5. After confirmation (or immediately if confirm is off), the user has a session. On the next request, `getUser()` returns that user, and a query on `merchants` where `user_id = user.id` returns their merchant row.

So **right after signup** (and optionally after verify-email), the user already has a merchant row. You don’t need a separate “create merchant” step for email signup.

### 7.2 What to store in `user_metadata` on signup

You can pass `data: { full_name, cafe_name }` in `signUp` so the trigger (or your own logic) can prefill the merchant:

```ts
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    emailRedirectTo: `${origin}/verify-email?email=...`,
    data: {
      full_name: fullName.trim(),
      cafe_name: cafeName.trim(),
    },
  },
})
```

Then in the trigger, use `new.raw_user_meta_data->>'full_name'` and `->>'cafe_name'` when inserting into `merchants`.

---

## 8. Foodics sign-in: how you get “user” info

With **Sign in with Foodics**, the user is sent to Foodics’ site and then back to your callback. There are two common designs:

### 8.1 Option A: Foodics OAuth + Supabase session (recommended)

1. User clicks “Sign in with Foodics” → redirect to Foodics OAuth URL.
2. Foodics redirects back to your callback with `?code=...`.
3. In the callback (API route or server action):
   - Exchange `code` for Foodics **access token** (and optionally refresh token).
   - Using the Foodics API (with that token), fetch the **Foodics user/business info** (menu, branches, etc.).
   - Either:
     - **Create a Supabase auth user** for this Foodics user (e.g. by email from Foodics), then create or update a `merchants` row with `user_id = that auth user id`, and store the Foodics tokens in `foodics_connections` (or similar). Then **set the Supabase session** (e.g. with `supabase.auth.setSession`) so the rest of the app sees a normal logged-in user; or
     - If the Foodics user’s email already exists in `auth.users`, get that user, link the merchant, update `foodics_connections`, and set the session for that user.
4. Redirect to `/wizard` or `/dashboard`.

So after Foodics sign-in, “user info” is still **Supabase `user`** (from the session you set), and “merchant info” is the row in `merchants` linked to that `user.id`. The **extra** info (menu, branches) comes from the Foodics API and can be stored in your DB (e.g. `foodics_connections`, `branch_mappings`, `products`) and associated with `merchant_id`.

### 8.2 Option B: Foodics only (no Supabase Auth for that path)

If you don’t create a Supabase user for Foodics sign-in, then “user info” is whatever Foodics returns (e.g. business id, name, email). You’d store that and use it in your own session (e.g. encrypted cookie or JWT you issue). Then you’d still need a **merchant** row (created when they first connect Foodics) and a way to map “this Foodics business” → `merchants.id`. This is more custom and not how the rest of this doc is written; we assume Option A so that **all** logged-in users have a Supabase user and a merchant row.

---

## 9. Row Level Security (RLS) and “user info”

RLS policies run **in the database** and see **`auth.uid()`** = the current request’s user id (from the JWT). So when your app uses the **anon** client (with the user’s session), every query runs as that user.

Example policy so a user can only read/update their own merchant:

```sql
-- Merchants: user can only see/update their own row
alter table public.merchants enable row level security;

create policy "Users can read own merchant"
  on public.merchants for select
  using (auth.uid() = user_id);

create policy "Users can update own merchant"
  on public.merchants for update
  using (auth.uid() = user_id);
```

So even if you write:

```ts
const { data } = await supabase.from('merchants').select('*')
```

Supabase only returns rows where `user_id = auth.uid()`. So “get my merchant” is automatically scoped to the current user. You can still do `.eq('user_id', user.id)` for clarity, but RLS enforces it.

For **app_config**, **banners**, **promo_codes**, etc., you’ll have similar policies that restrict by `merchant_id` and ensure the current user’s merchant matches (e.g. “select where merchant_id in (select id from merchants where user_id = auth.uid())”).

---

## 10. Summary: where to get what

| What you need        | Where to get it |
|----------------------|------------------|
| “Is someone logged in?” | Client: `(await supabase.auth.getUser()).data.user`. Server: same with server client. Middleware: same. |
| Current user id      | `user.id` from `getUser()` (same as `auth.uid()` in RLS). |
| Current user email   | `user.email`. |
| Display name / metadata | `user.user_metadata` (e.g. `full_name`). |
| Current merchant row | Query `merchants` where `user_id = user.id` (one row per user). |
| Merchant id (for APIs, build webhook) | `merchant.id` from that row. |
| Full name / café name | `merchant.full_name`, `merchant.cafe_name`. |
| Merchant status      | `merchant.status` (`pending` \| `active` \| `suspended`). |

---

## 11. Checklist for nooksweb

- [ ] Use **`NEXT_PUBLIC_SUPABASE_URL`** and **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** for the Supabase client in both browser and server (same keys; server client reads session from cookies).
- [ ] **Browser client:** `createBrowserClient()` (or equivalent) in client components; call `getUser()` and/or `getSession()` and optionally load `merchants` by `user_id`.
- [ ] **Server client:** `createServerClient()` with cookie read/set so the same session is available in Server Components and API routes; call `getUser()` then load merchant by `user_id`.
- [ ] **Middleware:** Refresh session and redirect unauthenticated users away from `/dashboard`, `/wizard`, `/billing`; optionally redirect logged-in users away from `/signin`, `/signup`.
- [ ] **Trigger:** One row in `merchants` per new `auth.users` row (`user_id` = auth user id).
- [ ] **RLS:** Merchants (and other merchant-scoped tables) restricted by `auth.uid()` or by merchant id tied to `auth.uid()`.
- [ ] **Signup:** Pass `data: { full_name, cafe_name }` in `signUp` if you want the trigger to prefill the merchant.
- [ ] **Foodics:** In callback, create or link Supabase user and merchant, store Foodics tokens, set Supabase session so “user info” is consistent with the rest of the app.

This is the full picture of how nooksweb uses auth to get user info and the linked merchant record everywhere in the app.
