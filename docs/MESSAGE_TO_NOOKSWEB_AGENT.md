# Message to nooksweb Cursor Agent – What We Implemented in ALS_draft0

Copy the content below and paste it into a chat with the nooksweb Cursor agent so it has full context on the customer app.

---

**Subject: Context on ALS_draft0 (customer app) – what’s implemented, for nooksweb**

Hi,

This is a summary of everything we implemented in **ALS_draft0** (repo: ALS_draft0). It’s the **customer-facing ordering app** for coffee shops in Saudi Arabia. Nooks (nooksweb) is the merchant dashboard; ALS_draft0 is what customers use to browse menu, choose delivery or pickup, pay, and track orders. You can use this when working on nooksweb so you know how the two apps fit together and what the customer app already does.

---

## What ALS_draft0 Is

- **Expo / React Native** app (iOS, Android, web).
- Customers: browse menu, add to cart, choose **Delivery** or **In-Store Pickup**, select a **branch**, (for delivery) set delivery address, pay with **Moyasar** (card or Apple Pay), then see the order in the **Orders** tab with status and a **tracking map** (branch + delivery location).
- Same **Supabase project** as Nooks; we use auth, `profiles`, `email_otp`, and promo-related tables. We do **not** use or change Nooks tables (`merchants`, `app_config`, `foodics_connections`, `branch_mappings`, `products`, `audit_log`, storage `merchant-logos`, or Nooks triggers).

---

## Tech Stack (ALS_draft0)

- **Expo (SDK 54)**, React Native, Expo Router (file-based routing), NativeWind (Tailwind).
- **Supabase** – Auth (email/password), `profiles` (name, phone), `email_otp` (6-digit email OTP), promo validation (with local fallback).
- **Moyasar** – Customer payments (card, Apple Pay); init from app, server creates session with `MOYASAR_SECRET_KEY`.
- **Foodics** – Menu and branches from Foodics API when `FOODICS_API_TOKEN` is set; otherwise local fallback (`src/data/menu.ts`: products, categories, branches).
- **OTO** – Delivery: we call OTO to get delivery options and to request a driver (Mrsool for same-city). Uses `OTO_REFRESH_TOKEN`, pickup location codes per branch, same-city-only enforcement.
- **Mapbox** – Address search and geocoding (`EXPO_PUBLIC_MAPBOX_TOKEN`).
- **Resend** – Used by our **server** for OTP emails (forgot-password / email verification flow via `server/routes/auth.ts`), not for receipts (that’s Nooks).
- **react-native-maps** – Map on order-tracking screen (branch + delivery pins).

---

## Auth (Supabase + OTP)

- **Flow:** Email + password → 6-digit OTP sent to email (via server: Resend + `email_otp` table) → user enters code → profile (name, phone if missing) → main app.
- **Tables we use:** `auth.users` (Supabase Auth), `public.profiles` (id, full_name, phone_number, avatar_url), `public.email_otp` (email, code, expires_at).
- **Dev bypass:** `SKIP_AUTH_FOR_DEV` in `app/index.tsx` can skip login for testing; should be `false` in production.
- **Docs:** `docs/SUPABASE_AUTH.md`.

---

## Menu and Branches

- **Sources:** Foodics API (when configured) **or** local data in `src/data/menu.ts`.
- **Branches:** Local list has 4 branches: **Madinah** (Nooks Madinah – Central, Nooks Madinah – King Fahd Road), **Riyadh** (Nooks Riyadh – Olaya, Nooks Riyadh – King Fahd Road). IDs: `madinah-1`, `madinah-2`, `riyadh-1`, `riyadh-2`.
- **Foodics:** If branches come from Foodics, we map them to OTO config by **ID** (`FOODICS_BRANCH_ID_MAP` in `branchOtoConfig.ts`) or by **name** (e.g. “madinah”, “riyadh”, “olaya”, “king fahd”). So Nooks/Foodics branch names or IDs can be aligned with our OTO config.
- **Branch ↔ OTO:** `src/config/branchOtoConfig.ts` maps each branch to `otoPickupLocationCode`, `city`, `lat`, `lon`. Madinah branches use `NOOKS-MADINAH-01`, Riyadh use `NOOKS-RIYADH-01`. OTO pickup locations are created/updated with `server/scripts/oto-pickup-setup.ts` (run from `server/`).

---

## Order Flow (Delivery vs Pickup)

1. User chooses **Delivery** or **In-Store Pickup**.
2. **Branch selection** – user must pick a branch (no default; `selectedBranch` can be null until chosen).
3. **Delivery only:** then choose or add **delivery address** (saved addresses or add-address modal with Mapbox + map). We store `address`, `lat`, `lng`, and optionally `city` (for same-city check).
4. **Checkout** – cart summary, delivery fee for delivery, promo code, payment (Moyasar). We validate **same-city**: if branch city and delivery city differ (or if distance branch ↔ delivery > 50 km when city is missing), we block and show “Delivery is only available within [branch city]”.
5. **Payment success** → we create order (Foodics if configured, else local), call OTO **request-delivery** for delivery orders (with branch pickup code, delivery option, customer, address, items), then add order to local state and redirect to Orders tab.

---

## Payments (Moyasar)

- **Client:** `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY`, `EXPO_PUBLIC_MOYASAR_BASE_URL`. Card and Apple Pay (Apple Pay only on iOS; `APPLE_PAY_MERCHANT_ID` in config).
- **Server:** `MOYASAR_SECRET_KEY` in `server/.env`; creates payment session and verifies success. Order is created only after successful payment.
- **Docs:** `docs/PAYMENT_TESTING.md`, `docs/APPLE_PAY_SETUP.md`.

---

## OTO Delivery (Same-City, Multi-Branch)

- **Server:** `server/services/oto.ts`, `server/routes/oto.ts`. Env: `OTO_REFRESH_TOKEN`, `OTO_PICKUP_LOCATION_CODE` (default), `OTO_DELIVERY_OPTION_ID`, `OTO_PREFERRED_CARRIERS`.
- **Client:** `src/api/oto.ts` – get delivery options, request delivery. Checkout passes `pickupLocationCode` and `deliveryOptionId` from branch config and delivery-options response.
- **Same-city enforcement:**  
  - By **city** when both branch and delivery have `city`.  
  - By **distance** when `city` is missing: if distance (branch ↔ delivery) > 50 km we block and show message (so Riyadh branch + Madinah address is blocked even without city).
- **Pickup locations:** Madinah and Riyadh created/updated via `server/scripts/oto-pickup-setup.ts` (codes `NOOKS-MADINAH-01`, `NOOKS-RIYADH-01`).
- **Docs:** `docs/OTO_SETUP_GUIDE.md`, `docs/OTO_TESTING.md`.

---

## Promo Codes

- **Source:** Supabase table (e.g. promo codes table) when Supabase is configured; otherwise hardcoded fallback in `src/api/promo.ts`.
- **Docs:** `docs/PROMO_CODES.md`.

---

## Orders Tab and Tracking

- **Orders list:** Each order shows id, status, total, date, items summary; tap opens **order detail modal**.
- **Order status:** One of: Preparing, Ready, Out for delivery, Delivered, Cancelled. We have an **OrderStatusStepper** (vertical stepper) and status badge.
- **Tracking map:** We show a map with **branch** pin (from `branchOtoConfig` by `branchId` or `branchName`) and **delivery** pin when we have `deliveryLat`/`deliveryLng`. Driver pin is supported in the component but we don’t have OTO tracking yet.
- **Stored per order:** We persist `branchId`, `branchName`, `deliveryAddress` (string), `deliveryLat`, `deliveryLng` so the map works for past orders. Branch coords come from `branchOtoConfig`.

---

## Saved Addresses and Mapbox

- **Saved addresses:** Stored locally (AsyncStorage), with optional `city` for same-city check. When user picks a saved address for delivery, we set `deliveryAddress` (and lat/lng/city) in cart context.
- **Add-address modal:** Mapbox search + map; can save with label (Home, Work, Other). We try to pass `city` when available so same-city validation works; when `city` is missing we rely on the 50 km distance check.

---

## Supabase Usage Summary (for nooksweb)

- **We use:** `auth.users`, `public.profiles`, `public.email_otp`, and whatever table(s) promo validation reads from. Server auth routes use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; client uses `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- **We do not use or modify:** `merchants`, `app_config`, `foodics_connections`, `branch_mappings`, `products`, `audit_log`, or `merchant-logos` bucket, or any Nooks triggers. If we add new tables, we’ll keep them ALS-specific (or coordinate) so nooksweb is not broken.

---

## Env Vars (ALS_draft0)

**Root `.env` (Expo):**  
`EXPO_PUBLIC_MAPBOX_TOKEN`, `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY`, `EXPO_PUBLIC_MOYASAR_BASE_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, plus Apple Pay merchant id in app config.

**`server/.env`:**  
`FOODICS_API_TOKEN`, `FOODICS_API_URL`, `MOYASAR_SECRET_KEY`, `OTO_REFRESH_TOKEN`, `OTO_PICKUP_LOCATION_CODE`, `OTO_DELIVERY_OPTION_ID`, `OTO_PREFERRED_CARRIERS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` (for OTP emails), `TAP_SECRET_KEY` (optional, alternative to Moyasar).

---

## Docs in ALS_draft0

- `docs/NOOKS_AND_SUPABASE.md` – How Nooks and ALS_draft0 relate; shared Supabase; “don’t break Nooks tables.”
- `docs/SUPABASE_AUTH.md` – Auth flow, profiles, email_otp.
- `docs/OTO_SETUP_GUIDE.md` – OTO setup, multi-branch, pickup locations, Foodics branch mapping.
- `docs/OTO_TESTING.md` – Testing OTO and same-city.
- `docs/PAYMENT_TESTING.md`, `docs/APPLE_PAY_SETUP.md` – Moyasar and Apple Pay.
- `docs/PROMO_CODES.md` – Promo validation.

---

## Coordination with nooksweb

- **Branches:** Nooks may manage branches (and OTO mappings) in the dashboard. ALS_draft0 currently has its own `branchOtoConfig.ts` and local branch list; we can later align with Nooks’ `branch_mappings` or config if you expose an API or shared config.
- **Branding:** We don’t yet load merchant logo/colors from Nooks; the app is generic. If nooksweb exposes app_config (or similar), we could later use it for white-label.
- **Foodics:** When Foodics is connected in Nooks, branch IDs/names from Foodics can be mapped in ALS_draft0 via `FOODICS_BRANCH_ID_MAP` or name patterns so delivery and OTO still work.
- **OTO:** Same OTO account/refresh token can be used; we use pickup location codes per branch (Madinah, Riyadh). Nooks dashboard can manage which branches exist; we only need consistent branch identity (id or name) so our config or a future API can map to OTO.

If you need more detail on any part (e.g. exact API shapes, table schemas, or flows), say what you’re working on and we can narrow it down.
