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

## Native launcher icon

The **home screen** icon is produced by **EAS build** (GitHub Actions `nooks-build.yml`): it downloads `app_icon_url`, composites `app_icon_bg_color` when not `none`, then copies into `assets/images/`. Rebuild the app after changing icon/bg in the dashboard.

## Troubleshooting

- If branding never updates: confirm `NOOKS_API_BASE_URL` in the built app points to **production** nooksweb.
- Clear app data or reinstall to drop old AsyncStorage cache if needed.
