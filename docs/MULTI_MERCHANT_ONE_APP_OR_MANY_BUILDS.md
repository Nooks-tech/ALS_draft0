# How We Separate 20+ Merchants (Same Code, Different UI)

**Chosen approach: Option A (one build per merchant).** Each merchant gets their own app binary with their branding baked in at build time. No runtime link/QR for merchant identity.

You have one codebase (ALS_draft0) and many merchants; each merchant’s customers should see **that merchant’s** logo and colors. Option B (one app, many merchants via link) is documented below but not used.

---

## Option A: One build per merchant (implemented)

- **One app binary per merchant.** When a merchant pays, you trigger a build with **their** `merchant_id`, `logo_url`, `primary_color`, `accent_color` baked into that build (env vars at build time).
- **Separation:** The customer gets the **right app** by downloading the build that belongs to that merchant (e.g. unique link from nooksweb, or one Play Store listing per merchant if you go that far). Inside the app there is no “which merchant?” – that build is already for one merchant.
- **Pros:** Simple, no runtime routing, works offline once loaded.  
- **Cons:** 20 merchants = 20 builds to maintain and (if you publish to stores) 20 store listings.

So with 20 apps: **separation = which APK/IPA the user installed.** Each build has a single `EXPO_PUBLIC_MERCHANT_ID`; no mixing.

**What’s implemented for Option A:**

- **Build webhook** (`POST /build`): Nooks sends `merchant_id`, `logo_url`, `primary_color`, `accent_color`, `background_color` (optional). Server triggers GitHub Actions with these as workflow inputs.
- **Workflow** (`.github/workflows/nooks-build.yml`): Runs EAS build for Android and iOS with env: `EXPO_PUBLIC_MERCHANT_ID`, `EXPO_PUBLIC_LOGO_URL`, `EXPO_PUBLIC_PRIMARY_COLOR`, `EXPO_PUBLIC_ACCENT_COLOR`, `EXPO_PUBLIC_BACKGROUND_COLOR`. Use `use_test_builds: true` only for testing (preview APK + ios-simulator); production builds omit it.
- **App config** (`app.config.js`): Reads those env vars and exposes them in `extra` (e.g. `extra.merchantId`, `extra.logoUrl`, `extra.primaryColor`, `extra.accentColor`, `extra.backgroundColor`).
- **MerchantContext**: Uses `EXPO_PUBLIC_MERCHANT_ID` from build as the single merchant for that app (no URL override when building for Option A).
- **MerchantBrandingContext**: Uses build-time values from `extra` as initial state and fallback; if nooksweb API is configured, fetches branding and can override so the merchant can update colors without a new build.
- **Production:** For each new merchant after payment, nooksweb calls the build webhook with that merchant’s id and branding; do **not** send `use_test_builds` (or send `false`) so EAS uses the default production profile.

---

## Option B: One app for all merchants (runtime config – not used)

- **One shared app** (e.g. one APK on Play Store, one IPA on App Store, or a single “Nooks Ordering” app). Every customer installs the **same** binary.
- **Separation:** The app learns **which merchant** at runtime:
  1. **Deep link / URL:** Customer opens e.g. `nooksapp.com/order?merchant=uuid` or `yourapp://order?merchant=uuid`. The app reads `merchant` and sets it as the current merchant (you already support this in `MerchantContext`).
  2. **QR code:** Merchant prints a QR that points to that URL (with their `merchant_id`). Customer scans → app opens with that merchant.
  3. **Subdomain / path (web):** If you have a web version, e.g. `cafe-name.nooksapp.com` or `nooksapp.com/cafe-name` → resolve to a `merchant_id` and pass it when opening the app (e.g. same deep link with `?merchant=uuid`).
- **Branding (and everything else):** The app already calls **GET …/merchants/{merchantId}/branding** (and branches, promos, operations). So for the **current** `merchantId` (from the link), it fetches that merchant’s logo and colors at runtime. No need to bake them into the build.
- **Persistence:** You can store “last used merchant” (e.g. in AsyncStorage) so the next open still shows that merchant until they open a different link.

So with one app: **separation = `merchant_id` at runtime.** Same code, same binary; different merchants = different `merchant_id` → different API responses (branding, menu, branches, etc.).

---

## How the app already supports both

- **MerchantContext** (`src/context/MerchantContext.tsx`):
  - Uses **EXPO_PUBLIC_MERCHANT_ID** (build-time default).
  - If the app is opened via a **link with `?merchant=...` or `?merchant_id=...`**, it uses that as `merchantId` (and can persist it).
- **MerchantBrandingContext** (and branches, promos, operations):
  - All use **`merchantId`** to call your public APIs: branding, banners, promos, operations, branches. So different `merchantId` → different logo, colors, menu, orders.

So:
- **Option A:** Set `EXPO_PUBLIC_MERCHANT_ID` (and optionally logo/colors) per build; one build per merchant.
- **Option B:** Don’t rely on build-time merchant (or use a generic default). Send customers to the app via a **link that includes `merchant=<uuid>`**; the app then loads that merchant’s UI from your API. One build, many merchants; separation by `merchant_id` in the link and in every API call.

---

## Backend separation (same for both options)

- **All data is scoped by `merchant_id`:** Orders, branches, banners, promos, app_config, etc. have `merchant_id`. RLS and APIs filter by it.
- **Public APIs:** `GET …/merchants/{merchantId}/branding` (and banners, promos, operations, branches) return only that merchant’s data. The customer app only ever sends one `merchant_id` per session (from build or from link).

So “20 different UIs” = 20 different `merchant_id` values; the backend already separates them. The only choice is whether the app gets `merchant_id` at **build time** (one build per merchant) or at **runtime** (one app, many merchants, via link + API).

---

## Recommendation for “20 apps, same code, different UI”

- **Short term:** Keep **one build per merchant** after payment (current flow). Easiest and already done.
- **Later:** Move to **one app for all** when you don’t want to maintain many builds or many store listings:
  - Build **one** production app (no per-merchant build).
  - Each merchant gets a **unique link** (e.g. `nooksapp.com/order?merchant=<their-uuid>`) and a **QR code** to that link.
  - Customers install the single app (or open the link in the app); the app reads `merchant` from the URL and loads that merchant’s branding (and menu, etc.) from your API. Separation is by `merchant_id` everywhere.

No change to “how we separate them” in the backend – we always separate by `merchant_id`. The only difference is whether the app gets that `merchant_id` at build time (Option A) or from the link/API at runtime (Option B).

---

## Option A checklist (one build per merchant)

- [x] Build webhook accepts `merchant_id`, `logo_url`, `primary_color`, `accent_color`, `background_color`, `use_test_builds`.
- [x] Workflow passes branding env vars to both Android and iOS EAS build steps.
- [x] `app.config.js` exposes build-time branding in `extra` (merchantId, logoUrl, primaryColor, accentColor, backgroundColor).
- [x] MerchantBrandingContext uses build-time values as initial state and fallback; API fetch can override when nooksweb is configured.
- [x] MerchantContext uses `EXPO_PUBLIC_MERCHANT_ID` as the app's single merchant (Option A builds always set this).
- [ ] Nooksweb: after payment, call `POST /build` with merchant's id and branding; do not send `use_test_builds` for production.
- [ ] Deliver the built APK/IPA (or store link) to the merchant so their customers install that merchant's app only.
