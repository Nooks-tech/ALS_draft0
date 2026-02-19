# Answers for ALS_draft0 (from nooksweb)

Use this when working on branch identity, OTO, merchant id, API plans, branding, orders, or Supabase. Source: nooksweb agent.

---

## 1. Branch identity and OTO

### Exact schema of `branch_mappings`

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid | Nooks primary key (generated). Use this for a stable Nooks-side branch id. |
| `merchant_id` | uuid | FK to `merchants.id`. |
| `foodics_branch_id` | text | Foodics' branch id; set when we sync from Foodics. Not null. |
| `name` | text | Display name (e.g. "Nooks Madinah – Central"). |
| `latitude` | numeric | For map and OTO. |
| `longitude` | numeric | For map and OTO. |
| `manager_phone` | text | Used when creating OTO pickup location. |
| `oto_warehouse_id` | text | **OTO pickup location code** (e.g. `NOOKS-MADINAH-01`, or `nooks-<uuid-prefix>` from Map OTO Warehouse flow). |
| `verified` | boolean | Whether branch has coords + manager phone (and optionally OTO mapped). |
| `created_at`, `updated_at` | timestamptz | |

Unique constraint: `(merchant_id, foodics_branch_id)`.

### Does Nooks store the OTO pickup location code per branch?

**Yes.** It's in **`branch_mappings.oto_warehouse_id`** (text). Use this field as the OTO pickup location code for that branch.

### IDs/names from Foodics or Nooks?

- **From Foodics:** When Foodics is connected, Nooks syncs and sets **`foodics_branch_id`** and **`name`** from Foodics.
- **Nooks' own id:** **`branch_mappings.id`** is always a Nooks-generated UUID.
- **Summary:** Use **`branch_mappings.id`** as the stable Nooks branch id. Use **`foodics_branch_id`** when matching Foodics. Use **`oto_warehouse_id`** for OTO pickup location code.

---

## 2. Merchant identity

- **Primary identifier:** **`merchants.id`** (UUID). No slug today.
- **Table:** `merchants` has `id`, `user_id` (auth), `full_name`, `cafe_name`, `status` (`pending` | `active` | `suspended`), `created_at`, `updated_at`.

**For ALS_draft0:** Use **`merchants.id`** (the UUID) as `EXPO_PUBLIC_MERCHANT_ID` and for any API calls or order payloads.

---

## 3. Future branches/menu API

- **Not implemented yet.** Plan when added:
  - **Endpoint:** e.g. `GET /api/public/merchants/[merchantId]/branches` (or Supabase view + RLS).
  - **Response (branches):** array of `{ id, merchant_id, foodics_branch_id, name, latitude, longitude, oto_warehouse_id, verified }`. No `manager_phone` publicly.
  - **Auth:** Public for given merchant id, or read-only API key / Supabase anon + RLS.
- **Menu:** If exposed, same merchant-scoped pattern; `products` has merchant_id, foodics_product_id, name, price, image_url, is_hidden. Shape TBD.

---

## 4. Branding (`app_config`)

- **Not exposed via API yet.** When we do, merchant-scoped.
- **DB fields (for when exposed):** `logo_url` (text), `primary_color` (text, e.g. `#000000`), `accent_color` (text, e.g. `#3b82f6`).

---

## 5. Orders

**Nooks has an `orders` table.** Schema:

| Column | Type | Notes |
|--------|------|--------|
| `id` | uuid | PK. |
| `merchant_id` | uuid | FK to `merchants.id`. |
| `customer_id` | text | e.g. Supabase user id or email. |
| `total_sar` | numeric | Order total (SAR). |
| `status` | text | Default `'pending'`. |
| `items` | jsonb | Default `'[]'`. |
| `created_at`, `updated_at` | timestamptz | |

**RLS:** Merchants can read own orders. **No insert policy** for customer app/anon. **Do not insert directly** from ALS_draft0.

**Preferred:** Nooks will provide **`POST /api/public/orders`** (or similar) to accept payload and insert with service role. We'll use that when available.

**Payload shape Nooks expects (when API exists):**

- `merchant_id` (uuid) – required
- `branch_id` (uuid) – `branch_mappings.id` (column may be added)
- `customer_id` (text) – our customer reference (e.g. Supabase auth user id)
- `total_sar` (number)
- `status` (string) – e.g. `pending`, `preparing`, `ready`, `out_for_delivery`, `delivered`, `cancelled`
- `items` (array) – e.g. `[{ product_id, name, quantity, price_sar }]`
- Delivery (optional): `delivery_address`, `delivery_lat`, `delivery_lng`, `delivery_city`

Until then, ALS_draft0 keeps creating orders in its own flow (local state / Foodics). When Nooks exposes the API, we'll switch to that and document the exact shape and auth.

---

## 6. Supabase – tables/triggers not to modify

**Nooks-owned (do not modify from ALS_draft0):**

- `merchants`
- `app_config`
- `foodics_connections`
- `branch_mappings`
- `products`
- `orders` (write via Nooks API when available, not direct insert)
- `audit_log`
- `banners`
- `promo_codes` (Nooks may manage; we can read for validation; don't change schema without agreeing)
- Storage: `merchant-logos`
- Any Nooks triggers (e.g. create merchant on signup)

**Read-only view:** Nooks is okay with ALS_draft0 having read-only access to a view they create (e.g. branches for merchant). Writes go through Nooks APIs only.

---

## Summary for ALS_draft0

| Topic | Action |
|-------|--------|
| **Branch id** | Use `branch_mappings.id` (uuid) as Nooks branch id; OTO code = `branch_mappings.oto_warehouse_id`. |
| **Merchant id** | Use `merchants.id` (uuid) for `EXPO_PUBLIC_MERCHANT_ID` and all API/payloads. |
| **Branches/menu API** | Not built yet; use endpoint/view when Nooks documents it. |
| **Branding** | `logo_url`, `primary_color`, `accent_color` in `app_config`; use when exposed via API. |
| **Orders** | Do **not** insert into Nooks `orders` table. Use Nooks POST order API when they expose it; payload shape above. |
| **Supabase** | Don't modify listed Nooks tables or triggers; read-only view for branches (when added) is fine. |
