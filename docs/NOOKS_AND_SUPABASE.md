# Nooks Website (nooksweb) – Context for ALS_draft0

This doc describes the **Nooks** project (repo: **nooksweb**) and how it relates to ALS_draft0. ALS_draft0 had no prior context on Nooks; this is the full picture.

---

## What Nooks Is

A **Next.js dashboard for coffee shop owners** in Saudi Arabia. Merchants:

1. Sign up and verify email  
2. Complete a setup wizard (logo, colors)  
3. Subscribe via Moyasar (billing)  
4. Use a dashboard for operations, marketing, analytics, settings  
5. (When we have access) Connect Foodics POS and OTO delivery  

**ALS_draft0** is the **customer-facing app** (ordering, delivery, payments). **Nooks** is the **merchant-facing dashboard**.

---

## Tech Stack (Nooks)

- **Next.js 16** (App Router)  
- **Supabase** – auth, DB, storage  
- **Moyasar** – payments / billing  
- **Foodics** – OAuth “Connect Foodics” is implemented but disabled until Foodics provides Client ID/Secret (they asked for the product to be live first)  
- **OTO** – delivery: map branches to OTO warehouses, delivery options; uses `OTO_REFRESH_TOKEN` and related env vars  
- **Resend** – payment receipt emails after successful subscription  
- **Sentry** – error tracking (optional)  
- **Audit log** – DB table + logging for payment success, Foodics connect, branch updates  

---

## What’s in the Nooks Repo

- **Auth:** signup, verify email, login, forgot password / reset password (Supabase; reset link fixed via email template + redirect URLs)  
- **Onboarding:** verify-email → wizard (brand setup) → billing → payment → dashboard  
- **Billing:** single plan (Pilot), Moyasar form, success/failure UI, optional bypass when Foodics isn’t configured (`NEXT_PUBLIC_BILLING_SKIP_FOODICS_GATE`)  
- **“Connect Foodics”** – shows “Foodics integration coming soon” when `NEXT_PUBLIC_FOODICS_ENABLED` is not set  
- **Dashboard:** operations, marketing, analytics, settings (branches, Foodics status, OTO map)  
- **Legal:** Privacy and Terms pages; links from signup/login  
- **Rate limiting** on forgot-password and billing-verify APIs  
- **Logout** in sidebar  
- **“Manage subscription”** page (Moyasar dashboard + contact for cancel/change)  
- **Arabic/RTL support** (locale toggle in sidebar)  
- **Error boundaries** (root, dashboard, billing, wizard)  
- **Health check:** `GET /api/health` (returns 503 if required env missing)  
- **E2E:** Playwright tests; `npm run e2e`  

---

## Supabase / ALS_draft0 (Shared Project)

The Nooks app uses a **Supabase project that is shared with ALS_draft0** – the same Supabase project may be used by both.

### Nooks uses (do not break)

- **Tables:** `merchants`, `app_config`, `foodics_connections`, `branch_mappings`, `products`, `orders`, `audit_log`, `banners`, `promo_codes`, plus auth-related tables  
- **Auth** – signup, login, reset, verify  
- **Storage** – bucket `merchant-logos`  
- **Triggers** – e.g. create merchant on signup  

**When working on ALS_draft0:**

- Avoid changing these tables or triggers in a **breaking** way.  
- **Do not insert** into Nooks’ `orders` table directly; when Nooks exposes a POST order API we’ll use that (see `docs/NOOKSWEB_ANSWERS.md`).  
- We may **read** `promo_codes` for validation (read-only); don’t change schema or Nooks’ usage without agreeing.  
- If adding or changing Supabase tables/migrations in ALS_draft0, use **separate tables** or **coordinate** so Nooks is not affected.  
- Prefer new tables (e.g. ALS-specific) rather than altering Nooks’ schema.  

---

## Nooks Deployment and Config

- **Hosting:** Netlify (e.g. `https://cerulean-meringue-402196.netlify.app`)  
- **Supabase:** Site URL and Redirect URLs point to that Netlify URL (and localhost for dev). Reset Password and Verify Email templates use `{{ .ConfirmationURL }}`.  
- **Migrations:** Applied in order (see Nooks’ `GO_LIVE.md`), including `20260217100006_audit_log.sql`.  
- **Env:** Documented in Nooks’ `GO_LIVE.md` and `.env.local.example` (Supabase, Moyasar, Resend, Sentry, OTO, Foodics, etc.).  

---

## Current Status (Nooks)

The Nooks site is built and ready for production: env and Supabase URLs are set, Resend and Sentry are wired, password reset works. Remaining: ensure all production env vars are in Netlify (including Moyasar live keys when going live), then run a full signup → verify → wizard → billing → dashboard flow on the live URL. Planning to contact Foodics again now that the product is live to request OAuth credentials.

---

## Quick Reference for ALS_draft0

| Topic              | Note for ALS_draft0 |
|--------------------|----------------------|
| **Supabase**       | Same project as Nooks; don’t break Nooks tables/triggers. |
| **Moyasar**        | Shared concept; ALS_draft0 = customer payments, Nooks = merchant billing. |
| **Resend**         | Nooks uses for receipts; ALS_draft0 uses for OTP / auth emails. |
| **OTO**            | Both use OTO; Nooks maps branches/warehouses, ALS_draft0 requests delivery. |
| **Foodics**        | Nooks will “Connect Foodics”; ALS_draft0 uses Foodics for menu/orders. |

For more detail (e.g. Supabase schema, env vars, or how Nooks and ALS_draft0 share the project), refer to the nooksweb repo and its `GO_LIVE.md`, `docs/HOW_TO_GO_LIVE.md`, and `docs/STATUS_AND_NEXT.md`.

---

## ALS_draft0: Branch Mapping and Merchant Context

**Branch identity and OTO codes:** Branch IDs/names and OTO pickup codes are aligned with Nooks so both apps agree on branches. See **`docs/BRANCH_MAPPING_NOOKS.md`** for how Nooks branch identity maps to our `branchOtoConfig.ts` and OTO codes (e.g. `NOOKS-MADINAH-01`, `NOOKS-RIYADH-01`).

**Current merchant:** The app determines “which store the customer is using” via merchant context (env `EXPO_PUBLIC_MERCHANT_ID` or future URL/deep link). See **`docs/MERCHANT_CONTEXT.md`**. This is used for order attribution (`merchantId` on every order) and will be used for future nooksweb API calls and branding.

**Schema / auth changes:** If we add new Supabase tables or change auth usage in ALS_draft0, we will note it here (or in a short “ALS schema” section) so nooksweb doesn’t break our flows. We do not alter Nooks’ tables or triggers.

**Full nooksweb answers (branch schema, merchant id, orders API shape, branding fields, Supabase list):** **`docs/NOOKSWEB_ANSWERS.md`**

**Our answers to nooksweb’s questions (customer_id, order status, branch id, product id, promos, merchant choice, OTO, auth):** **`docs/ANSWERS_FOR_NOOKSWEB.md`**
