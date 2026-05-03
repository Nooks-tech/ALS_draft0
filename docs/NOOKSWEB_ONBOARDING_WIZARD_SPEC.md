# Nooksweb Onboarding Wizard — Implementation Spec

**Audience**: the nooksweb codebase agent / developer.

**Purpose**: a checklist UI inside the nooksweb operator dashboard that walks Abdullah (operator) through the per-merchant manual setup steps that Google and Apple deliberately don't expose via API. Eliminates context-switching and remembered-state during merchant onboarding. The merchant themselves never sees this — it's an operator tool only.

## Why this exists

Onboarding a new merchant currently requires ~15 minutes of clicks across four consoles (Play Console, App Store Connect, Firebase, Expo) with values that the operator has to remember and paste correctly. The mobile-app build pipeline already automates everything that CAN be automated — what's left is steps Google/Apple deliberately keep gated by human acknowledgement. This wizard makes those steps fast and unambiguous.

## Where it lives

- Route: `/dashboard/admin/onboarding/[merchant-slug]`
- Visibility: only to users with `role = 'admin'` (or whatever Nooks's super-admin role is). Regular merchant users never see this.
- Sidebar entry: under an "Admin" section that only renders for admins.

## State model

New table: `public.merchant_onboarding_state`

```sql
create table public.merchant_onboarding_state (
  merchant_id uuid primary key references merchants(id) on delete cascade,

  play_app_created_at timestamptz,
  play_sa_granted_at timestamptz,
  play_privacy_set_at timestamptz,
  play_app_content_done_at timestamptz,
  play_first_aab_uploaded_at timestamptz,

  asc_bundle_registered_at timestamptz,
  asc_app_created_at timestamptz,
  asc_privacy_form_done_at timestamptz,
  asc_first_ipa_uploaded_at timestamptz,

  firebase_app_registered_at timestamptz,
  google_services_committed_at timestamptz,

  notes text,
  updated_at timestamptz not null default now()
);

create index on merchant_onboarding_state (merchant_id);
```

Each step's `*_at` timestamp tracks completion. Null = not done. Allows partial onboardings to resume.

## Per-merchant prefilled values

When the wizard loads, it joins `merchants` + `app_config` and computes:

```ts
const wizardData = {
  merchantId: merchant.id,
  slug: merchant.slug ?? slugify(merchant.cafe_name),
  brandName: appConfig.app_name ?? merchant.cafe_name,
  packageName: appConfig.android_package_id ?? `sa.nooks.${slug}`,
  bundleId: appConfig.ios_bundle_id ?? `sa.nooks.${slug}`,
  privacyUrl: `https://nooks.space/m/${slug}/privacy`,
  termsUrl: `https://nooks.space/m/${slug}/terms`,
  supportUrl: `https://nooks.space/m/${slug}/support`,
  contactEmail: appConfig.contact_email,
  description: deriveDescription(merchant),
  iconUrl: appConfig.app_icon_url,
};
```

These are passed to every step's UI.

## Checklist structure

11 steps grouped into 4 sections. Each step renders as a row with:

- Status icon (◯ todo / ⏳ in-progress-waiting / ✓ done / ✗ blocked-with-error)
- Title (single sentence)
- Body (collapsed by default; expands to show prefilled values + deep link + help)
- Primary action button (e.g., "Open Play Console")
- Confirmation button (e.g., "I've created the app")

### Section: Google Play

1. **Create app in Play Console**
   - Deep link: `https://play.google.com/console/u/0/developers/{playDevId}/app-list?action=create`
   - Show: brand name to use, default language (Arabic recommended), confirm declarations
   - Confirm: "I've created the app entry"
   - Auto-verify: poll `androidpublisher.applications.get(packageName)` — 200 = exists. Auto-completes the row when detected.

2. **Grant SA Release-manager permission on Khrtoom app**
   - Deep link: app's API access page
   - Show: SA email (`nooks-eas-publisher@eas-nooks.iam.gserviceaccount.com`) with copy-button
   - Confirm: "Granted"
   - Auto-verify: `androidpublisher.edits.insert(packageName)` — succeeds = permission OK. Polls every 10s up to 5 min.

3. **Set privacy policy URL**
   - Deep link: app's App Content → Privacy policy
   - Show: copy button with `wizardData.privacyUrl` already in clipboard
   - Confirm: "Saved"
   - Auto-verify: same as step 2 — once we can `.get()` app details and see privacyPolicy populated.

4. **Fill App Content forms** (Target audience, Data safety, Content rating, Ads)
   - Deep links: each sub-form
   - Pre-filled answers: ship Nooks-default JSON snippets the operator can paste into each form (data safety especially)
   - Confirm per sub-form, then mark step done

5. **First AAB upload (manual, one-time)**
   - Wait state: poll Play API for the first release on Internal Testing track. When seen, auto-complete.
   - If wait > 30 min, show fallback: download AAB from EAS + drag-and-drop instructions.

### Section: App Store Connect

6. **Register bundle ID in Apple Developer Portal**
   - Deep link: `https://developer.apple.com/account/resources/identifiers/add/bundleId`
   - Show: bundle ID + "Apple Pay" capability + Apple Pay merchant ID (from `app_config`)
   - Confirm + auto-verify via ASC API: `GET /v1/bundleIds?filter[identifier]={bundleId}`

7. **Create app record in App Store Connect**
   - Deep link: `https://appstoreconnect.apple.com/apps/new`
   - Show: brand name, bundle ID (must match step 6), SKU = merchantId, primary language
   - Confirm + auto-verify: `GET /v1/apps?filter[bundleId]={bundleId}` returns 1+ result

8. **App Privacy form**
   - Deep link: app's App Privacy section in ASC
   - Pre-filled answers: Nooks-defaults (collects name, email, location for app functionality; no third-party tracking)
   - Confirm

### Section: Firebase

9. **Register Android app in Firebase**
   - Deep link: `https://console.firebase.google.com/u/0/project/nooks-push/settings/general/android:add`
   - Show: package name to enter (with copy button)
   - Confirm + auto-verify: ideally call Firebase Management API to verify; failing that, just trust the operator

10. **Download + commit `google-services.json`**
    - Show: download button + git command to commit (or have nooksweb commit via GitHub API on behalf of operator)
    - Confirm: "Committed and pushed"
    - Auto-verify: GitHub API `GET /repos/Nooks-tech/ALS_draft0/contents/google-services.json` → check that the response includes a `client` entry for the merchant's package

### Section: Final activation

11. **Trigger first build**
    - Button: "Build now" — calls existing nooks ops trigger endpoint with all merchant inputs
    - Wait state until build success notification arrives
    - On success: mark `play_first_aab_uploaded_at` and `asc_first_ipa_uploaded_at` together

After step 11 completes: green banner "Khrtoom is fully onboarded. Future updates and builds need no manual steps. ✓"

## Resumable state

If the operator refreshes mid-onboarding, the wizard reads `merchant_onboarding_state` and renders each row's status. They pick up exactly where they left off.

## Auto-verification approach

For steps where Google/Apple's API can verify completion:
- After the operator clicks "I've done this", the wizard polls every 10s for up to 5 minutes
- On success: auto-mark done (timestamp + ✓ icon)
- On timeout: show error "Couldn't verify — proceed manually if you're sure it's done. [Mark done] [Retry]"

For steps with no API (App Content forms, App Privacy form): trust the operator's confirmation.

## Out-of-scope (use existing automation)

The wizard does NOT do these — they're already automated by the mobile-app build pipeline:
- Set EAS Update channel per merchant
- Patch app.json bundle/package per merchant
- Provision iOS profile for new bundle
- Mint upload keystore (EAS handles)
- Link APNs key per bundle (`scripts/link-expo-push-key.mjs`)
- Link FCM SA key per package (`scripts/link-fcm-credentials.mjs`)
- Build + sign + submit per merchant
- Push EAS Update per merchant (`.github/workflows/eas-update-broadcast.yml`)

The wizard ONLY covers the human-acknowledgement gates Google/Apple expose. Once those gates are passed, the build pipeline takes over.

## Dependencies

- Operator must have:
  - Admin-role login on nooksweb
  - Existing OAuth/SSO into Google Play Console (browser session is sufficient — wizard doesn't manipulate credentials)
  - Existing OAuth into Apple Developer + ASC
  - Existing Firebase Console session
  - Existing GitHub session for the commit step (or wizard could use a GitHub App to commit on operator's behalf)

## API endpoints needed in nooksweb backend

- `GET /api/admin/onboarding/[merchantId]` — load wizard state + prefilled data
- `POST /api/admin/onboarding/[merchantId]/step/[stepKey]/confirm` — operator clicks Confirm
- `POST /api/admin/onboarding/[merchantId]/step/[stepKey]/verify` — server-side polling check (proxies to Play / ASC / Firebase / GitHub APIs)
- `POST /api/admin/onboarding/[merchantId]/notes` — operator can leave notes per merchant

## Estimated effort

- DB migration + model: 1 hr
- API endpoints: 4 hrs
- Verification logic per step (Play, ASC, Firebase, GitHub APIs): 6 hrs
- React UI (checklist, deep links, copy buttons, polling): 6 hrs
- QA across full flow with one test merchant: 2 hrs
- Total: ~2-3 days for a focused implementation

## Future extension

Once this exists, the SAME pattern can power a self-service merchant signup flow where the merchant themselves does the account setup — but that requires them to have their own Google Play Console developer account ($25 one-time), Apple Developer account ($99/year), and Firebase access. The current Nooks model has all merchants under your developer accounts, so the operator-only wizard is correct for now.
