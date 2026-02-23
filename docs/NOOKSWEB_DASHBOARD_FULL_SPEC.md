# Nooksweb Dashboard – Full Spec and Implementation Guide

This document is the **most detailed specification** for the nooksweb dashboard: every page, every feature, and step-by-step backend and frontend implementation. Use it when building or rebuilding the merchant dashboard from scratch.

---

## Table of contents

1. [Dashboard overview and layout](#1-dashboard-overview-and-layout)
2. [Page 1: Dashboard (Home)](#2-page-1-dashboard-home)
3. [Page 2: Live Operations](#3-page-2-live-operations)
4. [Page 3: Marketing Studio](#4-page-3-marketing-studio)
5. [Page 4: Analytics](#5-page-4-analytics)
6. [Page 5: Settings](#6-page-5-settings)
7. [Page 6: Help](#7-page-6-help)
8. [Public API routes (for the customer app)](#8-public-api-routes-for-the-customer-app)
9. [Database schema reference](#9-database-schema-reference)
10. [Frontend architecture](#10-frontend-architecture)
11. [Backend patterns and RLS](#11-backend-patterns-and-rls)

---

## 1. Dashboard overview and layout

### 1.1 Purpose

The dashboard is the **post-login area** for merchants. Only users who are logged in and have a **merchant** row (linked by `merchants.user_id = auth.uid()`) may access it. Every page is **scoped to the current merchant** (`merchants.id`).

### 1.2 URL structure

- **Base path:** `/dashboard` (or `/d` if you prefer a short prefix).
- **Sections:**
  - `/dashboard` – Home (today’s sales, active orders, latest orders).
  - `/dashboard/operations` – Live Operations (store status, prep time, delivery mode, menu availability).
  - `/dashboard/marketing` – Marketing Studio (banners, push, promos).
  - `/dashboard/analytics` – Analytics (app performance, customer leaderboard).
  - `/dashboard/settings` – Settings (Merchant ID, Branding API, Foodics, branches).
  - `/dashboard/help` – Help.

You can use a **sidebar** that highlights the current section and links to these routes.

### 1.3 Layout component (frontend)

- **Wrapper:** A layout that wraps all `/dashboard/*` routes (e.g. `app/dashboard/layout.tsx`).
- **Auth guard:** In the layout (or in middleware), ensure the user is logged in and has a merchant row. If not, redirect to `/signin` (and optionally save `?next=/dashboard`).
- **Sidebar (desktop):** Vertical sidebar on the left with:
  - Logo or “Nooks” text at top.
  - Nav links: Dashboard, Live Operations, Marketing Studio, Analytics, Settings, Help.
  - At bottom: “Manage subscription” (e.g. link to Moyasar or contact), “Log out”.
- **Mobile:** Collapsible hamburger menu or bottom nav that shows the same sections.
- **Main content area:** The right (or full width on mobile) shows the current page content. Use a consistent padding and max-width (e.g. `max-w-6xl mx-auto px-4 py-6`).

### 1.4 Getting the current merchant in the layout

In the dashboard layout (Server Component or client that fetches once):

1. Get the current user: `const { data: { user } } = await supabase.auth.getUser()` (use server Supabase client with cookies).
2. If no `user`, redirect to `/signin`.
3. Load merchant: `const { data: merchant } = await supabase.from('merchants').select('id, full_name, cafe_name, status').eq('user_id', user.id).single()`.
4. If no `merchant`, show an error or redirect (e.g. “Merchant not found” or onboarding).
5. Pass `merchant` (or `merchantId`) to child pages/components so every section can use the same `merchant.id` for queries and API calls.

You can put this in a **context** (e.g. `DashboardProvider`) that provides `merchant` and `user` to all dashboard pages, or pass as layout props.

---

## 2. Page 1: Dashboard (Home)

### 2.1 Purpose

Give the merchant a **quick snapshot**: how much they sold today from the app, how many orders are currently active (not yet delivered), and a list of the latest orders (for quick reference or drill-down).

### 2.2 UI (what the merchant sees)

- **Page title:** “Dashboard” or “Home”.
- **Summary cards (top row):**
  1. **Today’s app sales** – Single number (e.g. “1,240 SAR”) – sum of `orders.total_sar` for orders created today (or “today” in merchant’s timezone) where the order originated from the app (you can mark app orders with a flag or assume all orders in your `orders` table are app orders).
  2. **Active orders** – Single number (e.g. “3”) – count of orders where `status` is not one of `delivered`, `cancelled` (e.g. `pending`, `preparing`, `ready`, `out_for_delivery`).
  3. Optionally a third card (e.g. “Orders today” – count of orders created today).
- **Latest orders (table or list):**
  - Columns or fields: Order ID (or last 6 chars), date/time, status, total (SAR), optional “View” link.
  - Sort by `created_at` descending; show the last 10 or 20.
  - Each row can link to a detail view (e.g. `/dashboard/orders/[id]`) if you build it; otherwise at least show the data in the table.
- **Empty states:** If there are no orders yet, show a short message: “No orders yet. Orders from your app will appear here.”

### 2.3 Data and backend

**Source of truth:** Your `orders` table (see [Section 9](#9-database-schema-reference)). Assumptions:

- `orders.merchant_id` = current merchant’s id.
- `orders.total_sar` = order total in SAR.
- `orders.status` = one of `pending`, `preparing`, `ready`, `out_for_delivery`, `delivered`, `cancelled`.
- `orders.created_at` = when the order was placed.

**Queries (run server-side, e.g. in the page or a server action):**

1. **Today’s app sales**
   - Filter: `merchant_id = :merchantId`, `created_at` >= start of today (in merchant timezone or UTC), and optionally `source = 'app'` if you have that column.
   - Aggregate: `sum(total_sar)`.
   - SQL idea: `select coalesce(sum(total_sar), 0) from orders where merchant_id = $1 and created_at >= date_trunc('day', now())` (adjust timezone if needed).

2. **Active orders count**
   - Filter: `merchant_id = :merchantId`, `status not in ('delivered', 'cancelled')`.
   - Aggregate: `count(*)`.
   - SQL idea: `select count(*) from orders where merchant_id = $1 and status not in ('delivered', 'cancelled')`.

3. **Latest orders**
   - Filter: `merchant_id = :merchantId`.
   - Order by: `created_at desc`.
   - Limit: 10 or 20.
   - Select: `id`, `created_at`, `status`, `total_sar`, optionally `customer_id` or items count.

**Where to run:** In a **Server Component** (e.g. `app/dashboard/page.tsx`), create the Supabase server client, get the current merchant (from layout or re-fetch), then run these queries with the anon client (RLS will restrict to the merchant’s rows). Alternatively, put the logic in a **server action** or **API route** (e.g. `GET /api/dashboard/stats`) that returns `{ todaySales, activeOrdersCount, latestOrders }` and call it from a client component; ensure the API route uses the same auth and merchant resolution so it only returns data for the logged-in merchant.

### 2.4 Frontend implementation

- **Server Component (recommended):** In `app/dashboard/page.tsx`, `await` the three queries (today sales, active count, latest orders), then render the cards and the table. Pass `merchantId` from the layout or re-fetch user/merchant in the page.
- **Cards:** Use a grid (e.g. `grid grid-cols-1 md:grid-cols-3 gap-4`). Each card is a bordered box with a label (“Today’s app sales”, “Active orders”) and the number. Format currency with a helper (e.g. `formatCurrency(total)`).
- **Table:** Use a `<table>` or a component library table. Map `latestOrders` to rows; format date with `toLocaleString` or a date library; show status as a badge (color by status).
- **Loading:** If you fetch in a client component, show a skeleton or spinner while loading.
- **Error:** If the merchant has no row or queries fail, show an error message and optionally a link to settings or support.

---

## 3. Page 2: Live Operations

### 3.1 Purpose

Let the merchant control **store status** (open / busy / closed), **prep time** (how many minutes the store is “busy”), and **delivery mode** (delivery + pickup vs pickup only). These values must be **read by the customer app** (via the Operations API) so the app can show “Store closed”, disable ordering when closed, hide the delivery option when the merchant turns off delivery, and show prep time in the UX. Also: **menu availability** – show/hide specific items in the app without changing the POS (e.g. out-of-stock items hidden in the app only).

### 3.2 UI (what the merchant sees)

- **Page title:** “Live Operations”.
- **Section 1 – Store status**
  - **Label:** “Store status”.
  - **Control:** Three options (radio or segmented control): **Open**, **Busy**, **Closed**.
  - **Behavior:** Selecting one updates the value immediately (or on “Save” if you prefer a single save button for the whole page). Default when not set: “Open”.
- **Section 2 – Prep time (when Busy)**
  - **Label:** “Prep time (minutes)” or “How many minutes is the store busy?”.
  - **Control:** A **slider** (range input) from 0 to e.g. 120 minutes (or 0–60), with a numeric display next to it (e.g. “15 min”). Only relevant when status is “Busy”; you can still save it when status is Open/Closed (the app might use it when status is Busy).
  - **Behavior:** On change, update the value (optimistic or on Save).
- **Section 3 – Delivery mode**
  - **Label:** “Delivery mode”.
  - **Explanation (short):** “When delivery is on, customers can order for delivery or pickup. When you turn it off, only pickup is available in the app.”
  - **Control:** Toggle or two options: **Delivery + Pickup** vs **Pickup only**.
  - **Fail-safe note:** Add a line: “If we can’t find a driver (e.g. OTO returns no drivers), we’ll automatically switch to Pickup only so customers can still order.”
  - **Behavior:** Setting to “Pickup only” must be reflected in the **Operations API** as `delivery_mode: "pickup_only"` so the customer app hides delivery. Setting to “Delivery + Pickup” → `delivery_mode: "delivery_and_pickup"`.
- **Section 4 – Menu availability**
  - **Label:** “Menu availability” or “Show/hide items in the app”.
  - **Explanation:** “Hide items in the customer app without changing your Foodics POS. Useful for out-of-stock or seasonal items.”
  - **Control:** A list of products (from your `products` table, scoped to the merchant). Each row: product name, toggle “Visible in app” (on/off). If you don’t have products yet (no Foodics sync), show: “No products. Sync menu from Foodics in Settings.”
  - **Behavior:** Toggling updates a field on the product (e.g. `is_hidden` or `visible_in_app`). The customer app, when it fetches menu (from you or Foodics), should filter out hidden items if you expose a menu API; otherwise document that this is for a future menu API.

### 3.3 Data and backend

**Where to store:**

- **Store status, prep time, delivery mode:** In **`app_config`** (one row per merchant). Typical columns:
  - `merchant_id` (uuid, FK to merchants.id),
  - `store_status` (text: `'open'` | `'busy'` | `'closed'`),
  - `prep_time_minutes` (integer, default 0),
  - `delivery_mode` (text: `'delivery_and_pickup'` | `'pickup_only'`),
  - `logo_url`, `primary_color`, `accent_color`, `background_color` (from wizard/branding),
  - `updated_at`.
  Use a single row per merchant; upsert on update (e.g. `insert into app_config (merchant_id, store_status, prep_time_minutes, delivery_mode, ...) values (...) on conflict (merchant_id) do update set ...`). If your migration uses a different shape (e.g. only `delivery_mode` in a separate table), adapt accordingly.
- **Menu availability:** In **`products`** (or equivalent): a boolean column like `is_hidden` or `visible_in_app`. When you sync products from Foodics, set default `visible_in_app = true`; the merchant can toggle it in Live Operations. The customer app (or your menu API) filters by `visible_in_app = true` when returning menu items.

**Backend implementation:**

1. **Read:** On load of the Live Operations page, fetch `app_config` for the current merchant (and products for the list). If no row in `app_config`, use defaults: `store_status = 'open'`, `prep_time_minutes = 0`, `delivery_mode = 'delivery_and_pickup'`.
2. **Write:** On form submit or each control change, call a **server action** or **API route** (e.g. `PATCH /api/dashboard/operations` or `updateOperations` server action) that:
   - Verifies the user is logged in and has a merchant row.
   - Updates `app_config` for that merchant (set `store_status`, `prep_time_minutes`, `delivery_mode`).
   - For menu availability, update `products` set `is_hidden = :value` where `id = :productId` and `merchant_id = :merchantId`.
3. **RLS:** Ensure RLS on `app_config` and `products` allows select/update only when the row’s `merchant_id` matches a merchant that belongs to `auth.uid()` (e.g. `merchant_id in (select id from merchants where user_id = auth.uid())`).

**Sync with customer app:** The customer app calls **GET** `{API_BASE}/api/public/merchants/{merchantId}/operations` (see [Section 8](#8-public-api-routes-for-the-customer-app)). That endpoint must return `store_status`, `prep_time_minutes`, and `delivery_mode` from `app_config` (or from the same source you just updated). So when the merchant changes “Delivery + Pickup” to “Pickup only”, the next poll from the app gets `delivery_mode: "pickup_only"` and the app hides delivery.

### 3.4 Frontend implementation

- **Form:** Use a form (or separate controlled inputs) for store status, prep time slider, and delivery mode. Bind inputs to local state (e.g. `useState`) or to a form library (React Hook Form, Formik). On submit or on each change (debounced if you prefer), call the server action or API to persist.
- **Slider:** Use `<input type="range" min="0" max="120" value={prepTime} onChange={...} />` and display `prepTime` next to it. Sync `prepTime` to server when it changes or when the user clicks Save.
- **Product list:** If you have products, fetch them (e.g. `from('products').select('id, name, is_hidden').eq('merchant_id', merchantId).order('name')`). Map to a list of rows with a toggle per product; on toggle, call an action to set `is_hidden` for that product.
- **Loading and success:** Show loading state while fetching; after update, show a short “Saved” toast or message so the merchant knows the app will reflect the change.

---

## 4. Page 3: Marketing Studio

### 4.1 Purpose

Three sub-features: (1) **Banners** – upload images and assign placement (slider below header, popup on app open, or offers tab) and optional deep links to Foodics categories/products; (2) **Push notifications** – send push notifications to customers (UI can be stubbed or wired later); (3) **Promo engine** – create and manage promo codes (name, code, type, value, expiration) that customers use at checkout; codes are validated before orders go to Foodics.

### 4.2 Banners

**UI:**

- **Section title:** “Banners”.
- **Short description:** “Images shown in the customer app: in the horizontal slider below the header, or as a popup when the customer opens the app.”
- **List of existing banners:** Each row shows: thumbnail (image), title/subtitle (if any), placement (Slider / Popup / Offers), optional deep link, and actions: Edit, Delete.
- **Button:** “Add banner”.
- **Add/Edit form (modal or inline):**
  - **Image:** File upload (or URL input for testing). Upload to Supabase Storage (e.g. bucket `banners` or `merchant-assets`) and store the public URL in the banner row.
  - **Title** (optional), **Subtitle** (optional).
  - **Placement:** Dropdown or radio: “Slider” (horizontal strip below header), “Popup” (on app open, one per session), “Offers” (offers tab). Store as `placement` text: `'slider'` | `'popup'` | `'offers'`.
  - **Deep link** (optional): Text input for a Foodics category or product link (or internal deep link). Store in `deep_link` column.
  - **Save** / **Cancel**.

**Backend:**

- **Table:** `banners` (see [Section 9](#9-database-schema-reference)). Columns: `id`, `merchant_id`, `image_url`, `title`, `subtitle`, `placement`, `deep_link`, `sort_order`, `created_at`, `updated_at`. RLS: merchant can only see/insert/update/delete own rows (`merchant_id in (select id from merchants where user_id = auth.uid())`).
- **Storage:** Create a bucket (e.g. `banners`) with policy that allows authenticated users to upload; store the returned public URL in `banners.image_url`. Or use a bucket per merchant if you prefer.
- **CRUD:** Server actions or API routes: `getBanners(merchantId)`, `createBanner(merchantId, { image_url, title, subtitle, placement, deep_link })`, `updateBanner(bannerId, ...)`, `deleteBanner(bannerId)`. Always scope by `merchant_id` and check that the banner’s merchant belongs to the current user.

**Customer app:** The app calls **GET** `/api/public/merchants/{merchantId}/banners` and gets an array of `{ id, image_url, title, subtitle, placement, deep_link }`. Slider uses `placement === 'slider'` (or no placement); popup uses `placement === 'popup'`; offers tab can use `placement === 'offers'` or all.

### 4.3 Push notifications

**UI:**

- **Section title:** “Push notifications”.
- **Short description:** “Send a notification to customers who have your app installed.”
- **Form:** Title, body (message), optional “Send now” button. For now you can stub the send (e.g. “Coming soon” or call a placeholder API that logs and returns success).
- **Backend (later):** You’ll need to store push tokens per customer (in the customer app and send to your backend), then use FCM/APNs or Expo Push to send. Document that this section is for future implementation; no DB table required for the stub.

### 4.4 Promo engine

**UI:**

- **Section title:** “Promo codes”.
- **Short description:** “Codes your customers enter at checkout. Validated before the order is sent to Foodics.”
- **List of promos:** Table or cards with: Code, Name (display name), Type (percentage / amount), Value, Valid from, Valid until, Uses (e.g. 3/10), Status (Active/Inactive), Actions (Edit, Deactivate).
- **Button:** “Create promo code”.
- **Add/Edit form:**
  - **Code:** Text (e.g. “SAVE15”). Store uppercase; validate uniqueness per merchant.
  - **Name:** Text (display name, can equal code).
  - **Type:** “Percentage” or “Amount (SAR)”.
  - **Value:** Number (e.g. 15 for 15%, or 10 for 10 SAR off).
  - **Valid from** (optional), **Valid until** (optional) – date pickers.
  - **Max uses** (optional) – cap how many times the code can be used.
  - **Active:** Checkbox (default true).
  - **Save** / **Cancel**.

**Backend:**

- **Table:** `promo_codes` (see [Section 9](#9-database-schema-reference)). Columns: `id`, `merchant_id`, `code`, `name`, `type` (`'percentage'` | `'amount'`), `value` (numeric), `valid_from`, `valid_until`, `max_uses`, `uses_count` (default 0), `active` (boolean), `created_at`, `updated_at`. Unique constraint on `(merchant_id, upper(code))`. RLS: merchant can only manage own rows.
- **Increment uses:** When the customer app (or your order API) validates a promo and creates an order, increment `uses_count` for that code (e.g. in a server action or API that creates the order). Optionally enforce `uses_count < max_uses` when validating.
- **Public API:** **GET** `/api/public/merchants/{merchantId}/promos` returns active promos (code, name, type, value, valid_from, valid_until, etc.) for the Offers tab and for checkout validation. Validation (check code, dates, max_uses, compute discount) can be done in the customer app against this list, or in your API (e.g. POST `/api/public/merchants/{merchantId}/promos/validate` with `code` and `subtotal`).

### 4.5 Frontend implementation (Marketing Studio)

- **Tabs or sections:** Use tabs “Banners”, “Push notifications”, “Promo codes” on the Marketing Studio page, or three vertical sections on one scrollable page.
- **Banners:** Use a grid or list for banner cards; modal or slide-over for add/edit. Use Supabase client `upload` for file upload, then set `image_url` to the public URL. Fetch banners with `from('banners').select('*').eq('merchant_id', merchantId).order('sort_order')`.
- **Promos:** Fetch with `from('promo_codes').select('*').eq('merchant_id', merchantId).order('created_at', { ascending: false })`. Create/update with insert/upsert; delete or set `active = false` for deactivate.
- **Loading and errors:** Show loading states; on validation errors (e.g. duplicate code), show field-level errors.

---

## 5. Page 4: Analytics

### 5.1 Purpose

**App performance:** Sales from app orders over the last 14 days (chart or table). **Customer leaderboard:** Top spenders (by total order value or order count); ability to “Send targeted discount to VIPs” (can be a button that opens a modal to create a one-off promo or send a push – stub is fine).

### 5.2 UI

- **Section 1 – App performance**
  - **Title:** “App performance” or “Sales from app (last 14 days)”.
  - **Control:** A chart (e.g. bar or line) with one point per day (last 14 days), value = sum of `orders.total_sar` for that day and `merchant_id = current merchant`. Or a simple table: Date, Orders count, Total (SAR).
- **Section 2 – Customer leaderboard**
  - **Title:** “Customer leaderboard” or “Top spenders”.
  - **Table:** Columns: Rank, Customer (id or masked email/phone), Orders count, Total spent (SAR). Sorted by total spent descending; show top 10 or 20.
  - **Button:** “Send discount to VIP” – can open a modal to create a promo code or send a push (stub: “Coming soon” or a simple form that creates a promo and shows “Share this code with your VIP: XXXX”).

### 5.3 Backend

- **App performance:** Query `orders` where `merchant_id = :merchantId` and `created_at >= now() - interval '14 days'`. Group by `date_trunc('day', created_at)` (or by date in merchant timezone), sum `total_sar`, count `*`. Return array of `{ date, total_sar, order_count }`. Run in Server Component or in an API route `GET /api/dashboard/analytics/performance`.
- **Leaderboard:** Query `orders` where `merchant_id = :merchantId`, group by `customer_id`, sum `total_sar`, count `*`. Order by sum descending, limit 20. Return array of `{ customer_id, total_sar, order_count }`. You may not have a “customer name”; show masked id or “Customer #1” unless you store names elsewhere.
- **RLS:** Same as before; only the merchant’s orders are visible.

### 5.4 Frontend

- Use a chart library (e.g. Recharts, Chart.js) for the 14-day series. If you prefer no chart, a table is fine.
- Leaderboard: simple table; “Send discount to VIP” can create a promo and copy to clipboard or show in a modal.

---

## 6. Page 5: Settings

### 6.1 Purpose

Show **Merchant ID** and **Branding API URL** (for testing and for the customer app), **Foodics connection status** and menu sync, and **branch verification** (list branches, confirm coordinates and manager phone for OTO).

### 6.2 UI

- **Section – App & API (testing)**
  - **Label:** “Merchant ID”. **Value:** `merchant.id` (UUID). Read-only; optional “Copy” button.
  - **Label:** “Branding API”. **Value:** Full URL, e.g. `https://your-domain.com/api/public/merchants/{merchant.id}/branding`. Read-only; optional “Copy” and “Open” (new tab).
  - Short line: “Use these for the customer app and to test the branding API.”
- **Section – POS integration**
  - **Label:** “Foodics connection”.
  - If not connected: “Not connected.” Button: “Connect Foodics” (or “Connect Foodics – coming soon” if disabled). Subtext: “Foodics integration will be available once we complete setup with Foodics.”
  - If connected: “Connected.” Optional: “Sync menu” button (triggers a sync from Foodics API and updates `products` and `branch_mappings`).
- **Section – Branch verification**
  - **Label:** “Branch verification”.
  - Subtext: “Confirm map coordinates and manager phone for OTO delivery.”
  - If no branches: “No branches. Sync from Foodics first.”
  - If branches exist: List each branch (name, address or lat/lng, manager phone, verified yes/no). Allow edit for coordinates and manager phone; “Verify” or “Save” to set `verified = true` and optionally push to OTO.

### 6.3 Backend

- **Merchant ID and Branding URL:** No backend beyond reading `merchant.id` and building the URL string (use `process.env.NEXT_PUBLIC_APP_URL` or `origin` for base).
- **Foodics:** If you have `foodics_connections` (merchant_id, access_token, refresh_token, etc.), check if there is a row for the current merchant to show “Connected”. “Connect Foodics” redirects to Foodics OAuth; callback stores tokens and optionally triggers a one-time sync. “Sync menu” calls Foodics API (products, branches) and upserts into `products` and `branch_mappings`.
- **Branch verification:** Fetch `branch_mappings` for the merchant; allow update of `latitude`, `longitude`, `manager_phone`, and `verified`. Optionally call OTO API to create/update pickup location using `oto_warehouse_id` and manager phone.

### 6.4 Frontend

- Mostly read-only fields with copy buttons. For branches, a form or inline edit per row; submit updates via server action or PATCH API.

---

## 7. Page 6: Help

### 7.1 Purpose

Support and help content: links to help center, contact email/phone, FAQ, or “Contact us” form (optional).

### 7.2 UI and backend

- Static content (markdown or hardcoded text) or a link to an external help site. Optional: simple “Contact us” form that sends an email (e.g. via Resend) or creates a support ticket. No dashboard-specific DB table required.

---

## 8. Public API routes (for the customer app)

The customer app (ALS_draft0) calls these endpoints when `EXPO_PUBLIC_NOOKS_API_BASE_URL` is set to your deployed base. Implement them in nooksweb (e.g. under `app/api/public/merchants/[merchantId]/...`).

### 8.1 GET …/branding

- **Path:** `GET /api/public/merchants/[merchantId]/branding`
- **Auth:** None (public). Optionally rate-limit by IP or merchantId.
- **Logic:** Load `app_config` (or equivalent) where `merchant_id = merchantId`. Return JSON: `{ logo_url, primary_color, accent_color, background_color }`. Use defaults if a value is null (e.g. `background_color` default `"#f5f5f4"`).
- **Implementation:** In Next.js, create `app/api/public/merchants/[merchantId]/branding/route.ts`. Use a **service role** Supabase client (or anon + RLS that allows public read for branding) to select from `app_config` by `merchant_id`. Return `NextResponse.json({ ... })`.

### 8.2 GET …/banners

- **Path:** `GET /api/public/merchants/[merchantId]/banners`
- **Auth:** None (public).
- **Logic:** Select from `banners` where `merchant_id = merchantId`, order by `sort_order` or `created_at`. Return array of `{ id, image_url, title, subtitle, placement, deep_link }`.
- **Implementation:** Same pattern; service role or RLS that allows public read for banners by merchant_id.

### 8.3 GET …/promos

- **Path:** `GET /api/public/merchants/[merchantId]/promos`
- **Auth:** None (public).
- **Logic:** Select from `promo_codes` where `merchant_id = merchantId` and `active = true` and (if you have dates) `valid_until >= now()` and `valid_from <= now()`. Return array of `{ id, code, name, type, value, valid_from, valid_until, description }`.
- **Implementation:** Same; public read by merchant_id.

### 8.4 GET …/operations

- **Path:** `GET /api/public/merchants/[merchantId]/operations`
- **Auth:** None (public).
- **Logic:** Load `app_config` where `merchant_id = merchantId`. Return JSON: `{ store_status: 'open'|'busy'|'closed', prep_time_minutes: number, delivery_mode: 'delivery_and_pickup'|'pickup_only' }`. Use defaults if missing (e.g. `store_status: 'open'`, `prep_time_minutes: 0`, `delivery_mode: 'delivery_and_pickup'`).
- **Implementation:** Same; this is critical so the app reflects Live Operations settings.

### 8.5 GET …/branches (when you have data)

- **Path:** `GET /api/public/merchants/[merchantId]/branches`
- **Logic:** Select from `branch_mappings` where `merchant_id = merchantId`; return `id`, `name`, `latitude`, `longitude`, `oto_warehouse_id`, `verified`. Do not expose `manager_phone` in the public API.

---

## 9. Database schema reference

Use this as a reference; align with your actual migrations in the nooksweb repo.

- **merchants:** `id` (uuid PK), `user_id` (uuid FK auth.users), `full_name`, `cafe_name`, `status`, `created_at`, `updated_at`.
- **app_config:** One row per merchant. `merchant_id` (uuid PK or unique), `logo_url`, `primary_color`, `accent_color`, `background_color`, `store_status`, `prep_time_minutes`, `delivery_mode`, `updated_at`. Add `background_color` via migration if missing.
- **orders:** `id`, `merchant_id`, `customer_id`, `total_sar`, `status`, `items` (jsonb), `branch_id`, `delivery_address`, `delivery_lat`, `delivery_lng`, `created_at`, `updated_at`. RLS: merchant can read own.
- **banners:** `id`, `merchant_id`, `image_url`, `title`, `subtitle`, `placement`, `deep_link`, `sort_order`, `created_at`, `updated_at`. RLS: merchant CRUD own.
- **promo_codes:** `id`, `merchant_id`, `code`, `name`, `type`, `value`, `valid_from`, `valid_until`, `max_uses`, `uses_count`, `active`, `created_at`, `updated_at`. RLS: merchant CRUD own. Unique (merchant_id, upper(code)).
- **products:** `id`, `merchant_id`, `foodics_product_id`, `name`, `price`, `image_url`, `is_hidden` (or `visible_in_app`), etc. RLS: merchant CRUD own.
- **branch_mappings:** `id`, `merchant_id`, `foodics_branch_id`, `name`, `latitude`, `longitude`, `manager_phone`, `oto_warehouse_id`, `verified`, `created_at`, `updated_at`. RLS: merchant CRUD own.
- **foodics_connections:** `id`, `merchant_id`, `access_token`, `refresh_token`, `expires_at`, etc. RLS: merchant CRUD own.

---

## 10. Frontend architecture

- **Framework:** Next.js App Router.
- **Auth:** Server Supabase client (cookies) in layout; redirect unauthenticated users from `/dashboard/*` to `/signin`. Resolve merchant once in layout and pass down or use context.
- **Data fetching:** Prefer Server Components and async/await for initial data (stats, orders, banners, promos, app_config). Use client components for forms, toggles, and interactive UI; call server actions or API routes for mutations.
- **Styling:** Tailwind or your design system; keep spacing and typography consistent across dashboard pages.
- **Sidebar:** Client or server; highlight current route (e.g. `usePathname()`). Links: `/dashboard`, `/dashboard/operations`, `/dashboard/marketing`, `/dashboard/analytics`, `/dashboard/settings`, `/dashboard/help`.
- **Loading and errors:** Use `loading.tsx` and `error.tsx` per route or segment; show skeletons or spinners where appropriate.

---

## 11. Backend patterns and RLS

- **Resolve merchant:** In every dashboard API route or server action, get the current user with `supabase.auth.getUser()` (server client with cookies), then `from('merchants').select('id').eq('user_id', user.id).single()`. If no merchant, return 403 or redirect.
- **RLS policy pattern:** For merchant-scoped tables, allow select/insert/update/delete where `merchant_id in (select id from public.merchants where user_id = auth.uid())`. Apply to `app_config`, `orders`, `banners`, `promo_codes`, `products`, `branch_mappings`, `foodics_connections`.
- **Public API routes:** For `/api/public/merchants/[merchantId]/...`, do **not** use the user’s session; use the **service_role** client (or anon with a policy that allows public read by merchant_id if you prefer). Validate `merchantId` is a valid UUID and that the merchant exists; then return the data. Do not expose other merchants’ data.
- **Audit log:** Optionally write to `audit_log` (merchant_id, action, payload, created_at) when the merchant updates operations, creates a promo, or connects Foodics, for support and compliance.

---

This document, together with your migrations and auth flow (see `NOOKSWEB_AUTH_GET_USER_INFO.md`), is the full spec for implementing the nooksweb dashboard and its backend and frontend.
