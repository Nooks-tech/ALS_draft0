# Nooks build webhook setup (Option B)

After a merchant pays in Nooks, Nooks POSTs to our `/build` endpoint. We trigger a GitHub Actions workflow that runs EAS build for Android + iOS with that merchant’s branding.

## What’s in the repo

- **`server/routes/build.ts`** – `POST /build` handler. Validates payload, returns 202, then calls GitHub API to dispatch the workflow.
- **`.github/workflows/nooks-build.yml`** – Workflow that runs `eas build` for Android and iOS with `EXPO_PUBLIC_MERCHANT_ID`, `EXPO_PUBLIC_LOGO_URL`, `EXPO_PUBLIC_PRIMARY_COLOR`, `EXPO_PUBLIC_ACCENT_COLOR`.

## Setup steps (do all three)

### 1. GitHub Actions secret: EXPO_TOKEN

**Option A – GitHub UI**  
Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name: `EXPO_TOKEN`. Value: your [Expo programmatic access token](https://expo.dev/accounts/programmatic-access).

**Option B – GitHub CLI**  
From the repo root, run (you’ll be prompted to paste the token):

```bash
gh secret set EXPO_TOKEN
```

Paste your Expo token when prompted, then press Enter.

### 2. Server environment variables

Use **`server/.env.example`** as the list of variables. Copy the build-webhook block into **`server/.env`** (or your deploy env) and set:

- **GITHUB_TOKEN** – GitHub personal access token with `repo` (or “workflow” scope). Create at: GitHub → Settings → Developer settings → Personal access tokens.
- **GITHUB_REPO** – Repo as `owner/repo` (e.g. `your-username/ALS_draft0`).
- **GITHUB_BUILD_REF** – Branch to trigger (default: `main`).
- **BUILD_WEBHOOK_BASE_URL** – Public base URL of your API (e.g. `https://api.als.delivery`). Used so **GET /build** can return the exact URL for Nooks.
- **BUILD_WEBHOOK_SECRET** (optional) – If set, Nooks must send it in the **`x-nooks-secret`** header on every `POST /build`.

If you deploy to Railway/Render/etc., set these same variables there. The server logs a warning on startup if `GITHUB_TOKEN` or `GITHUB_REPO` is missing.

### 3. Give Nooks the webhook URL

After the API is deployed, call **GET /build** (no auth) to get the exact URL and config status:

```bash
curl https://YOUR_API_HOST/build
```

Response includes **`webhook_url`** (the URL Nooks should call) and **`configured`** (true when `GITHUB_TOKEN` and `GITHUB_REPO` are set). Set **BUILD_WEBHOOK_BASE_URL** in server env so `webhook_url` is correct when behind a proxy.

**Set in Nooks:** `BUILD_SERVICE_WEBHOOK_URL=<webhook_url from GET /build>`. If you use **BUILD_WEBHOOK_SECRET**, give that value to Nooks for the **`x-nooks-secret`** header.

### 4. EAS

Ensure EAS Build is already set up (`eas.json`, credentials). The workflow uses `--no-wait` so it doesn’t block; builds show up in the [Expo dashboard](https://expo.dev).

## Request/response

- **Method:** POST  
- **URL:** `https://<your-api-host>/build`  
- **Headers:** `Content-Type: application/json`. Optional: `x-nooks-secret: <BUILD_WEBHOOK_SECRET>`.  
- **Body:**  
  `{ "merchant_id": "uuid", "logo_url": "...", "primary_color": "#...", "accent_color": "#..." }`  
  Only `merchant_id` is required.  
- **Response:** `202 Accepted` with `{ "message": "Builds triggered", "merchant_id": "..." }`.

Builds are triggered asynchronously; the response is sent before the GitHub workflow runs.
