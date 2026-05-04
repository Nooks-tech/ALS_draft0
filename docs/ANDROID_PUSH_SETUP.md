# Android Push Notifications Setup

End-to-end setup so push notifications actually deliver on Android. Without this, Expo Push Service silently drops every Android push (the iPhone 12 mini works because iOS has its own pipeline through APNs that's already configured).

## Why Android pushes need extra setup

Push delivery on Android goes through Firebase Cloud Messaging (FCM). Two ingredients are required:

1. **Client-side** — the Android app needs `google-services.json` baked into the AAB so the Firebase SDK on the device can register an FCM token for the user. Without this, no token is ever generated → server has nothing to send to.
2. **Server-side** — Expo's Push Service needs the **FCM v1 service-account JSON** uploaded to its credentials store so it can authenticate with Google when forwarding pushes. Google deprecated the legacy FCM HTTP API in 2024; FCM v1 is the only path now.

iOS doesn't need any of this because Apple uses APNs, and that link is already wired by `scripts/link-expo-push-key.mjs`.

## One-time Firebase project setup

Done once for the entire Nooks app, reused for every merchant.

### 1. Create the Firebase project

1. Open <https://console.firebase.google.com>.
2. **Add project** → name it `nooks-push` (or pick anything — the name is internal).
3. Skip Google Analytics (not needed for FCM).
4. Wait for project creation, click **Continue**.

### 2. Generate the FCM v1 service-account JSON

1. Inside the project → ⚙️ **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → **Generate key**. A JSON downloads.
3. Save it somewhere secure (e.g. `~/keys/nooks-fcm-service-account.json`).

This single JSON has project-level access — it works for every merchant Android app you'll later register inside this Firebase project.

### 3. Add the SA JSON to GitHub secrets (enables auto-link)

Convert the JSON to base64 and store it as `GOOGLE_FCM_SERVICE_ACCOUNT_JSON_BASE64`:

```powershell
# Windows PowerShell
$b = [IO.File]::ReadAllBytes("$HOME\Downloads\nooks-push-firebase-adminsdk-*.json")
[Convert]::ToBase64String($b) | Set-Clipboard
```

Paste the clipboard value into a new repo secret at <https://github.com/Nooks-tech/ALS_draft0/settings/secrets/actions/new>:
- Name: `GOOGLE_FCM_SERVICE_ACCOUNT_JSON_BASE64`
- Value: the base64 string from clipboard

Once this is set, `scripts/link-fcm-credentials.mjs` runs on every Android build and idempotently links the SA key to each merchant's package on Expo's side. No more manual upload per merchant.

## Per-merchant onboarding (5 min, manual)

You repeat these steps once for each new merchant. Same as the Play Console / App Store Connect manual steps — Google deliberately doesn't expose APIs to fully automate these.

### 1. Register the merchant's Android package as a Firebase Android app

1. Inside `nooks-push` → click the gear → **Project settings** → **Your apps** section.
2. Click the Android icon (or **Add app → Android** if no apps yet).
3. **Android package name**: enter the merchant's exact package, e.g. `sa.nooks.khrtoom` (must match the `android_package_id` you pass to `nooks-build.yml`).
4. **App nickname**: anything, e.g. `Khrtoom Android`.
5. Skip the SHA-1 (not needed for FCM).
6. Click **Register app**.

### 2. Download the merged `google-services.json`

1. After registration, Firebase shows a download button for `google-services.json`. Download it.
2. **Important**: replace the file at the repo root: `C:\Users\abdul\ALS_draft0\google-services.json`. The downloaded file contains a `client` entry for every Android app currently registered in `nooks-push`, so it grows as you onboard more merchants — always re-download from Firebase rather than hand-editing.
3. Commit it: `git add google-services.json && git commit -m "chore(fcm): add <merchant-slug> to google-services.json"`.

`google-services.json` is **client config**, not a secret. Firebase explicitly considers it public; it's safe to commit. Keys inside it (`current_key`) are restrictable in the Cloud Console if you ever need stricter scoping.

### 3. Upload the FCM v1 service-account JSON to Expo

**Automated (preferred)**: once the `GOOGLE_FCM_SERVICE_ACCOUNT_JSON_BASE64` GitHub secret is set (see one-time setup section), every Android build runs `scripts/link-fcm-credentials.mjs`, which:
- Finds or uploads the SA JSON to Expo (deduped by the JSON's `private_key_id`)
- Finds or creates AndroidAppCredentials for the merchant's package
- Links the SA key as the FCM v1 sender

The script is idempotent — re-runs are no-ops once linked. Fail-open — if Expo's GraphQL schema shifts the script logs a warning and exits 0 so the build still ships, and you fall back to the manual flow below.

**Manual fallback (if the script logs a warning)**:

1. Open the Expo credentials page for this Android package:
   ```
   https://expo.dev/accounts/abdullah_alsaedi/projects/Nooks/credentials/android/<package-name>
   ```
   For Khrtoom: <https://expo.dev/accounts/abdullah_alsaedi/projects/Nooks/credentials/android/sa.nooks.khrtoom>
2. Find the **FCM V1 service account key** section.
3. Click **Add a service account key** → upload the JSON you generated in the one-time setup step above (`nooks-fcm-service-account.json`). The same file works for every merchant package.
4. Verify it shows the key's email address (e.g. `firebase-adminsdk-…@nooks-push.iam.gserviceaccount.com`) once uploaded.

### 4. Trigger a fresh build

The build pipeline now includes `google-services.json` in the AAB (because `app.config.js` references it when present). After the build lands:

1. Install the new build on a test device.
2. Open the app, sign in.
3. The app calls `getExpoPushTokenAsync()` → Firebase SDK issues a real FCM token → token gets registered with your server.
4. Send a test push from the dashboard's Marketing tab.

## Verification checklist

After completing setup for a merchant, confirm all four:

- [ ] Firebase project `nooks-push` has the merchant's Android package listed under "Your apps."
- [ ] `google-services.json` at repo root contains a `client_info.android_client_info.package_name` matching the merchant's package.
- [ ] Expo credentials page for the merchant package shows a green "FCM V1 service account key" entry.
- [ ] Test push from the dashboard delivers to a fresh install on a real Android device or Google Play emulator.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Test push returns `MessagingError` / `InvalidCredentials` | FCM SA JSON not uploaded for this package | Step 3 above |
| Test push returns `DeviceNotRegistered` | Token expired or app uninstalled | User reinstalls |
| Build fails: "No matching client found for package name 'sa.nooks.X'" | `google-services.json` doesn't contain that merchant's package | Re-register the package in Firebase, re-download the JSON, commit |
| App installs but `getExpoPushTokenAsync` throws | `google-services.json` missing or malformed | Re-download from Firebase |
| Push delivered but device doesn't show banner | OS-level notification permission denied | User: iOS Settings / Android Settings → app → Notifications → enable |

## Per-merchant Firebase setup is now AUTOMATED

`scripts/sync-firebase-android-app.mjs` runs on every Android build (wired into `nooks-build.yml`). For each new merchant package:

1. Calls the Firebase Management API to register the package as an Android app under `nooks-push` (no-op if already registered).
2. Pulls the merged `google-services.json` (one file with `client[]` entries for every merchant).
3. Writes it to the repo root.
4. The next workflow step re-commits the file so EAS's git-mode upload picks it up.

**Idempotent and fast-path optimized**: if the merchant's package is already in the local `google-services.json`, the script exits before making any API call. Most builds (re-builds for existing merchants) are zero-cost.

**Fail-open**: any permission / network error logs a warning and exits 0. The build continues with the existing `google-services.json`.

### One-time SA permission grant (required for the auto-sync)

The Firebase Admin SDK service account (`firebase-adminsdk-fbsvc@nooks-push.iam.gserviceaccount.com`) has data-plane access by default but cannot create new Android apps. Grant it `roles/firebase.developAdmin` once:

1. Open <https://console.cloud.google.com/iam-admin/iam?project=nooks-push>.
2. Find the row for `firebase-adminsdk-fbsvc@nooks-push.iam.gserviceaccount.com`.
3. Click the pencil → **Add another role** → search **Firebase Develop Admin** → Save.

Without this role the script logs a warning and falls back to the manual flow below.

## Manual fallback (only if the auto-sync fails)

If a merchant's first build logs `Firebase Android app sync failed`, do this once for that merchant:

1. https://console.firebase.google.com → **nooks-push** → ⚙ → **Add app → Android**.
2. Package name: the merchant's exact `sa.nooks.<slug>`.
3. Download the new `google-services.json` (it now contains an entry for the new merchant alongside every existing one).
4. Replace `google-services.json` at the repo root, commit + push.

Then re-trigger the build.
