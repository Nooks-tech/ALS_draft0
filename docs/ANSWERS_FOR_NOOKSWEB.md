# Answers for nooksweb (from ALS_draft0)

Use this when nooksweb asks about customer identity, order status, branch id, product id, promos, merchant selection, OTO, or auth. Paste or link this in the nooksweb chat.

---

## 1. Customer identity in orders

We use **one** of the following as `customer_id`, in this order of preference:

1. **Supabase `auth.users.id`** (UUID) – when the user is logged in via Supabase Auth.
2. **Profile phone** – when we have a profile and no auth user (e.g. after OTP-only flow).
3. **Profile full name** – fallback.
4. **`"guest"`** – when none of the above (e.g. auth bypass for dev).

**In code:** `customerId = user?.id ?? profile?.phone ?? profile?.full_name ?? 'guest'` (see `app/checkout.tsx`).

**Recommendation:** Store it in `orders.customer_id` as-is. For support or linking, treat UUID as Supabase auth user id; other values as phone/name/guest. We can standardise later on “always send auth id when available” if you prefer.

---

## 2. Order status: who updates, and where?

**Today:** We store and update order status **only in ALS_draft0** (in-memory / local state in `OrdersContext`). We do **not** push status updates to Nooks.

**Statuses we use:** Preparing, Ready, Out for delivery, Delivered, Cancelled.

**Going forward:** We’re happy to **push** status updates to Nooks when you expose an endpoint (e.g. `PATCH /api/public/orders/:id` with `{ status }`), so the merchant dashboard can show live status. We’d need agreed format and auth. If you prefer a webhook from you to us, we can support that too (e.g. you update order in your DB and notify us so we refresh). Until then, status stays only in our app.

---

## 3. Branch id when sending orders

**Today:** We send **our own** branch identifier: the `branchId` we use in the app (e.g. `madinah-1`, `riyadh-1` from `branchOtoConfig`, or a Foodics branch id when menu/branches come from Foodics). We do **not** yet have Nooks’ `branch_mappings.id` (UUID).

**When you expose a branches API:** We will load branches from you (including `id` = `branch_mappings.id` and `oto_warehouse_id`) and send that **`id`** (UUID) as `branch_id` in the order payload so you can store orders correctly without a mapping on your side.

**Mapping today:** If your order API accepts only Nooks branch UUIDs, we need either (a) you to accept our branch id and map it on your side (e.g. by name or a mapping table), or (b) we keep sending our id until the branches API exists and we switch to sending your UUID. We prefer (b): once we have the branches API we’ll send `branch_mappings.id` only.

---

## 4. Product / item id in order items

**Today:** We send **our own** product id: the `id` from our menu item (which is either from the Foodics product when we use Foodics, or from local `src/data/menu.ts`). Each order item has `product_id`, `name`, `quantity`, `price_sar`.

**When you expose menu/products:** We can switch to sending your `products.id` (UUID) or `foodics_product_id` so you can link `orders.items` back to `products` consistently. Until then we’ll send our current id (and name, quantity, price_sar) so you can store items as-is.

---

## 5. Promo codes: whose table?

We validate promos against **a Supabase table named `promo_codes`** with columns we use: `code`, `type`, `value`, `name`, `active`, `max_uses`, `uses_count`, `valid_from`, `valid_until`. We do a single-row lookup by `code` (case-insensitive) and `active = true`, then apply type/value and date/usage checks.

- If that table is **Nooks’ `promo_codes`:** We need **read-only** access (e.g. RLS or a read-only view). We won’t change the table. If Nooks scopes promos by merchant, we need to be able to read by merchant (we have `merchantId` in the app).
- If Nooks’ schema or table name differs: We can either (a) use a **separate ALS table** (e.g. `als_promo_codes`) so we don’t touch yours, or (b) use a **view** you provide that matches the shape we expect. We’re fine either way; we just need one source we can read from.

We also have a **hardcoded fallback** when Supabase isn’t configured (dev/demo); that doesn’t affect your DB.

---

## 6. How does the customer choose the merchant?

**Implemented:** **Build-time config** – we use **`EXPO_PUBLIC_MERCHANT_ID`** (set to Nooks’ **`merchants.id`** UUID). One build per merchant (e.g. different env in EAS or per-store build).

**Planned (not built yet):** URL/subdomain or deep link / QR (e.g. `nooksapp.com/order?merchant=xxx`) so one app can serve multiple merchants. When we add that, we’ll still send the same `merchant_id` (UUID) in API calls and order payloads.

So for your public API (branches, menu, branding), you can assume we pass **`merchants.id`** (UUID) as the merchant identifier.

---

## 7. Branding in Nooks – who sets logo and colors

**In Nooks:** The **merchant** (cafe/shop owner) sets their own branding:

- **Logo:** Uploaded in the onboarding wizard (first-time setup) and editable later in Settings.
- **Colors:** Primary and accent colors are chosen in the same wizard and stored in Nooks; they can be updated in Settings.

So logo and colors are **per merchant** and **chosen by the merchant in the Nooks dashboard**, not by Nooks or by the end-customer.

**In the customer app (ALS_draft0):** When we get branding from your API (e.g. `logo_url`, `primary_color`, `accent_color` per merchant), we **use those values as-is** so the app is white-labeled for that merchant. We do **not** let end-customers pick or override colors; the merchant has already done that in Nooks.

---

## 8. OTO pickup locations: single source of truth?

**Today:** We have our **own** setup: we use codes like `NOOKS-MADINAH-01`, `NOOKS-RIYADH-01` in `branchOtoConfig.ts` and we have a script `server/scripts/oto-pickup-setup.ts` that creates/updates those pickup locations in OTO. So we’re not *only* using locations created from Nooks.

**Target state:** We want **Nooks to be the source of truth**. When you expose a branches API that includes **`oto_warehouse_id`** (from `branch_mappings.oto_warehouse_id`), we will use that and **stop hardcoding** pickup codes. We’ll take `oto_warehouse_id` from the branch list per merchant and use it for OTO request-delivery. We won’t create duplicate OTO pickup locations for the same branch; we’ll rely on the codes you store after “Map OTO Warehouse” in Nooks.

**Alignment:** Until the branches API exists, we’ll keep our current config. When it exists, we’ll migrate to using your codes only (and can deprecate our script for those branches).

---

## 9. Auth: same Supabase project, different flows

**Do our customers log in as Supabase auth users?**  
**Yes.** We use **Supabase Auth** (email + password): `signInWithPassword`, `signUp`, `signOut`. So customers are in **`auth.users`** and have a session. We do **not** do OTP-only without creating a Supabase user; our email_otp flow is for an extra verification step (e.g. 6-digit code sent via Resend and stored in `email_otp`), but the account is still a normal Supabase auth user.

**Same email as merchant and customer?**  
We don’t treat “merchant” vs “customer” in auth. If the same email signs up in Nooks (as merchant) and in ALS_draft0 (as customer), they’re the **same** row in `auth.users`. We’re fine with that: one person can be both. For RLS and “current user” semantics, you can assume: same `auth.uid()` for that email in both products; Nooks can restrict dashboard access by “is this user linked to a merchant?” and we restrict customer app by “is this user logged in?”. We don’t need separate users for the same email.

---

## 10. Build webhook URL (Option B – per-merchant builds)

After we deploy our API, we’ll give you the base URL. Set in your env:

```bash
BUILD_SERVICE_WEBHOOK_URL=https://<our-api-host>/build
```

Example: `https://als-api.railway.app/build`. Replace with our actual host.

We’ll tell you the URL when the server is live. If we set a shared secret, we’ll send it to you; send it in the **`x-nooks-secret`** header on every `POST /build` request.

---

## 11. Operations API (store status, prep time, delivery mode)

We call **`GET {NOOKS_BASE}/api/public/merchants/{merchantId}/operations`** and expect:

- **store_status** – `open` | `busy` | `closed` (we reflect in the app, e.g. disable ordering when closed).
- **prep_time_minutes** – number (we use for estimated ready time).
- **delivery_mode** – `delivery_and_pickup` | `pickup_only` (we show or hide delivery accordingly).

We poll this when the app is in the merchant flow (or will use Supabase Realtime on `app_config` when you expose it). See `src/api/nooksOperations.ts` and `docs/MESSAGE_FROM_NOOKS_AND_ALS_RESPONSE.md`.

---

## Summary table

| Topic | ALS_draft0 answer |
|-------|-------------------|
| **customer_id** | Prefer `auth.users.id` (UUID); fallback: profile phone → full name → `"guest"`. |
| **Order status** | Stored only in our app today; we can push updates when you expose PATCH or webhook. |
| **branch_id** | Today: our id (e.g. `madinah-1`). After branches API: your `branch_mappings.id` (UUID). |
| **product_id in items** | Today: our/Foodics product id. After menu API: can send your `products.id` or `foodics_product_id`. |
| **Promos** | We read Supabase `promo_codes` (code, type, value, name, active, …). Need read access; if that’s your table, RLS or view by merchant is fine. |
| **Merchant choice** | Build-time: `EXPO_PUBLIC_MERCHANT_ID` = `merchants.id`. Later: URL/deep link possible. |
| **OTO pickup** | We want Nooks as source of truth; we’ll use `oto_warehouse_id` from your branches API when available. |
| **Auth** | Same `auth.users`; same email can be merchant and customer (one user). |
| **Branding** | Set by merchant in Nooks (onboarding + Settings). We consume it via API and apply it in the app; no customer color picker. |
| **Build webhook** | Set `BUILD_SERVICE_WEBHOOK_URL=https://<our-api-host>/build`; we’ll provide the host when deployed. Optional: send `x-nooks-secret` if we agree a secret. |
| **Operations** | We call `GET …/merchants/{id}/operations` for store_status, prep_time_minutes, delivery_mode; we poll (or Realtime) so the app reflects dashboard changes. |

If you need more detail on any point (e.g. exact column names for promos, or order payload shape), say which section and we can narrow it down.
