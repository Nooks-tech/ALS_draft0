# Merchant Context – Which Store the Customer Is Using

ALS_draft0 needs to know **which Nooks merchant** (store/brand) the user is ordering from so we can scope branches, menu, orders, and (later) branding.

---

## How We Determine the Current Merchant

**Implemented (short term):**

- **App config / env:** `EXPO_PUBLIC_MERCHANT_ID` (or `extra.merchantId` in app config). Set per build when you ship one app per merchant. If unset, `merchantId` is empty (single-tenant / default).

**Planned:**

- **URL / subdomain:** e.g. `brand.nooksapp.com` or `nooksapp.com/store/brand-slug` – parse merchant from host or path (web).
- **Deep link / QR:** e.g. `nooksapp.com/order?merchant=xxx` or `alsdraft0://order?merchant=xxx` – pass merchant in query; app stores it for the session.

---

## Where Merchant Id Is Used

- **Orders:** Every order includes `merchantId` (and `branchId`) so Nooks (or a future dashboard) can show “orders for this merchant.” See `PlacedOrder` and checkout.
- **Future nooksweb API:** When we call a “branches + OTO config for merchant X” (or menu) API, we pass `merchantId`.
- **Branding:** When we load logo/colors from Nooks, we request config for `merchantId`.

---

## Code

- **Context:** `src/context/MerchantContext.tsx` – provides `merchantId` (from env/config; later extend for URL/link).
- **Usage:** `const { merchantId } = useMerchant();` wherever we need to scope by merchant (checkout, future API client, branding).

---

## Config (Expo)

In `app.config.js`, `extra.merchantId` is set from `EXPO_PUBLIC_MERCHANT_ID`. Set that env var in `.env` or in your build pipeline (e.g. EAS secrets) per merchant.

**Nooks alignment:** Use **`merchants.id`** (the UUID from Nooks’ `merchants` table) as the value for `EXPO_PUBLIC_MERCHANT_ID`. See `docs/NOOKSWEB_ANSWERS.md`.
