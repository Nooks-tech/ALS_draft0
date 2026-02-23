# The Complete Nooksweb Project Prompt – From First Line to Publishing

**Use this entire document as the single, exhaustive prompt for the nooksweb project.**  
If the nooksweb website was reverted and chat history was lost, paste this (or link to it) into the nooksweb Cursor agent or give it to the developer so they can rebuild and ship the project from scratch. This is the most detailed and longest project brief we have: it explains what Nooks is, how it fits with the customer app (ALS_draft0), every screen and flow, every API you must expose, every migration, env var, and step from first line of code to publishing.

---

## 0. Who You Are and What You’re Building

You are working on **nooksweb** (the Nooks merchant website and dashboard). Nooks is a **SaaS for coffee shop owners in Saudi Arabia**. Merchants sign up on your website, complete a customization wizard (logo + colors), pay for a subscription, and then use a **dashboard** to run their business (operations, marketing, analytics, settings). When they pay, **you** call an external **build service** (ALS_draft0 server), which triggers **Android and iOS app builds** so that merchant gets their own white‑labeled **customer app** (ALS_draft0) where their customers order, pay, and track delivery.

So there are two products:

- **nooksweb** – The website and dashboard: landing page, signup, wizard, payment, and dashboard (operations, marketing, analytics, settings, help). This is what **you** are building.
- **ALS_draft0** – The customer-facing ordering app (Expo/React Native) and its API (Node server). You do **not** build ALS_draft0; you only **call** its build webhook after payment and **expose** public APIs that the customer app consumes (branding, banners, promos, operations, branches).

Your job: implement nooksweb from first line of code to publishing, so that a merchant can discover Nooks, sign up, complete the wizard, pay, get their app built, and use the dashboard. All of that depends on your code, your Supabase, your deployment, and the APIs you expose.

---

## 1. Project Identity and Value Proposition

- **Product name:** Nooks (or Nooks for Coffee Shops).
- **Users:** Coffee shop / café owners (merchants) in Saudi Arabia.
- **Value proposition (must be clear on the first page):**
  - We build **custom ordering apps** that integrate with **their Foodics POS** – they don’t need to change how they run their till.
  - They **don’t need a delivery fleet** – we handle delivery (via OTO/Mrsool-style partners) and in-store pickup.
- **Flow:** Merchant hears about Nooks → visits your website → sees what we can do (first page is critical) → clicks “Get started” → signup → wizard (icon + colors) → payment → dashboard. After payment, two app builds (Android + iOS) are triggered automatically with their branding.

**No real Foodics data yet** – Foodics OAuth/API may not be live; you can stub “Connect Foodics” and use a bypass flag for payment (see later). The customer app (ALS_draft0) uses mock menu/branches when Foodics isn’t configured.

---

## 2. Tech Stack (nooksweb)

- **Framework:** Next.js (App Router), current major version (e.g. Next.js 14/15).
- **Auth & DB:** Supabase – Auth (signup, login, forgot/reset password, email verification), database (PostgreSQL), Storage (merchant logos).
- **Payments:** Moyasar – subscription/billing (one plan; live keys for production).
- **Emails:** Resend – payment receipt after successful subscription; optional for transactional.
- **Monitoring:** Sentry (optional) – error tracking.
- **Hosting:** Netlify (or similar) – deploy the Next.js app; set env vars in the host.
- **Foodics:** OAuth “Connect Foodics” – implement the flow but can be disabled until Foodics provides Client ID/Secret (they may ask for a live product first). When enabled, after connect we get menu and branch locations.
- **OTO:** Delivery partner – dashboard may show branch verification and OTO warehouse mapping; env vars for OTO when you integrate.
- **E2E:** Playwright – tests for signup, login, forgot password, terms, privacy, health.

You will need: **Supabase project** (production), **Moyasar** (live keys for real SAR), **Resend** (API key + from email), **Netlify** (or host) with env vars, and **two env vars for the build service**: `BUILD_SERVICE_WEBHOOK_URL` and `BUILD_SERVICE_WEBHOOK_SECRET` (see Section 7).

---

## 3. The Ultimate User Flow (Implement Exactly This)

### 3.1 First Page (Landing)

- **Purpose:** First impression. Show what Nooks can do; reassure that we integrate with Foodics POS and that the merchant doesn’t need to worry about a delivery fleet.
- **UI inspiration:** Borrow design and UX ideas from:
  - **https://lightweight.info/en**
  - **https://reactbit.com**
  Be creative and modern; this page sells the product.
- **Critical requirement – Customization wizard on the first page:**  
  The **wizard must be on the first page** so the user can **play with it** before signing up. Let them:
  - Choose an **icon/logo** (upload or pick).
  - Set **colors** (e.g. primary, accent).
  - See a **preview** that closely matches the **customer app** layout.
- **Wizard must model the app’s 4 tabs:**  
  1. **Menu**  
  2. **Offers**  
  3. **Orders**  
  4. **More**  
  (The nooksweb agent was given reference images of all tabs; the wizard preview should closely resemble the app so the merchant sees what their app will look like.)
- **CTA:** A clear “Get started” (or equivalent) button that navigates to the **signup page**.

So: first page = value prop (Foodics + no fleet) + **interactive wizard on the same page** (icon + colors + 4-tab preview) + “Get started” → signup.

### 3.2 Signup Page

- **Options:**
  - Sign up **with email** (email + password, then verify email).
  - **Sign in with Foodics** (OAuth when Foodics is enabled).
- **Mandatory message (warning):**  
  Display a clear message: **“To access our services you need a Foodics account.”**  
  (Even if they sign up with email first, they must connect Foodics before they can pay; see Payment page.)
- **After signup with email:** Normal flow (e.g. verify email → then send them to wizard or dashboard depending on your flow).
- **After sign in with Foodics:** Skip any extra “connect” step and navigate **directly to the wizard page** (they’ve already connected).

### 3.3 Wizard Page (After Signup or After Foodics Sign-in)

- **Purpose:** Merchant sets their app branding: icon and colors. This is the same conceptually as the wizard on the landing page but now **saved** to their account.
- **Content:**
  - **4 tabs** (same as app): 1–Menu, 2–Offers, 3–Orders, 4–More. Use these tabs so the wizard UI mirrors the app (reference images of the app tabs should be used to match layout/feel).
  - **Icon:** Upload or choose an icon/logo (stored in Supabase Storage, e.g. `merchant-logos` bucket).
  - **Colors:** Let them set at least primary color (and optionally accent). Store in `app_config` (or your branding table).
- **Action:** “Save & continue” (or “Save and continue”) → navigate to the **payment page**.

### 3.4 Payment Page

- **Plans:** **One plan only** (e.g. “Pilot” or “Starter”).
- **Rule – Do not allow payment until Foodics is connected:**  
  The user **must** have connected their Foodics account before they can pay. If they haven’t:
  - Show a **warning message:** “You must have a Foodics account to access our services.” (or equivalent).
  - **Block** the pay button (or subscription action) until they have signed in with Foodics / connected Foodics.
- **If they already signed in with Foodics** (earlier in the flow): Do **not** show the warning; let them pay normally.
- **After Foodics connection:** You can get their menu and branch locations (when Foodics APIs are available); for now this can be stubbed.
- **After successful payment:**
  1. **Call the build webhook** (see Section 7): POST to `BUILD_SERVICE_WEBHOOK_URL` with `merchant_id`, `logo_url`, `primary_color`, `accent_color` (and header `x-nooks-secret`). The build service will trigger **one Android and one iOS** build with that merchant’s branding.
  2. **Then** navigate the user to the **dashboard** (e.g. first time → Dashboard home).

**Testing without Foodics:** If Foodics isn’t configured yet, set an env var such as `NEXT_PUBLIC_BILLING_SKIP_FOODICS_GATE=true` so you can still test payment; in production you remove or set this to false.

### 3.5 Dashboard (After Payment)

The dashboard is the main area for logged-in merchants. It has **6 main sections/pages**:

1. **Dashboard (Home)**  
   - Today’s app sales (from app orders).  
   - Number of active orders.  
   - Latest orders (list or table).

2. **Live Operations**  
   - **Store status:** 1–Open, 2–Busy, 3–Closed. Let the merchant set this.  
   - **Prep time (slider):** How many minutes the store is “busy” (e.g. prep time in minutes).  
   - **Delivery mode (fail-safe):** If OTO returns “No Drivers”, switch to **Pickup only** so customers can still order.  
   - **Turn off delivery at will:** The merchant must be able to **turn off delivery** and use **pickup only** for a while. This setting must be **in sync with the customer app** (the app hides delivery when you set “pickup only”).  
   - **Menu availability:** Show/hide items in the app **without** changing the POS (e.g. hide out-of-stock items in the app only).

3. **Marketing Studio**  
   - **Banners:** Upload images and assign **deep links** to Foodics categories or products. Two use cases:
     - **Horizontal promotional slider** below the header in the app.
     - **Popup promotional images** when the customer opens the app (user can close).
   - **Push notifications:** Let the merchant send push notifications to their customers (you’ll need FCM/APNs and Expo Push or similar when you implement; for now the UI and “send” action can be stubbed or wired later).
   - **Promo engine:** Create promo codes (name, amount/discount, expiration date). Codes are **validated before orders are pushed to Foodics** (validation can happen in your API or in the customer app against your API).

4. **Analytics**  
   - **App performance:** Sales from app orders (e.g. last 14 days).  
   - **Customer leaderboard:** Top spenders; ability to send targeted discounts to VIPs.

5. **Settings**  
   - **Branch verification and POS integration.**  
   - **App & API (testing):**  
     - Show **Merchant ID** (e.g. UUID from `merchants.id`) – used for the customer app and to test the branding API.  
     - Show **Branding API URL** (e.g. `https://your-api-base/api/public/merchants/{merchantId}/branding`).  
   - **POS integration:**  
     - Foodics connection status and menu sync.  
     - If not connected: “Not connected” and “Connect Foodics – coming soon” (or real Connect button when Foodics is enabled).  
     - Copy: “Foodics integration will be available once we complete setup with Foodics.”  
   - **Branch verification:**  
     - Confirm map coordinates and manager phone for OTO delivery.  
     - If no branches: “No branches. Sync from Foodics first.”

6. **Help**  
   - Support/help content, links, or contact.

**Sync with the customer app:**  
- Store status (open/busy/closed), prep time, and **delivery mode** (delivery_and_pickup vs pickup_only) must be readable by the customer app. Implement **GET** `{API_BASE}/api/public/merchants/{merchantId}/operations` returning `store_status`, `prep_time_minutes`, `delivery_mode`. The customer app polls this (or you can use Supabase Realtime on `app_config` later). When the merchant turns off delivery in the dashboard, the app must see `delivery_mode: "pickup_only"` and hide the delivery option.

---

## 4. Public APIs Nooksweb MUST Expose (For the Customer App)

The customer app (ALS_draft0) calls **your** public API when `EXPO_PUBLIC_NOOKS_API_BASE_URL` is set to your deployed API base. You must implement these endpoints (on nooksweb or a separate API service that you deploy):

### 4.1 Branding

- **Endpoint:** `GET {API_BASE}/api/public/merchants/{merchantId}/branding`
- **Response (JSON):**
  - `logo_url` (string | null) – URL of the merchant’s logo (from wizard/Settings). Can be null.
  - `primary_color` (string) – e.g. `"#0f766e"`. Used for header, nav, buttons, prices.
  - `accent_color` (string) – e.g. same as primary; kept for compatibility.
  - `background_color` (string) – e.g. `"#f5f5f4"`. Used for screen/card backgrounds in the app.

Source: your `app_config` (or equivalent) per merchant. If you add `background_color` to the DB, run a migration (e.g. `20260222000000_app_config_background_color.sql`).

### 4.2 Banners

- **Endpoint:** `GET {API_BASE}/api/public/merchants/{merchantId}/banners`
- **Response:** Array of banner objects, e.g.:
  - `id`, `image_url`, `title`, `subtitle`, `placement` (e.g. `"slider"` | `"popup"` | `"offers"`), optional `deep_link` (Foodics category/product).
- **Usage in app:**  
  - `placement === "slider"` (or no placement) → horizontal strip below the header.  
  - `placement === "popup"` → on-open popup (one per session, user can close).

### 4.3 Promos

- **Endpoint:** `GET {API_BASE}/api/public/merchants/{merchantId}/promos`
- **Response:** Array of promo objects: `id`, `code`, `name` (display name; may equal code), `type`, `value`, `valid_from`, `valid_until`, `description`, etc.
- **Usage in app:** Offers tab and checkout; validate before orders go to Foodics.

### 4.4 Operations

- **Endpoint:** `GET {API_BASE}/api/public/merchants/{merchantId}/operations`
- **Response (JSON):**
  - `store_status` (string): `"open"` | `"busy"` | `"closed"`
  - `prep_time_minutes` (number)
  - `delivery_mode` (string): `"delivery_and_pickup"` | `"pickup_only"`
- **Usage in app:** App polls this (or Realtime); when `delivery_mode === "pickup_only"` it hides delivery. When `store_status === "closed"` it can show “Store closed” and disable ordering.

### 4.5 Branches (When You Have Data)

- **Endpoint:** `GET {API_BASE}/api/public/merchants/{merchantId}/branches`
- **Response:** Array of branches: `id` (e.g. `branch_mappings.id`), `name`, `latitude`, `longitude`, `oto_warehouse_id`, etc. (no sensitive data like `manager_phone` in public API.)

You can add this when you have branch data (e.g. from Foodics sync). The customer app uses it for branch list and delivery.

---

## 5. Build Webhook – What You Must Do After Payment

When a merchant **completes payment** (subscription success), nooksweb must **POST** to the ALS_draft0 build service so that Android and iOS apps are built with that merchant’s branding.

### 5.1 Your Env Vars

- **`BUILD_SERVICE_WEBHOOK_URL`** – Full URL, e.g. `https://als-api.railway.app/build` (the ALS_draft0 server will tell you the exact URL; they deploy their API and expose **GET** `https://their-api/build` which returns `webhook_url`).
- **`BUILD_SERVICE_WEBHOOK_SECRET`** – A shared secret. You must send this in **every POST** in the header **`x-nooks-secret`**. If the secret is wrong or missing, the build service returns **401 Unauthorized**.

Example secret (confirm with ALS_draft0 team):  
`4d1eb3621b41930d0fc512f1ab2ff0498a0de5030019c682892f10eb28033af1`

### 5.2 Request You Must Send

- **Method:** POST  
- **URL:** `BUILD_SERVICE_WEBHOOK_URL`  
- **Headers:**
  - `Content-Type: application/json`
  - `x-nooks-secret: <value of BUILD_SERVICE_WEBHOOK_SECRET>`
- **Body (JSON):**
  - `merchant_id` (required, string) – e.g. `merchants.id` (UUID)
  - `logo_url` (optional, string) – from your Storage or app_config
  - `primary_color` (optional, string) – e.g. `"#0D9488"`
  - `accent_color` (optional, string)
  - `platforms` (optional) – e.g. `["android", "ios"]`; build service may ignore and always build both.

Example body:

```json
{
  "merchant_id": "3d24a026-ee4f-4a51-84ed-2a97270b5c53",
  "logo_url": "https://your-supabase-storage/merchant-logos/xxx.png",
  "primary_color": "#0D9488",
  "accent_color": "#0D9488"
}
```

### 5.3 When to Call

- **Exactly once** after **successful** subscription payment (e.g. in your Moyasar webhook or success handler).
- Then redirect the user to the **dashboard**. Do not wait for the build to finish; the build runs asynchronously.

---

## 6. Supabase – Migrations, Auth, and Tables

### 6.1 Production Supabase Project

- Create a **production** Supabase project (or use the main one).
- Save: **Project URL**, **anon (public) key**, **service_role key** (never in frontend; only server/API).

### 6.2 Migrations to Run (In Order)

Run these in the **SQL Editor** of your Supabase project, **in this order**:

| # | Migration file (nooksweb repo) |
|---|-------------------------------|
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

If you add **background_color** for branding: create and run e.g. `20260222000000_app_config_background_color.sql`.

**Storage:** Ensure a **public** bucket **`merchant-logos`** exists for uploaded logos.

### 6.3 Auth URLs (Supabase Dashboard)

- **Authentication** → **URL Configuration**
- **Site URL:** Your live site (e.g. `https://nooks.app` or `https://your-site.netlify.app`)
- **Redirect URLs:** Add (replace with your domain):
  - `https://your-domain.com/**`
  - `https://your-domain.com/verify-email`
  - `https://your-domain.com/reset-password`
  - `https://your-domain.com/api/auth/foodics/callback`

### 6.4 Tables You Own (Do Not Let ALS_draft0 Break These)

- `merchants`, `app_config`, `foodics_connections`, `branch_mappings`, `products`, `orders`, `audit_log`, `banners`, `promo_codes`, Storage `merchant-logos`, and any trigger that creates a merchant on signup.  
ALS_draft0 may **read** some of these via your **public API** or read-only views; they must **not** insert into `orders` directly (they use your POST orders API when you expose it).

---

## 7. Environment Variables (Nooksweb)

**Required for production:**

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (server only) |
| `NEXT_PUBLIC_MOYASAR_PUBLISHABLE_KEY` | Moyasar publishable key (live for production) |
| `MOYASAR_SECRET_KEY` | Moyasar secret key (live for production) |
| `BUILD_SERVICE_WEBHOOK_URL` | Full URL to ALS_draft0 build webhook (e.g. `https://als-api.railway.app/build`) |
| `BUILD_SERVICE_WEBHOOK_SECRET` | Secret to send in `x-nooks-secret` header when calling the build webhook |

**Optional but recommended:**

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | Resend API key (payment receipt emails) |
| `RESEND_FROM_EMAIL` | From address for Resend |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN for error tracking |
| `NEXT_PUBLIC_BILLING_SKIP_FOODICS_GATE` | Set to `true` only for testing payment without Foodics |
| `FOODICS_CLIENT_ID`, `FOODICS_CLIENT_SECRET` | When Foodics provides OAuth credentials |
| `NEXT_PUBLIC_FOODICS_ENABLED` | `true` when Foodics OAuth is live |

---

## 8. Deployment (Netlify or Similar)

1. Connect your nooksweb repo to Netlify (or your host).
2. Build command: e.g. `npm run build`; publish directory per Next.js (e.g. `out` or `.next` + server).
3. Add **all** required env vars in the host’s environment variables.
4. Set **Site URL** and **Redirect URLs** in Supabase to your **live** domain.
5. Redeploy after changing env vars.

---

## 9. Legal and Go-Live Checklist

- **Terms of Service** and **Privacy Policy** pages – linked from signup/login. Update with real company name, contact, refund policy, and data use before taking real money.
- **One full manual test:** Sign up on live site → verify email → complete wizard → pay (real card if going live) → land on dashboard → confirm build webhook was called (check ALS_draft0 server logs or GitHub Actions for “Nooks-triggered build”). Optionally confirm customer app loads with that merchant’s branding.

---

## 10. Order of Work (From First Line to Publishing)

1. **Repo and deps** – Next.js app, Supabase client, Moyasar, Resend (if used).  
2. **Supabase** – Create project, run all migrations in order, create `merchant-logos` bucket, set Auth URLs.  
3. **Auth** – Signup (email + password), verify email, login, forgot/reset password.  
4. **Landing page** – Value prop (Foodics + no fleet), wizard on first page (icon + colors, 4-tab preview), “Get started” → signup.  
5. **Signup page** – Email or Foodics; warning “need Foodics account”; redirect Foodics users to wizard.  
6. **Wizard** – 4 tabs (Menu, Offers, Orders, More), icon upload, colors, Save & continue → payment.  
7. **Payment** – One plan, block until Foodics connected (with warning), success handler: POST to build webhook then redirect to dashboard.  
8. **Dashboard** – All 6 sections: Dashboard (sales, active orders, latest), Live Operations (store status, prep time, delivery mode, menu availability), Marketing Studio (banners, push, promos), Analytics (app performance, leaderboard), Settings (Merchant ID, Branding API URL, Foodics status, branch verification), Help.  
9. **Public API routes** – Implement GET branding, banners, promos, operations (and branches when you have data).  
10. **Build webhook integration** – On payment success, POST to `BUILD_SERVICE_WEBHOOK_URL` with `x-nooks-secret` and JSON body.  
11. **Env and deploy** – Set all env vars on Netlify (or host), deploy, test Auth redirects.  
12. **Moyasar live** – Switch to live keys when going live.  
13. **Legal** – Publish and link Terms and Privacy.  
14. **Full test** – Signup → wizard → pay → dashboard → build triggered → (optional) customer app with merchant ID.

---

## 11. Reference Documents (In ALS_draft0 Repo)

These live in the **ALS_draft0** repo (customer app + server). Use them for alignment and implementation details:

- **`docs/ULTIMATE_WORKFLOW_SPEC.md`** – Full workflow spec (website + app).  
- **`docs/EVERYTHING_LEFT_FULL_STACK.md`** – Combined checklist (nooksweb + ALS_draft0) for going live.  
- **`docs/MESSAGE_FOR_NOOKS_AGENT_BUILD_WEBHOOK.md`** – Exact build webhook URL, secret, and POST format.  
- **`docs/MESSAGE_FROM_NOOKS_AND_ALS_RESPONSE.md`** – What Nooks said and what ALS_draft0 does (build webhook, operations API).  
- **`docs/BUILD_WEBHOOK_EXPLAINED.md`** – Plain-language explanation of build webhook and tokens.  
- **`docs/NOOKSWEB_APIS_AND_BEHAVIOR.md`** – APIs the customer app uses (branding, banners, promos, operations) and behavior.  
- **`docs/NOOKS_AND_SUPABASE.md`** – How nooksweb and ALS_draft0 share Supabase; what not to break.  
- **`docs/NOOKSWEB_ANSWERS.md`** – Branch schema, merchant id, orders API shape, branding fields, Supabase list (for ALS_draft0; useful for you to know what the app expects).  
- **`docs/ANSWERS_FOR_NOOKSWEB.md`** – ALS_draft0’s answers to nooksweb (customer_id, order status, branch id, promo codes, etc.).

---

## 12. Summary in One Paragraph

**Nooks (nooksweb)** is the merchant-facing website and dashboard for coffee shop owners in Saudi Arabia. You build: (1) a **landing page** with an interactive **wizard on the first page** (icon + colors, 4-tab preview matching the app) and clear messaging about Foodics and no delivery fleet; (2) **signup** (email or Foodics) with a warning that a Foodics account is required; (3) a **wizard** (4 tabs: Menu, Offers, Orders, More) to set icon and colors, then **Save & continue** to payment; (4) a **payment page** with one plan, **blocking payment until Foodics is connected** (with a warning), and after success **calling the build webhook** (POST with merchant_id, logo_url, primary_color, accent_color and `x-nooks-secret`) then redirecting to the dashboard; (5) a **dashboard** with Dashboard (sales, orders), Live Operations (store status, prep time, delivery on/off, menu availability), Marketing Studio (banners, push, promo codes), Analytics (app performance, leaderboard), Settings (Merchant ID, Branding API, Foodics, branches), and Help; (6) **public APIs** for branding, banners, promos, and operations so the customer app (ALS_draft0) can white-label and respect store status and delivery mode. You use **Supabase** (auth, DB, storage), **Moyasar** (payments), **Resend** (receipts), deploy on **Netlify**, and run all **migrations** in order. After payment you **POST once** to the ALS_draft0 build webhook so Android and iOS apps are built for that merchant. This document is the single source of truth from first line of code to publishing.

---

*End of the complete nooksweb project prompt.*
