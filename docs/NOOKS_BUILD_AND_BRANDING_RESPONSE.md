# ALS_draft0 response: App build automation and branding

**For:** Nooks team  
**Re:** What we need from you for app build automation (Android + iOS with merchant branding)

---

## 1. Load branding from Nooks at runtime — **Done**

We have implemented runtime branding so that **one Android and one iOS build** can serve all merchants. When the app loads (or when the merchant is identified), we fetch that merchant’s branding and apply it everywhere.

### How we get the merchant

- **Build-time:** `EXPO_PUBLIC_MERCHANT_ID` (set to Nooks `merchants.id` UUID). One build can be used for one default merchant.
- **Runtime (deep link):** We support `?merchant=<merchantId>` (and `?merchant_id=`) on the initial URL / deep link. So a single build can serve many merchants: each link or QR code includes the merchant id, and we load that merchant’s branding.

### API we call today

We call a **public** endpoint (no auth) when both are set:

- `EXPO_PUBLIC_NOOKS_API_BASE_URL` (e.g. `https://api.nooks.sa`)
- `merchantId` (from env or from the `merchant` / `merchant_id` query param)

**Current request:**

```http
GET {EXPO_PUBLIC_NOOKS_API_BASE_URL}/api/public/merchants/{merchantId}/branding
```

Example: `GET https://api.nooks.sa/api/public/merchants/550e8400-e29b-41d4-a716-446655440000/branding`

**Response shape we support (JSON):**

```json
{
  "logo_url": "https://example.com/logos/merchant-123.png",
  "primary_color": "#0D9488",
  "accent_color": "#0D9488"
}
```

- **`logo_url`** (string, optional) – Full URL to the merchant’s logo. We use it in the app header (e.g. menu screen) and anywhere else a logo is shown. If missing or null, we show no logo (or a placeholder).
- **`primary_color`** (string, optional) – Hex color (e.g. `#0D9488`). We use it for: header, bottom nav bar, primary buttons, active tab, and all “primary” UI (tabs, headers, CTAs).
- **`accent_color`** (string, optional) – Hex color. We use it for: prices, secondary buttons, links, and accents. If you only send one color, we can use the same for both; we already fallback to `primary_color` when accent is missing.

If the API is unavailable, the merchant is not found, or the response is invalid, we **fall back to our defaults** (current teal `#0D9488` for both colors, no logo). No crash, no blank screen.

We use the **`/branding`** path as agreed with Nooks.

### Where we apply branding in the app

- **Logo:** Menu header (when `logo_url` is set).
- **Primary color:** Tab bar background, menu header background, primary buttons, active category pills, checkout/pay button, order CTAs, and all former “teal” primary UI.
- **Accent color:** Prices, secondary highlights, links, and accents (we use primary for most of these if accent is not distinct).

So: **no new build per merchant is required for branding.** One Android + one iOS build, with merchant id from env or link, and branding loaded from your API at runtime.

---

## 2. Support for automated builds (Android + iOS) after payment

We recommend **Option A** and have implemented it.

### Option A – One build, many merchants (runtime config) — **Implemented**

- We produce **one** Android and **one** iOS build (e.g. via EAS).
- Each merchant is identified by:
  - **Link/QR:** URL or deep link that includes `?merchant=<merchant_id>` (or `merchant_id=`). We read this on launch and use it for the rest of the session.
  - **Default merchant:** Or build with `EXPO_PUBLIC_MERCHANT_ID=<merchant_id>` so that build is “default” for that merchant without a link param.
- The app calls your public branding API with that `merchant_id` and applies `logo_url`, `primary_color`, `accent_color` everywhere.
- So “two versions” = **one Android build + one iOS build**. “Customer details” (logo and colors) = **loaded from your API per merchant**. No new build needed when a new merchant signs up or changes their theme.

This supports your flow: wizard (theme + logo) → plans → payment → “deliver” the app by giving the merchant a link (or QR) to the **same** app with their `merchant_id` (in the link or as default for a build). No build automation per merchant is required for branding.

### Option B – Per-merchant build — **Implemented**

We have implemented the **Option B webhook** (serverless-style: our server receives the POST and triggers a **GitHub Actions** workflow that runs EAS build for Android + iOS).

- **Endpoint:** `POST /build` on our API server (same host as the rest of the ALS API).
- **Request body (JSON):** `{ "merchant_id": "uuid", "logo_url": "...", "primary_color": "#...", "accent_color": "#..." }`. Only `merchant_id` is required.
- **Optional auth:** If we set `BUILD_WEBHOOK_SECRET` on our server, Nooks can send it in the `x-nooks-secret` header.
- **Response:** `202 Accepted` with `{ "message": "Builds triggered", "merchant_id": "..." }`. The workflow runs asynchronously; build artifacts appear in the EAS dashboard.
- **What you set in Nooks:** `BUILD_SERVICE_WEBHOOK_URL=https://our-api-domain.com/build` (replace with our deployed API base URL).

**Our setup:** GitHub Actions workflow `.github/workflows/nooks-build.yml` is triggered via the GitHub API. It runs `eas build --platform android` and `eas build --platform ios` with `EXPO_PUBLIC_MERCHANT_ID`, `EXPO_PUBLIC_LOGO_URL`, `EXPO_PUBLIC_PRIMARY_COLOR`, `EXPO_PUBLIC_ACCENT_COLOR` set from the payload. You need to add **EXPO_TOKEN** in the repo’s GitHub Actions secrets. We use branch `main` by default (configurable via `GITHUB_BUILD_REF` on our server).

---

## 3. Summary table (what you asked for vs what we have)

| Item | What you need from us | Our status |
|------|------------------------|------------|
| **Branding API** | When you expose it: fetch `logo_url`, `primary_color`, `accent_color` by merchant id and apply across the app. | **Done.** We call `GET {NOOKS_API_BASE}/api/public/merchants/{merchantId}` (or we can use `.../branding` if you prefer). We apply logo in header and primary/accent colors everywhere (tabs, header, buttons, prices, etc.). Fallback to defaults if API unavailable. |
| **Two app versions** | Android + iOS. Prefer one build of each, branding at runtime; Option B = webhook for per-merchant builds. | **Option A:** One Android + one iOS build; merchant from env or `?merchant=`; branding at runtime. **Option B:** `POST /build` webhook implemented; we trigger GitHub Actions to run EAS build (Android + iOS) with payload; set `BUILD_SERVICE_WEBHOOK_URL` to our `/build` URL. |
| **Wizard preview** | No change needed on your side. | **Acknowledged.** No change required from us. |

---

## 4. What we need from you

1. **Final branding endpoint and shape**  
   When your public API is live, tell us:
   - Exact URL (e.g. `GET /api/public/merchants/:id` or `GET /api/public/merchants/:id/branding`).
   - That the response includes `logo_url`, `primary_color`, `accent_color` (or the same under different names — we can map).  
   We’ll point our app at it (we may already support your shape; see above).

2. **CORS / network**  
   The app will call this endpoint from the client (Expo). If the API is on a different domain, ensure CORS allows requests from the app (or we can move the call to our backend and proxy if you prefer).

3. **Optional: auth**  
   If you add a public token or read-only key for this endpoint, we can send it in a header. Today we assume a public, unauthenticated endpoint.

Once branding is loaded from your API, your flow (wizard → plans → payment → deliver app) can “deliver” by sharing a link to the same Android/iOS build with the merchant’s id (e.g. `https://yourapp.com/order?merchant=<uuid>` or a custom scheme), and we’ll show their logo and colors.

If you want the exact code references (file names, env vars), we can add a short “Integration checklist” section next.
