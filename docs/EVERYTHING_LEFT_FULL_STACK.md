# Everything left before you can start selling – simple & detailed (nooksweb + ALS_draft0)

This guide lists **every step** you need to complete before real merchants can sign up and pay for Nooks, and before the customer app (ALS_draft0) and build flow work end-to-end. Do them in order where it makes sense.

---

## Part A: Must-have (you can’t take real money without these)

### 1. Production Supabase project

**What:** A Supabase project used only for production (or your main project if you have one).

**How:**

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard).
2. Click **New project**. Pick a name (e.g. “Nooks Production”), a database password (save it), and a region close to your users.
3. Wait for the project to be ready.
4. Open **Project Settings** (gear icon) → **API**.
5. Copy and save:
   - **Project URL** → you’ll use this as `NEXT_PUBLIC_SUPABASE_URL` (nooksweb) and `EXPO_PUBLIC_SUPABASE_URL` (customer app) and `SUPABASE_URL` (ALS_draft0 server)
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (nooksweb) and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (customer app)
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (nooksweb and ALS_draft0 server only – keep secret; never in frontend or app)

**Link:** https://supabase.com/dashboard → your project → **Settings** → **API**

---

### 2. Run all database migrations in Supabase (nooksweb)

**What:** Create all tables (merchants, app_config, orders, banners, products, etc.) in your **production** Supabase project.

**How:**

1. In Supabase Dashboard, select your **production** project.
2. Go to **SQL Editor**.
3. Open each migration file below **in this order**, copy its full content, paste into the SQL Editor, and click **Run**:

| # | File name (nooksweb repo) |
|---|---------------------------|
| 1 | `supabase/migrations/20260217000001_create_merchants.sql` |
| 2 | `supabase/migrations/20260217000002_create_app_config.sql` |
| 3 | `supabase/migrations/20260217000003_storage_merchant_logos.sql` |
| 4 | `supabase/migrations/20260217100001_banners_bucket.sql` |
| 5 | `supabase/migrations/20260217100000_dashboard_tables.sql` |
| 6 | `supabase/migrations/20260217100003_trigger_create_merchant_on_signup.sql` |
| 7 | `supabase/migrations/20260217100004_foodics_subscription_tier.sql` |
| 8 | `supabase/migrations/20260217100005_app_config_delivery_mode.sql` |
| 9 | `supabase/migrations/20260217100006_audit_log.sql` |
| 10 | `supabase/migrations/20260219100000_orders_branch_delivery.sql` |
| 11 | `supabase/migrations/20260219110000_promo_codes_public_view.sql` |
| 12 | `supabase/migrations/20260220100000_banners_placement.sql` |

**Note:** Skip `20260217100002_dashboard_tables_only.sql` unless you need that variant.

4. **Storage bucket:** In Supabase go to **Storage**. If there is no bucket named **merchant-logos**, create one and set it to **Public**.

---

### 3. Run ALS_draft0 migrations in the same Supabase (if shared project)

**What:** ALS_draft0 uses tables like `profiles`, `email_otp`, `customer_orders`, `als_promo_codes`. Run these **after** the nooksweb migrations above.

**How:**

1. In the **same** Supabase project, **SQL Editor** → run each migration **in order** (from the **ALS_draft0** repo):
   - `supabase/migrations/20260217000000_create_profiles.sql`
   - `supabase/migrations/20260217100000_create_email_otp.sql`
   - `supabase/migrations/20260216000000_create_promo_codes.sql` (check for overlap with nooksweb promo table)
   - `supabase/migrations/20260218000000_create_customer_orders.sql`
   - `supabase/migrations/20260218000001_create_als_promo_codes.sql` (if separate from nooksweb)

**Note:** If nooksweb already created `profiles` or a promo table, skip or adapt the conflicting ALS_draft0 migration.

---

### 4. Supabase Auth URLs (redirects for login/signup/Foodics)

**What:** Tell Supabase your live site URL and where to send users after signup, reset password, and Foodics connect.

**How:**

1. In Supabase Dashboard → **Authentication** → **URL Configuration**.
2. Set **Site URL** to your real site, e.g. `https://nooks.app` or `https://your-site.netlify.app`.
3. Under **Redirect URLs**, add these **one by one** (replace with your real domain):
   - `https://your-domain.com/**`
   - `https://your-domain.com/verify-email`
   - `https://your-domain.com/reset-password`
   - `https://your-domain.com/api/auth/foodics/callback`
4. Click **Save**.

---

### 5. Moyasar live keys (real payments)

**What:** To accept real SAR, you need **live** keys from Moyasar (nooksweb and ALS_draft0 server use secret key; customer app needs publishable key).

**How:**

1. Go to [moyasar.com](https://moyasar.com) and log in.
2. Switch to **Live** mode (not Test).
3. Open **API Keys** (or Settings → API).
4. Copy the **Publishable key** (`pk_live_...`) and the **Secret key** (`sk_live_...`).
5. **Nooksweb** (e.g. Netlify): `NEXT_PUBLIC_MOYASAR_PUBLISHABLE_KEY`, `MOYASAR_SECRET_KEY`.
6. **ALS_draft0 server** (`server/.env` and deployed env): `MOYASAR_SECRET_KEY`.
7. **ALS_draft0 customer app** (root `.env` or EAS env): `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY=pk_live_...`

**Link:** https://moyasar.com/dashboard

---

### 6. Deploy nooksweb (e.g. Netlify) and set environment variables

**What:** Your nooksweb app must be deployed with all required env vars.

**How (Netlify):**

1. Push nooksweb code to a Git repo → in [Netlify](https://app.netlify.com): **Add new site** → **Import an existing project** → connect the repo.
2. Build: **Build command** `npm run build`, **Publish directory** as per Next.js/Netlify docs.
3. **Site settings** → **Environment variables**. Add:

| Variable | Value |
|----------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `NEXT_PUBLIC_MOYASAR_PUBLISHABLE_KEY` | Moyasar **live** publishable key |
| `MOYASAR_SECRET_KEY` | Moyasar **live** secret key |

4. **Redeploy** after saving variables.

**Optional:** `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `NEXT_PUBLIC_SENTRY_DSN`.

---

### 7. Deploy the ALS_draft0 API and set env vars

**What:** The ALS_draft0 **server** (Node/Express) must be deployed so nooksweb can call **POST /build** and the customer app can use auth, orders, payment, OTO.

**How:**

1. Deploy the `server/` folder (ALS_draft0 repo) to [Railway](https://railway.app), [Render](https://render.com), or [Fly.io](https://fly.io).
2. On the **deployed** host, set all required env vars (same names as in `server/.env`):
   - Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - Moyasar: `MOYASAR_SECRET_KEY`
   - Resend (OTP): `RESEND_API_KEY`, `OTP_FROM_EMAIL`
   - OTO (if used): `OTO_REFRESH_TOKEN`, `OTO_PICKUP_LOCATION_CODE`, etc.
   - Build webhook: `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BUILD_REF`, `BUILD_WEBHOOK_SECRET`, **`BUILD_WEBHOOK_BASE_URL`** = your deployed API base URL (e.g. `https://als-api.railway.app`).
3. After deploy, open **GET** `https://your-als-api-url/build` and confirm `configured: true` and `webhook_url` in the response.

---

### 8. Build webhook: give nooksweb the URL and secret

**What:** When a merchant pays, nooksweb must POST to your build service so Android + iOS apps are built.

**How:**

1. From **GET** `https://your-als-api-url/build` copy the **`webhook_url`** and your **`BUILD_WEBHOOK_SECRET`** (same as in ALS_draft0 server `.env`).
2. In **nooksweb** (e.g. Netlify env):
   - `BUILD_SERVICE_WEBHOOK_URL=https://your-als-api-url/build`
   - `BUILD_SERVICE_WEBHOOK_SECRET=the_secret_value`
3. Ensure nooksweb’s billing/verify route POSTs to that URL with `merchant_id`, `logo_url`, `primary_color`, `accent_color`, and header `x-nooks-secret`. See `docs/MESSAGE_FOR_NOOKS_AGENT_BUILD_WEBHOOK.md`.

---

### 9. EXPO_TOKEN in GitHub (for EAS builds)

**What:** The GitHub Actions workflow (triggered by POST /build) needs an Expo token to run EAS build.

**How:**

1. [expo.dev](https://expo.dev) → **Profile** → **Account settings** → **Access tokens** → **Create token** (e.g. “GitHub Actions”) → copy.
2. GitHub: repo **Nooks-tech/ALS_draft0** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** → Name: **EXPO_TOKEN**, Value: paste → **Add secret**.

**Links:** https://expo.dev/settings/access-tokens | https://github.com/Nooks-tech/ALS_draft0/settings/secrets/actions

---

### 10. Customer app env (Supabase + Nooks API + Moyasar publishable)

**What:** The ALS_draft0 **customer app** (Expo) needs Supabase (auth), Nooks API base URL (branding/operations), and Moyasar publishable key (payments).

**How:**

1. In ALS_draft0 **root** `.env` (or EAS env when building):
   - `EXPO_PUBLIC_SUPABASE_URL` = same as nooksweb Supabase URL
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` = same anon key (never service_role)
   - `EXPO_PUBLIC_NOOKS_API_BASE_URL` = nooksweb **public API base URL** once deployed (e.g. `https://api.nooks.sa`); leave unset until then
   - `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY` = Moyasar publishable key (`pk_live_...` in production)

---

### 11. Legal pages (Terms & Privacy)

**What:** Signup/login link to Terms and Privacy; you need real pages and, for real selling, real legal text.

**How:**

1. Nooksweb: you have `/terms` and `/privacy`. Before selling, have the text reviewed and updated (company name, contact, refund policy, data use).
2. Update content in those pages (or CMS if added later).

---

### 12. One full manual test (nooksweb → pay → build → customer app)

**What:** Prove signup → pay → build triggered → customer app works.

**How:**

1. Open your **live** nooksweb site. Sign up with a real email you control.
2. Complete the **wizard** (logo/colors) → **Save & Continue**.
3. On billing: connect Foodics if configured, or use `NEXT_PUBLIC_BILLING_SKIP_FOODICS_GATE=true` for testing. Click **Subscribe now** and pay with a **real card** (small amount).
4. You should land on the **dashboard**. In Supabase **Table Editor** → **merchants**, that user’s row should have `status = active`.
5. Check: nooksweb should POST to `BUILD_SERVICE_WEBHOOK_URL`; ALS_draft0 server logs “Triggered workflow for merchant: …”; GitHub **Actions** for **Nooks-tech/ALS_draft0** shows “Nooks-triggered build” run.
6. In the **customer app**: set `EXPO_PUBLIC_MERCHANT_ID` to that merchant’s ID (or deep link), sign in with a test customer, confirm menu, cart, checkout, and an order.

If any step fails, fix env vars, redirect URLs, or keys before telling customers they can buy.

---

## Part B: Strongly recommended

### 13. Payment receipt emails (Resend) – nooksweb

**What:** After payment, the merchant gets an email receipt.

**How:** [resend.com](https://resend.com) → API key. In nooksweb (Netlify): `RESEND_API_KEY`, `RESEND_FROM_EMAIL`. App sends receipt when these are set.

---

### 14. Error tracking (Sentry) – nooksweb

**What:** See production errors in Sentry.

**How:** [sentry.io](https://sentry.io) → create project → copy DSN. In nooksweb: `NEXT_PUBLIC_SENTRY_DSN=...`. Same idea for ALS_draft0 server/app if you add Sentry there.

---

### 15. E2E tests – nooksweb

**What:** Automated tests for signup, login, forgot password, terms, privacy, health.

**How:** `npm install` then `npx playwright install chromium`, run `npm run e2e`. For production: `PLAYWRIGHT_BASE_URL=https://your-domain.com` then run e2e again.

---

### 16. Mapbox token – customer app

**What:** If the customer app uses Mapbox for address search, it needs a token.

**How:** [account.mapbox.com](https://account.mapbox.com/access-tokens/) → Access tokens → Default public or new public token (styles:tiles, geocoding). In ALS_draft0 app: `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN=pk.eyJ...`

---

### 17. Payment redirect URL – ALS_draft0 server

**What:** After payment (e.g. Apple Pay), user is redirected. Server uses `PAYMENT_REDIRECT_BASE_URL`.

**How:** In ALS_draft0 server `.env` (and deployed): `PAYMENT_REDIRECT_BASE_URL=https://your-als-api-url-or-app-link.com`

---

### 18. Resend / OTP – ALS_draft0 server

**What:** ALS_draft0 server sends OTP emails for customer login.

**How:** [resend.com](https://resend.com) → API key. In `server/.env` and deployed: `RESEND_API_KEY`, `OTP_FROM_EMAIL`.

---

## Part C: When you want full product

### 19. Foodics partnership (menu + branches from POS)

**What:** Merchants “Connect Foodics”; you get menu and branches via OAuth.

**How:** Contact Foodics for API/OAuth access. They give **Client ID**, **Client Secret**; you register redirect URI `https://your-domain.com/api/auth/foodics/callback`. In nooksweb: `FOODICS_CLIENT_ID`, `FOODICS_CLIENT_SECRET`, `NEXT_PUBLIC_FOODICS_ENABLED=true`. ALS_draft0 can use Foodics for menu when API is available (see `server/services/foodics.ts`). Until then, set `NEXT_PUBLIC_BILLING_SKIP_FOODICS_GATE=true` to allow payment without Foodics.

---

### 20. OTO delivery (branch mapping)

**What:** If you use OTO for delivery, you need a token and branch mapping.

**How:** Get **OTO refresh token** from [app.tryoto.com](https://app.tryoto.com) (or OTO partner process). In nooksweb: `OTO_REFRESH_TOKEN`. In ALS_draft0 server (already used): `OTO_REFRESH_TOKEN`, `OTO_PICKUP_LOCATION_CODE`, etc., in deployed env.

---

### 21. Operations API (nooksweb → customer app)

**What:** Customer app shows store status, prep time, delivery mode from nooksweb.

**How:** In nooksweb, implement **GET** `{API_BASE}/api/public/merchants/:merchantId/operations` returning `store_status`, `prep_time_minutes`, `delivery_mode`. See `docs/MESSAGE_FROM_NOOKS_AND_ALS_RESPONSE.md`. Customer app already polls this when `EXPO_PUBLIC_NOOKS_API_BASE_URL` is set.

---

### 22. Push notifications (Marketing Studio + customer app)

**What:** Merchants send push notifications from Marketing Studio; customer app receives order status when in background.

**How:** Set up FCM/APNs and Expo Push; store push tokens in the app; from nooksweb or your backend send via Expo push API or FCM. ALS_draft0 app already shows **local** notifications on order status change (Supabase Realtime); add Expo Push for when app is closed.

---

## Part D: Optional / later

- **Foodics webhook:** Wire `POST /api/webhooks/foodics` when Foodics sends order/status webhooks.
- **Custom domain:** Netlify + nooksweb domain (e.g. `nooks.app`); update Supabase redirect URLs and emails. Optional: custom domain for ALS_draft0 API (e.g. `https://api.nooks.sa`).
- **Rate limiting / CORS** on ALS_draft0 API in production.
- **Separate Supabase project** for ALS_draft0 if you prefer not to share with nooksweb.

---

## Quick checklist (copy and tick)

**Part A – Must-have**

- [ ] 1. Production Supabase project created; URL, anon key, service_role key saved
- [ ] 2. All 12 nooksweb migrations run in production Supabase (in order)
- [ ] 3. ALS_draft0 migrations run (profiles, email_otp, customer_orders, etc.) if shared project
- [ ] 4. Storage bucket `merchant-logos` exists and is Public
- [ ] 5. Supabase Auth: Site URL and Redirect URLs set for your live domain
- [ ] 6. Moyasar **live** keys obtained; set in nooksweb, ALS_draft0 server, and customer app (publishable)
- [ ] 7. Nooksweb deployed (e.g. Netlify) with all required env vars
- [ ] 8. ALS_draft0 API deployed; `BUILD_WEBHOOK_BASE_URL` and other server env vars set
- [ ] 9. Build webhook: nooksweb has `BUILD_SERVICE_WEBHOOK_URL` and `BUILD_SERVICE_WEBHOOK_SECRET` (from GET /build)
- [ ] 10. EXPO_TOKEN added in GitHub repo **Nooks-tech/ALS_draft0**
- [ ] 11. Customer app has `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_NOOKS_API_BASE_URL` (when nooksweb API is live), `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY`
- [ ] 12. Terms & Privacy reviewed and updated
- [ ] 13. One full test: nooksweb signup → wizard → pay (real card) → dashboard → build triggered → customer app works

**Part B – Recommended**

- [ ] 14. Resend + Sentry + E2E for nooksweb; Mapbox + payment redirect + Resend/OTP for ALS_draft0

**Part C – When ready**

- [ ] 15. Foodics OAuth and API; OTO token; Operations API; Push notifications

When all of Part A is done and one full payment works end-to-end with build triggered and customer app working, you can start selling.
