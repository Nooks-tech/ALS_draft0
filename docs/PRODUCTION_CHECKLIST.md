# Production Checklist – ALS_draft0

Use this before going live so the app is secure and aligned with Nooks. Do **one full pass** with this list and verify each item.

---

## 1. Auth

- [ ] **Turn off dev auth bypass**  
  Set in `.env` (or EAS secrets): **`EXPO_PUBLIC_SKIP_AUTH_FOR_DEV=false`** or leave it **unset**.  
  The app only skips auth when this is explicitly `'true'`. Never set it to `true` in production.

- [ ] **Full auth flow**  
  Run: **Sign up → Login → OTP (if enabled) → Place order**. Confirm Resend OTP emails arrive and Supabase redirect works.

- [ ] **Supabase Auth URLs**  
  In Supabase Dashboard → Authentication → URL Configuration:
  - **Site URL**: your production app URL or deep-link scheme (e.g. `https://yourapp.com` or `alsdraft0://`)
  - **Redirect URLs**: add every URL the app may redirect to (e.g. `alsdraft0://**, https://yourapp.com/**`, and any Resend/callback URLs if used)

- [ ] **Resend (OTP)**  
  Production Resend API key in `server/.env` (`RESEND_API_KEY`). Confirm sender domain is verified and OTP emails are not blocked.

---

## 2. Environment Variables

**Root `.env` (Expo / client):**

- [ ] `EXPO_PUBLIC_SUPABASE_URL` – production Supabase project URL
- [ ] `EXPO_PUBLIC_SUPABASE_ANON_KEY` – production anon key
- [ ] `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY` – **live** key (not `pk_test_...`) when accepting real payments
- [ ] `EXPO_PUBLIC_MOYASAR_BASE_URL` – production Moyasar API URL if different
- [ ] `EXPO_PUBLIC_MAPBOX_TOKEN` – production Mapbox token
- [ ] `EXPO_PUBLIC_MERCHANT_ID` – (optional) set to Nooks `merchants.id` (UUID) per merchant
- [ ] `EXPO_PUBLIC_SKIP_AUTH_FOR_DEV` – leave unset or `false` in production
- [ ] `EXPO_PUBLIC_NOOKS_API_BASE_URL` – (optional) Nooks public API base URL when they expose branches/orders/branding

**`server/.env`:**

- [ ] `SUPABASE_URL` – same production Supabase URL
- [ ] `SUPABASE_SERVICE_ROLE_KEY` – production service role key
- [ ] `MOYASAR_SECRET_KEY` – **live** key (not `sk_test_...`) for production payments
- [ ] `OTO_REFRESH_TOKEN` – production OTO token
- [ ] `RESEND_API_KEY` – production Resend key (OTP emails)
- [ ] `FOODICS_API_TOKEN` – (if used) production Foodics token
- [ ] No dev/test keys left in production env

---

## 3. Supabase – Do Not Break Nooks

ALS_draft0 shares the Supabase project with **Nooks (nooksweb)**. We must **not**:

- Create or alter: `merchants`, `app_config`, `foodics_connections`, `branch_mappings`, `products`, `audit_log`
- Touch the `merchant-logos` storage bucket or Nooks triggers (e.g. create merchant on signup)

**We may use:**

- `auth.users` (Supabase Auth)
- `public.profiles`
- `public.email_otp`
- Our own promo / ALS-specific tables

Any **new** tables or columns must be clearly ALS-only or agreed with nooksweb. Document changes in `docs/NOOKS_AND_SUPABASE.md`.

---

## 4. OTO and Branches

- [ ] Production OTO pickup location codes (e.g. `NOOKS-MADINAH-01`, `NOOKS-RIYADH-01`) match what Nooks expects.
- [ ] Branch IDs/names in ALS_draft0 align with Nooks `branch_mappings` (see `docs/BRANCH_MAPPING_NOOKS.md`).

---

## 5. Apple Pay (if used)

- [ ] Production Apple Pay merchant ID and domain association; build with production credentials (see `docs/APPLE_PAY_SETUP.md`).

---

## 6. Supabase Realtime for orders

- [ ] **Enable Realtime for `customer_orders`**  
  In Supabase Dashboard → **Database** → **Replication**: turn on replication for the **`customer_orders`** table so the app receives live status updates (e.g. when OTO status is synced or Nooks/backend updates the row).

---

## 7. Guest orders

- **Logged-in users:** Orders are persisted to Supabase `customer_orders` and survive refresh; status can be updated by backend/Nooks (or by OTO sync when the app calls `GET /api/oto/order-status`) and reflected via Realtime.
- **Guest users:** Orders exist only in app state and are **lost on refresh**. Document this as temporary until you require login before checkout or add a guest-order table.

---

## 8. One-pass verification

- [ ] **Auth:** Sign up → Login → OTP (if enabled) → complete flow. Resend OTP and Supabase redirect URLs work in production.
- [ ] **Orders:** Place a test order; it appears in Orders tab with correct merchant and branch. For a logged-in user, refresh app and order still appears (Supabase persistence).
- [ ] **Delivery:** Same-city delivery check works; cross-city is blocked.
- [ ] **Keys:** No `EXPO_PUBLIC_SKIP_AUTH_FOR_DEV`, no test Moyasar keys (`pk_test_` / `sk_test_`), no test OTO/Resend keys in production env.
- [ ] **Nooks:** No Nooks-owned tables modified (see §3); only ALS tables (e.g. `customer_orders`, `als_promo_codes`) and shared Auth used.
