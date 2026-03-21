# Nooksweb: 30-day session + landing CTA + unified “Appearance” settings

**Audience:** Implement this in the **nooksweb** Next.js repo (not ALS_draft0). This repo does not contain nooksweb source; copy this doc into a nooksweb chat or open nooksweb in Cursor and follow it.

---

## 1. Stay signed in (~1 month) + landing page shows Dashboard

### Why login feels lost today

- Cookies may be **session-only** (cleared when the browser closes) if `maxAge` is not set.
- Or the Supabase browser client is created without **persistent** cookie options on the server (`@supabase/ssr`).

### What to do

1. **Centralize cookie options** for `createServerClient` / `createBrowserClient` (match your existing pattern):

   - Set **`maxAge`** to **30 days** in seconds: `60 * 60 * 24 * 30`.
   - Keep **`path: '/'`**, **`sameSite: 'lax'`** (or `'none'` + `Secure` if cross-site; usually `'lax'` is enough for same-site).
   - Use **`httpOnly: true`** where the SSR helper allows it (Supabase SSR sets cookies via the cookie adapter you pass).

2. **Middleware** (`middleware.ts`):

   - Continue calling **`getUser()`** (or the recommended refresh path from Supabase SSR docs) so the refresh token rotates and the session stays valid.
   - Ensure matcher includes routes that need auth **and** the **landing page** if you read session there.

3. **Supabase project (dashboard)**

   - **JWT expiry** (access token) is often 1h; that’s fine. Long “stay logged in” relies on the **refresh token** + **persistent cookies**.
   - If there is a **refresh token reuse / rotation** policy, keep defaults unless you see forced logout.

4. **Landing page** (`app/page.tsx` or your marketing route):

   - **Server component:** `createServerClient` → `getUser()`.
   - **If `user`:** render primary CTA **“Dashboard”** → `href="/dashboard"` (or your app home).
   - **Else:** render **“Sign in”** → `/login` (or existing auth route).
   - Optional: smaller **“Home”** or marketing links unchanged so merchants can still read the landing content.

5. **QA**

   - Sign in → close browser completely → reopen site → should still be logged in (within 30 days).
   - Open landing `/` while logged in → **Dashboard** visible, not **Sign in**.

---

## 2. One Settings page: app icon + wizard (brand) + phone simulator

### Goal

Single route, e.g. **`/dashboard/settings/appearance`** (or **`/dashboard/settings/branding`**), with **three sections** on one scrollable page:

| Section | Reuse |
|--------|--------|
| **App icon** | Existing upload/preview + save to `app_config` / storage (same as current **app icon** flow). |
| **Wizard / brand** | Existing **BrandSetup** (colors, name, tab color, etc.) — embed the same component used on the wizard route, don’t duplicate business logic. |
| **Phone simulator** | Existing **PhoneSimulator** (or equivalent preview) — embed next to or below brand controls so merchants see live preview. |

### Implementation steps

1. **Add nav entry** under **Settings** (sidebar): **“Appearance”** or **“App & branding”** → new route.

2. **Page layout** (`page.tsx`):

   - Client or server wrapper as needed; often the brand + simulator are client components.
   - Structure:

     ```txt
     <h1>Appearance</h1>
     <section>App icon …</section>
     <section>Brand & wizard … (BrandSetup)</section>
     <section>Preview … (PhoneSimulator)</section>
     ```

   - Share **one source of truth** for branding state (React context or lifted state) so **BrandSetup** updates reflect in **PhoneSimulator** without a full page reload.

3. **Save behavior**

   - Reuse the **same API routes / actions** already used by:
     - App icon page (`app-config` / upload URL / build trigger if applicable).
     - Wizard / BrandSetup save.
   - Avoid new duplicate endpoints unless necessary; if you add one, it should call the same server helpers as the existing saves.

4. **Redirects / old routes**

   - Optional: keep **`/dashboard/app-icon`** and **`/dashboard/wizard`** as **redirects** to the unified page (or tabs with hash `#app-icon`) so bookmarks don’t break.

5. **QA**

   - Change icon → save → refresh → icon still there; build pipeline if you trigger builds on icon change.
   - Change brand colors → simulator updates immediately.
   - No regression on public **`/api/public/.../branding`** for the merchant slug.

---

## 3. Files to touch in nooksweb (typical)

- `lib/supabase/server.ts` / `client.ts` — cookie `maxAge` + options.
- `middleware.ts` — session refresh.
- `app/page.tsx` (or landing layout) — `getUser()` → Dashboard vs Sign in.
- `app/dashboard/settings/appearance/page.tsx` — new unified page.
- Sidebar / settings menu component — link to Appearance.
- Possibly small refactors: export **BrandSetup** and **PhoneSimulator** from shared modules if they’re currently page-private.

---

## 4. Security note

Longer-lived cookies increase convenience; keep **HTTPS** in production, **httpOnly** cookies for tokens, and follow Supabase SSR guidance for **CSRF** / same-site cookie usage.

---

*End of implementation guide.*
