# Nooks branding → ALS customer app

## Flow

1. **nooksweb** saves merchant settings to Supabase `app_config` (owner-only via `/api/app-config/save`).
2. **Public API** `GET /api/public/merchants/{merchantId}/branding` returns JSON (camelCase) including:
   - `logoUrl` — in-app header logo (`logo_url`)
   - `appIconUrl` — launcher / store icon (`app_icon_url`)
   - `appIconBgColor` — hex or `"none"` (`app_icon_bg_color`)
   - `inAppLogoScale` — 20–200 (`in_app_logo_scale`)
   - `launcherIconScale` — 20–150 (`launcher_icon_scale`)
   - colors, contact fields, etc.
3. **ALS** (`MerchantBrandingContext`) fetches that URL using `EXPO_PUBLIC_NOOKS_API_BASE_URL` / `extra.nooksApiBaseUrl`, parses all fields, caches in AsyncStorage (`@als_branding_v2_*`).
4. **Menu tab** applies `inAppLogoScale` inside a **fixed 54×54** header slot (transform scale; header height does not grow).

## Apple Wallet pass logo (ALS API)

The loyalty **`.pkpass`** generator (`server/routes/walletPass.ts`) builds `logo.png` / `logo@2x.png` using the same rules as the in-app header:

- **URL**: `loyalty_config.wallet_card_logo_url` if set; otherwise **`app_config.logo_url`** (merchant dashboard “In-app logo”).
- **Scale**: **`app_config.in_app_logo_scale`** (20–200, same as nooksweb “In-app logo size”): image is fitted into Apple’s max logo slots (160×50 @1x, 320×100 @2x), then scaled and centered; overflow is clipped.

Requires **`sharp`** on the API server (`server/package.json`). If `sharp` fails to load, the pass falls back to embedding the raw image bytes (old behavior).

## Native launcher icon

The **home screen** icon is produced by **EAS build** (GitHub Actions `nooks-build.yml`): it downloads `app_icon_url`, composites `app_icon_bg_color` when not `none`, scales the logo by **`launcher_icon_scale`** (20–150%, same as the dashboard slider; previously the workflow used a fixed 75%), then copies into `assets/images/`. **Saving in the dashboard only updates Supabase**—you must **trigger a new build** (Nooks “Rebuild App” / `/api/build/trigger`) **and install** that build for the device icon to change. Android adaptive background uses `EXPO_PUBLIC_APP_ICON_BG_COLOR` from `app.config.js`.

## Troubleshooting

- If branding never updates: confirm `NOOKS_API_BASE_URL` in the built app points to **production** nooksweb.
- Clear app data or reinstall to drop old AsyncStorage cache if needed.
