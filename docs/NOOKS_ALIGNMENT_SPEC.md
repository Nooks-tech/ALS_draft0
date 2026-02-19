# What ALS_draft0 Needs to Implement (Nooks Alignment & Go-Live)

This doc is the spec for aligning ALS_draft0 with Nooks (nooksweb) and getting production-ready. Nooks is the merchant dashboard; ALS_draft0 is the customer ordering app.

---

## 1. Branch and Menu Source (Nooks / Merchant Context)

**Current:** Menu and branches come from local data or Foodics API when `FOODICS_API_TOKEN` is set; branch list is hardcoded in `branchOtoConfig.ts`.

**To implement:**

- **Option A (short term):** Keep current sources but align branch identity with Nooks. Use the same branch IDs or names that Nooks uses in `branch_mappings` (and for OTO pickup codes), so when a merchant configures branches in Nooks, our OTO mapping (e.g. `NOOKS-MADINAH-01`, `NOOKS-RIYADH-01`) still matches. Document the mapping (e.g. in `FOODICS_BRANCH_ID_MAP` or branchOtoConfig) so Nooks branch names/IDs map to the right `otoPickupLocationCode` and city.
- **Option B (next step):** When nooksweb exposes an API (or shared Supabase view) for “branches + OTO config for merchant X”, ALS_draft0 should load branches (and optionally menu) from that API instead of only local/static config.

**Deliverable:** (A) Clear mapping doc + config that matches Nooks branch identity and OTO codes. (B) Integration with nooksweb branch API when available; fallback to current data if API is unavailable.

**See:** `docs/BRANCH_MAPPING_NOOKS.md`.

---

## 2. Merchant / App Context (Which Store the Customer Is Using)

**Current:** App is effectively single-tenant (one brand).

**To implement:**

Support **merchant scoping**: the app must know which Nooks merchant (store/brand) the user is ordering from. Options:

- URL/subdomain (e.g. `brand.nooksapp.com` or `nooksapp.com/store/brand-slug`)
- Deep link / QR (e.g. `nooksapp.com/order?merchant=xxx`)
- App config (e.g. one build per merchant with `EXPO_PUBLIC_MERCHANT_ID`)

Use this merchant id (or slug) when:

- Calling any future nooksweb API for branches/menu
- Creating orders (so orders are tied to a merchant for Nooks dashboard or Foodics)
- Loading branding (logo, colors) when implemented

**Deliverable:** Documented way to “select” the current merchant (URL, link, or config) and pass it through to API calls and order creation.

**See:** `docs/MERCHANT_CONTEXT.md`.

---

## 3. Branding (Logo and Colors from Nooks)

**Current:** No merchant-specific branding; app is generic.

**To implement:**

When nooksweb exposes `app_config` (or an API) with `logo_url`, `primary_color`, `accent_color` for a merchant, ALS_draft0 should:

- Fetch that config for the current merchant (using merchant context above)
- Apply logo and colors (header, buttons, accents) for a white-labeled experience

**Deliverable:** Load and apply merchant logo and colors from Nooks (or from an API nooksweb will provide). Fallback to default branding when not set.

*(Depends on nooksweb exposing config/API.)*

---

## 4. Orders and Nooks / Foodics

**Current:** Orders are created in ALS_draft0 (Foodics or local) after payment.

**To implement:**

- **Order–merchant link:** Every order must be associated with the current merchant and branch. Store `merchant_id` and `branch_id` (or equivalent) with the order so Nooks (or a future dashboard) can show “orders for this merchant.”
- **Compatibility:** If orders go to Foodics, keep current flow. If nooksweb later adds an “orders” API or Supabase table, design so order payload (merchant, branch, items, status, delivery info) can be written there or sent via webhook without breaking existing flow.

**Deliverable:** Orders always include merchant and branch; structure ready for future Nooks dashboard or webhook.

**Nooks order API (when available):** We will **not** insert into Nooks’ `orders` table directly. Nooks will expose e.g. `POST /api/public/orders`. Payload shape they expect: `merchant_id`, `branch_id` (branch_mappings.id), `customer_id`, `total_sar`, `status`, `items` (e.g. `[{ product_id, name, quantity, price_sar }]`), optional `delivery_address`, `delivery_lat`, `delivery_lng`, `delivery_city`. See **`docs/NOOKSWEB_ANSWERS.md`**.

---

## 5. Production and Security

**To implement:**

- **Auth:** Ensure `SKIP_AUTH_FOR_DEV` (or equivalent) is **off** in production so all users go through real auth and OTP.
- **Env:** Production env for Supabase, Moyasar (live keys), OTO, Resend (OTP), Mapbox, and (if used) Foodics and Apple Pay. No dev/test keys in production.
- **Supabase:** Do not create or alter tables that Nooks uses (`merchants`, `app_config`, `foodics_connections`, `branch_mappings`, `products`, `audit_log`, `merchant-logos` bucket, or Nooks triggers). Only use `profiles`, `email_otp`, and ALS promo tables; any new tables must be clearly ALS-only (or agreed with nooksweb).

**Deliverable:** Production checklist (env, auth flags, Supabase rules) and confirmation that Nooks tables are untouched.

**See:** `docs/PRODUCTION_CHECKLIST.md`.

---

## 6. Docs and Coordination

**To implement:**

- **Docs:** Describe (1) how branch IDs/names and OTO pickup codes map between Nooks and ALS_draft0, (2) how the app determines “current merchant” and where that is used (API, orders, branding).
- **Coordination:** If we add new Supabase tables or change auth usage, note it in `docs/NOOKS_AND_SUPABASE.md` so nooksweb doesn’t break our flows.

**Deliverable:** Up-to-date mapping and merchant-context docs; schema/auth changes documented for nooksweb.

---

## Priority Order (Suggested)

1. **Production and security (Section 5)** – safe and correct in production.
2. **Branch identity alignment (Section 1, Option A)** – Nooks and ALS_draft0 agree on branches and OTO codes.
3. **Merchant context (Section 2)** – ready for multiple merchants and future APIs.
4. **Orders and merchant link (Section 4)** – every order tied to merchant and branch.
5. **Branches/menu from Nooks API (Section 1, Option B)** when nooksweb exposes it.
6. **Branding from Nooks (Section 3)** when nooksweb exposes app_config or API.
