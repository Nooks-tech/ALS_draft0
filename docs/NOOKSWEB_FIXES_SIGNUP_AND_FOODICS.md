# Nooksweb fixes: Sign in with Foodics + "Failed to fetch" on signup

Use this in the **nooksweb** repo. Two issues and how to fix them.

---

## Issue 1: "Sign in with Foodics" goes to regular sign-in page

**Goal:** When the user clicks "Sign in with Foodics", they must be **redirected to Foodics’ website** (OAuth) so you can get their menu, branches, and info. They should **not** go to your own sign-in page.

### What to do

1. **"Sign in with Foodics" must start the OAuth flow**
   - Build the Foodics authorization URL and send the user there (full-page redirect).
   - Foodics OAuth base: `https://console.foodics.com` (or the URL Foodics gives you in their developer docs).
   - You need: `client_id`, `redirect_uri`, `scope`, and optionally `state` (for CSRF).

2. **Typical OAuth URL shape**
   ```
   https://console.foodics.com/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_CALLBACK_URL&response_type=code&scope=general.read
   ```
   Replace:
   - `YOUR_CLIENT_ID` → from Foodics (env: `NEXT_PUBLIC_FOODICS_CLIENT_ID` or `FOODICS_CLIENT_ID`).
   - `YOUR_CALLBACK_URL` → your callback, e.g. `https://your-domain.com/api/auth/foodics/callback` (must be **exact** as registered in Foodics).
   - `scope` → whatever Foodics requires (e.g. `general.read` for basic access; check Foodics API docs).

3. **In nooksweb**

   - **Signup page:** The "Sign in with Foodics" button should **not** link to `/signin` or call `router.push('/signin')`. It should either:
     - Link to an API route that redirects to Foodics, e.g. `<a href="/api/auth/foodics">Sign in with Foodics</a>`, or
     - Call a function that builds the Foodics auth URL and does `window.location.href = foodicsAuthUrl`.
   - **API route** (e.g. `app/api/auth/foodics/route.ts` or `pages/api/auth/foodics.ts`):
     - Read `FOODICS_CLIENT_ID` (or `NEXT_PUBLIC_FOODICS_CLIENT_ID`) and your callback URL (e.g. `origin + '/api/auth/foodics/callback'`).
     - Build the authorization URL with `client_id`, `redirect_uri`, `response_type=code`, `scope`, and optionally `state` (random string stored in cookie/session).
     - Respond with `NextResponse.redirect(authUrl)` (or 302 redirect) so the user lands on Foodics.
   - **Callback route** (e.g. `app/api/auth/foodics/callback/route.ts`):
     - Foodics redirects back with `?code=...&state=...`.
     - Exchange `code` for access token (and optionally refresh token) via Foodics token endpoint.
     - Store the token (e.g. in DB for the merchant, or in session).
     - Fetch menu/branches with the token if the API supports it; create/link the merchant and then redirect to the wizard (e.g. `redirect('/wizard')`).

4. **If you don’t have Foodics Client ID yet**
   - Contact Foodics for API/OAuth access; they provide Client ID and Client Secret and let you register the redirect URI.
   - Until then, you can show "Sign in with Foodics – coming soon" and only offer email signup, or keep the button but have it open Foodics docs/contact.

**Summary:** "Sign in with Foodics" → redirect to Foodics OAuth URL → user authorizes → callback → exchange code for token → fetch menu/branches → redirect to wizard. No redirect to your regular sign-in page for this path.

---

## Issue 2: "Failed to fetch" when calling `supabase.auth.signUp()`

**Error:** `TypeError: Failed to fetch` at `supabase.auth.signUp({ ... })` in `app/signup/page.tsx`.

This is a **network/request** failure: the browser never got a valid response from Supabase (or couldn’t reach it).

### Checklist

1. **Supabase URL and anon key (client-side)**
   - In nooksweb you must use the **public** (anon) key for browser code, and the URL must be exact.
   - Env vars used in the **browser** must be prefixed with `NEXT_PUBLIC_` so Next.js inlines them:
     - `NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...`
   - If you use `SUPABASE_URL` / `SUPABASE_ANON_KEY` without `NEXT_PUBLIC_` in client components, they are `undefined` in the browser and the client will call the wrong URL or fail.

2. **Correct Supabase client in the signup page**
   - Create the client with the **public** URL and anon key, e.g.:
     ```ts
     import { createClient } from '@supabase/supabase-js'
     const supabase = createClient(
       process.env.NEXT_PUBLIC_SUPABASE_URL!,
       process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
     )
     ```
   - If you’re reading from `process.env.SUPABASE_URL` in a Client Component, that will be undefined; use `NEXT_PUBLIC_SUPABASE_URL`.

3. **Supabase project status**
   - In Supabase Dashboard, confirm the project is **not paused** (free tier projects pause after inactivity). If it’s paused, resume it.

4. **Redirect URLs**
   - In Supabase → Authentication → URL Configuration, add your app URL (e.g. `http://localhost:3000` for dev and `https://your-domain.com` for prod). If the redirect you pass in `emailRedirectTo` is not allowed, Supabase can reject the request.

5. **CORS / network**
   - Supabase allows browser origins by default. If you’re on a custom domain or port, ensure it’s allowed in Supabase (usually automatic for the project URL).
   - Try in an incognito window or with extensions disabled (ad blockers can block fetch).
   - Check DevTools → Network: does the request to `https://xxxx.supabase.co/auth/v1/signup` appear? What status (0, 4xx, 5xx)? If it’s blocked or CORS, you’ll see "Failed to fetch".

6. **Local env**
   - Restart the Next.js dev server after changing `.env.local` so the new values are picked up.

### Minimal fix to try first

- In nooksweb `.env.local` (or Netlify env for prod), set:
  - `NEXT_PUBLIC_SUPABASE_URL=<your-project-url>`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>`
- In the file that creates the Supabase client for the signup page, use **only** these two variables (with `NEXT_PUBLIC_`).
- Restart dev server and try signup again. If it still fails, check Network tab and Supabase project status.

---

## Quick reference

| Issue | Fix |
|-------|-----|
| Sign in with Foodics → goes to sign-in page | Make "Sign in with Foodics" redirect to Foodics OAuth URL (via API route or client-side redirect). Implement callback route to exchange code, store token, then redirect to wizard. |
| Failed to fetch on signUp | Use `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in client; ensure project not paused; allow redirect URLs in Supabase; restart dev server after env changes. |
