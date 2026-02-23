# Testing the Full Flow: Website → Signup → Wizard → Payment → 2 Builds (Without Apple/Google Dev Accounts)

This guide walks you through **testing the entire journey** end-to-end: user visits nooksweb, signs up (without Foodics for now), completes the wizard with custom UI, pays (test mode), and triggers **two builds** (Android + iOS) with that custom UI. It explains how to do this **without** an Apple Developer account or Google Play Developer account so you can see it fully through.

---

## Can you test without Apple and Google developer accounts?

**Yes.**

- **Android:** We use the **preview** EAS profile, which produces an **APK** (installable file). You can **download the APK** from the Expo build page and install it on a device or emulator. **No Google Play Developer account is required** for building or installing.
- **iOS:** We use the **ios-simulator** EAS profile, which produces a build that runs **only in the iOS Simulator** (on a Mac). **No Apple Developer account is required** for simulator builds. You cannot install this build on a physical iPhone without a paid Apple account; for “see it fully through” we use the simulator.

So for the full test:

- You get **one Android APK** (install on any Android device or emulator).
- You get **one iOS simulator build** (run in Xcode iOS Simulator on a Mac; no Apple ID needed).

Both builds are created with the **merchant’s custom UI** (logo, colors) from the wizard.

---

## High-level flow

```
1. User visits nooksweb (your website)
2. Signs up with email (Foodics skipped for now)
3. Completes wizard: picks icon, sets colors, saves
4. Proceeds to payment (Moyasar test mode)
5. After successful payment → nooksweb POSTs to ALS_draft0 /build webhook
6. ALS_draft0 server triggers GitHub Actions workflow
7. Workflow runs EAS build for Android (preview/APK) and iOS (simulator)
8. You see both builds in Expo dashboard and can install Android APK / run iOS in simulator
```

---

## Prerequisites (before you start)

### 1. Nooksweb (merchant website)

- **Option A:** Nooksweb is **deployed** (e.g. Netlify) and you use the live URL.
- **Option B:** Run nooksweb **locally** (`npm run dev`) and use `http://localhost:3000` (or similar). For the build webhook to be called, the server must be reachable from nooksweb (see “ALS_draft0 server” below).

Nooksweb must be configured to:

- Allow **signup without Foodics** (e.g. env `NEXT_PUBLIC_BILLING_SKIP_FOODICS_GATE=true` or equivalent so payment is not blocked).
- After **successful payment**, **POST** to the build webhook with:
  - `merchant_id` (UUID of the merchant)
  - `logo_url` (from wizard/Supabase Storage)
  - `primary_color`, `accent_color`
  - **For no-account testing:** `use_test_builds: true` (so we use preview + ios-simulator profiles).

### 2. ALS_draft0 server (build webhook)

The server that receives the POST and triggers GitHub must be **reachable** from nooksweb:

- **Option A:** Server is **deployed** (e.g. Railway, Render). Then nooksweb’s `BUILD_SERVICE_WEBHOOK_URL` = `https://your-deployed-url/build`.
- **Option B:** Server runs **locally** and you expose it with **ngrok**: run `ngrok http 3001` (or your server port), then set nooksweb’s `BUILD_SERVICE_WEBHOOK_URL` = `https://xxxx.ngrok-free.app/build`.

Server `.env` must have:

- `GITHUB_TOKEN` – GitHub personal access token (scope: repo).
- `GITHUB_REPO` – e.g. `Nooks-tech/ALS_draft0`.
- `GITHUB_BUILD_REF` – e.g. `master` or `main`.
- `BUILD_WEBHOOK_SECRET` – same value nooksweb sends in `x-nooks-secret`.
- `BUILD_WEBHOOK_BASE_URL` – public URL of the server (e.g. ngrok URL or deployed URL), so the “webhook URL” is correct.

### 3. GitHub (ALS_draft0 repo)

- **EXPO_TOKEN** – In repo **Settings → Secrets and variables → Actions**: add secret **EXPO_TOKEN** (from [expo.dev](https://expo.dev) → Account settings → Access tokens). Required for EAS to run in the workflow.
- **Workflow file** – `.github/workflows/nooks-build.yml` must be on the branch you use (`GITHUB_BUILD_REF`). It should support input **use_test_builds** and, when true, use **preview** for Android and **ios-simulator** for iOS.

### 4. EAS / Expo

- **eas.json** – Must define:
  - **preview** profile: `distribution: "internal"`, `android.buildType: "apk"` (so Android produces an APK).
  - **ios-simulator** profile: `extends: "preview"`, `ios.simulator: true` (so iOS builds for simulator only, no Apple account).
- You only need an **Expo account** (free) and the **EXPO_TOKEN** in GitHub; no Apple or Google developer accounts.

### 5. Moyasar (payment)

- Use **test mode** keys in nooksweb (`NEXT_PUBLIC_MOYASAR_PUBLISHABLE_KEY`, `MOYASAR_SECRET_KEY` with test keys).
- Use a **test card** (e.g. from Moyasar docs) so no real charge.

---

## Step-by-step test (full run)

### Step 1: Configure nooksweb for “test flow”

- Enable “skip Foodics gate” (or equivalent) so the user can pay without connecting Foodics.
- Ensure the **payment success** handler (after Moyasar confirms payment) does:
  1. **POST** to `BUILD_SERVICE_WEBHOOK_URL` with:
     - `Content-Type: application/json`
     - Header: `x-nooks-secret: <BUILD_SERVICE_WEBHOOK_SECRET>`
     - Body:  
       `{ "merchant_id": "<merchant.id>", "logo_url": "<from wizard>", "primary_color": "#...", "accent_color": "#...", "use_test_builds": true }`
  2. Then redirect the user to the dashboard (e.g. `/dashboard`).

Set `BUILD_SERVICE_WEBHOOK_URL` to your ALS_draft0 server’s `/build` URL (deployed or ngrok).

### Step 2: Start ALS_draft0 server (if local)

- From repo root: `cd server && npm run dev` (or `node index.js`).
- If local, start **ngrok**: `ngrok http 3001` (or your port). Copy the `https://...` URL and set it as `BUILD_WEBHOOK_BASE_URL` in `server/.env` and as the base for `BUILD_SERVICE_WEBHOOK_URL` in nooksweb.

### Step 3: Run through the flow on the website

1. **Open nooksweb** (local or deployed).
2. **Sign up** with a real email you control (no Foodics).
3. **Verify email** if your flow requires it.
4. **Go to the wizard.** Upload an icon/logo (or pick a placeholder) and set **primary** and **accent** colors. Click **Save and continue** (or equivalent).
5. **Payment page.** Use a **test card** (Moyasar test mode). Complete payment.
6. You should land on the **dashboard**. In the background, nooksweb should have sent the POST to `/build` with `use_test_builds: true`.

### Step 4: Confirm the webhook was called

- **Server logs:** In the ALS_draft0 server logs you should see something like: “Triggered workflow for merchant: <merchant_id>.”
- **GitHub:** In the ALS_draft0 repo go to **Actions**. You should see a run of **“Nooks-triggered build”** with the inputs (merchant_id, logo_url, primary_color, accent_color, use_test_builds: true). Open the run and confirm both jobs (Build Android, Build iOS) are running or completed.

### Step 5: Confirm EAS builds

- Go to [expo.dev](https://expo.dev) → your project → **Builds**.
- You should see:
  - **Android** – profile **preview**, status “Finished” (or in progress). Download the **APK** from the build page.
  - **iOS** – profile **ios-simulator**, status “Finished” (or in progress). You get a link to install in the **iOS Simulator** (Mac only).

### Step 6: Install and verify custom UI

- **Android:** Download the APK from the Expo build page, install it on an Android device or emulator. Open the app; the **merchant id** and **branding** (logo, colors) should match what you set in the wizard (the app loads them from env at build time: `EXPO_PUBLIC_MERCHANT_ID`, `EXPO_PUBLIC_LOGO_URL`, `EXPO_PUBLIC_PRIMARY_COLOR`, `EXPO_PUBLIC_ACCENT_COLOR`).
- **iOS (Mac only):** Use the “Install” / “Run in Simulator” option from the Expo build page for the ios-simulator build. The simulator app should show the same custom UI.

At this point you have **seen the full flow through**: website → signup → wizard → payment → two builds with custom UI, **without** an Apple or Google developer account.

---

## Sending `use_test_builds` from nooksweb

When the merchant pays in **test mode** (or when you want to run a “no-account” build), nooksweb should include **`use_test_builds: true`** in the POST body to the build webhook. Example:

```json
{
  "merchant_id": "3d24a026-ee4f-4a51-84ed-2a97270b5c53",
  "logo_url": "https://your-storage/logo.png",
  "primary_color": "#0f766e",
  "accent_color": "#0f766e",
  "use_test_builds": true
}
```

Headers:

- `Content-Type: application/json`
- `x-nooks-secret: <BUILD_SERVICE_WEBHOOK_SECRET>`

The ALS_draft0 server forwards `use_test_builds` to the GitHub Actions workflow. When it is `true`, the workflow uses:

- **Android:** `eas build --platform android --profile preview` → APK, no Google Play account needed.
- **iOS:** `eas build --platform ios --profile ios-simulator` → simulator build, no Apple Developer account needed.

For **production** (real App Store / Play Store), nooksweb should **not** send `use_test_builds` or should send `false`, so the workflow uses the default (production) profile and you use your Apple/Google accounts for submission later.

---

## Manual trigger (without going through the website)

To test only the “build” part (e.g. you already have a merchant_id and branding):

1. **GitHub:** Repo → **Actions** → **Nooks-triggered build** → **Run workflow**.
2. Fill:
   - **merchant_id:** a UUID (e.g. from your `merchants` table).
   - **logo_url:** optional URL.
   - **primary_color**, **accent_color:** optional (defaults used if empty).
   - **use_test_builds:** **true**.
3. Run. Then check Expo **Builds** for the Android APK and iOS simulator build.

You can also **POST** to your deployed server’s `/build` with the same body (and `x-nooks-secret`) to trigger the workflow remotely.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| Webhook not called | nooksweb payment success handler: is it actually POSTing to `BUILD_SERVICE_WEBHOOK_URL` with the right body and `x-nooks-secret`? Check network tab and server logs. |
| 401 from /build | `x-nooks-secret` must match `BUILD_WEBHOOK_SECRET` in server `.env`. |
| Workflow not starting | Server: are `GITHUB_TOKEN` and `GITHUB_REPO` set? Is the workflow file on the branch in `GITHUB_BUILD_REF`? Check GitHub Actions for errors. |
| EXPO_TOKEN missing | Add **EXPO_TOKEN** in repo **Settings → Secrets and variables → Actions**. Get token from expo.dev. |
| Android build fails | Ensure **eas.json** has **preview** with `android.buildType: "apk"`. Check EAS build logs in Expo dashboard. |
| iOS build fails (e.g. signing) | For no-account test you must use **ios-simulator** profile (`ios.simulator: true`). If the workflow still uses default profile, set **use_test_builds: true** in the webhook body and confirm the workflow receives it. |
| Custom UI not in app | The workflow passes `EXPO_PUBLIC_MERCHANT_ID`, `EXPO_PUBLIC_LOGO_URL`, `EXPO_PUBLIC_PRIMARY_COLOR`, `EXPO_PUBLIC_ACCENT_COLOR` as env to `eas build`. The app reads these at build time. Confirm the values in the GitHub Actions run match the wizard. |

---

## Summary

- **Yes,** you can test the **full flow** (website → signup → wizard → payment → 2 builds with custom UI) **without** an Apple Developer account or Google Play Developer account.
- Use **test mode** for payment and send **`use_test_builds: true`** from nooksweb when calling the build webhook.
- You get an **Android APK** (preview profile) and an **iOS Simulator** build (ios-simulator profile). Install Android on any device/emulator; run iOS in the simulator on a Mac. Both builds use the merchant’s custom UI from the wizard.
