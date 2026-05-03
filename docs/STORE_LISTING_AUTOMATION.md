# Store Listing Automation — Spec (deferred)

This is the design for auto-pushing Play Store + App Store Connect listing fields per merchant. **Not implemented yet** — Internal Testing track tolerates blank listings, so it's not blocking Khrtoom or other testing-track merchants. Implement when first merchant graduates to Production track.

## Why deferred

Internal Testing track on Play Console only enforces:
- Privacy policy URL (when sensitive permissions are present)
- App Content questionnaires (target audience, ads, data safety)
- A signed AAB upload

Title, descriptions, screenshots, feature graphic — all optional for Internal Testing. Play Store shows `<package_name> (unreviewed)` until they're filled.

TestFlight on App Store Connect has the same property — App Store listing fields are required for App Store submission, not for TestFlight distribution.

Building the automation now means writing Play Developer API + ASC API integrations against accounts that aren't ready to receive them. Better to wait until Khrtoom is approved for Production, where we can test against a real listing without burning a sandbox app.

## What goes per merchant

These pull straight from Supabase (`merchants` joined with `app_config`):

| Field | Source column | Play Store target | ASC target |
|---|---|---|---|
| App title | `app_config.app_name` or `merchants.cafe_name` | `listings.{lang}.title` (max 30 chars) | `appInfoLocalizations.name` (max 30 chars) |
| Short description | template + brand name | `listings.{lang}.shortDescription` (max 80) | `appStoreVersionLocalizations.promotionalText` (max 170) |
| Full description | template + about_text | `listings.{lang}.fullDescription` (max 4000) | `appStoreVersionLocalizations.description` (max 4000) |
| Contact email | `app_config.contact_email` | `details.contactEmail` | (manual via App Information) |
| Privacy policy URL | `https://nooks.space/m/{slug}/privacy` | `App content` form (not API) | `appInfoLocalizations.privacyPolicyUrl` |
| Default language | `merchants.default_language` (or hardcode `ar-SA`) | `details.defaultLanguage` | (set during app creation) |

**Skipped (visual assets):**
- Play Store icon (512×512) — auto-generate from `app_config.app_icon_url`
- Feature graphic (1024×500) — needs design template
- Phone screenshots (8 frames per locale) — needs design template
- Same for App Store

## Architecture

### `scripts/configure-store-listings.mjs`

```js
// Inputs (env):
//   MERCHANT_ID                    UUID
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   PLAY_SA_JSON_PATH              Path to Google Play SA JSON
//   ASC_API_KEY_ID / _ISSUER / _PATH
//   COMMIT                         "true" to actually push; default = dry-run
// Args:
//   --platform=android|ios|both    (default: both)
//   --merchant-id=<uuid>           (or via env)

// Flow:
//   1. Fetch merchant + app_config from Supabase
//   2. Build listing payload (title, descriptions, contact info)
//   3. If platform includes android:
//      - Get OAuth access token from Play SA JSON (scope: androidpublisher)
//      - POST edits, PUT details, PUT listings, POST :commit
//   4. If platform includes ios:
//      - Generate JWT from ASC API key
//      - GET /v1/apps?filter[bundleId], GET appInfos, GET localizations
//      - PATCH appInfoLocalizations + appStoreVersionLocalizations
//   5. Report per-platform success/fail
```

### `.github/workflows/configure-store-listings.yml`

Triggered:
- Manually via `workflow_dispatch` per merchant
- Or wired into `nooks-build.yml` to run after `eas submit` succeeds (so listing always reflects latest merchant config)

### Description templates

**Short** (≤80 chars), Arabic + English variants:
- AR: `اطلب من {brand} واكسب نقاط ولاء وتابع طلبك في الوقت الفعلي.`
- EN: `Order from {brand}, earn loyalty points, track delivery in real time.`

**Full** (≤4000 chars), Arabic + English variants:
```
{brand} — Order online from your favorite cafe.

✓ Order pickup or delivery
✓ Earn loyalty points on every order
✓ Track your driver in real time
✓ Save favorite items for one-tap reorder
✓ Apple Pay and Mada supported

{about_text — if merchant filled it in nooksweb}

{contact_phone if present}
```

The template lives in `scripts/store-listing-templates.mjs`. Localized strings + slot fills.

## Authentication

**Google Play Developer API:**
- Scope: `https://www.googleapis.com/auth/androidpublisher`
- Auth: OAuth2 access token from `fastlane/google-service-account.json` (already exists)
- Permission: SA needs **Edit store listing** in Play Console → API access → app permissions (currently grants Release manager only — we'd need to add this)

**App Store Connect API:**
- Auth: JWT signed with `.p8` key (already in build pipeline as `ASC_API_KEY_P8_BASE64`)
- Endpoints under `https://api.appstoreconnect.apple.com/v1/`

## What changes when implemented

1. Update Play Console SA permissions: add **Edit store listing** to each merchant app
2. New script: `scripts/configure-store-listings.mjs`
3. New script: `scripts/store-listing-templates.mjs`
4. New workflow: `.github/workflows/configure-store-listings.yml`
5. Optional: add a step to `nooks-build.yml` that runs the script after `eas submit`

## Testing plan (when implemented)

1. Run with `--platform=android --commit=false` (dry-run) → verify payload looks right
2. Run with `--platform=android --commit=true` against Khrtoom → check Play Console reflects changes
3. Same for iOS with a TestFlight-only app
4. Run for all merchants in batch
5. Wire into post-submit step in `nooks-build.yml`

## Estimated effort

- Play Store integration: ~3 hours (clear API)
- ASC integration: ~3 hours (more complex resource graph)
- Templates + tests: ~2 hours
- Workflow: ~1 hour
- Total: ~9 hours, one focused day

## When to revisit

When you onboard a merchant who's ready for Production track (not Internal Testing). Likely when Khrtoom validates internally and you want to publish them publicly.
