# Payment → GitHub build: why no build runs when you pay

When a merchant pays on Nooksweb, Nooksweb calls your ALS server at `POST /build`; the server then triggers the GitHub Actions workflow. If nothing appears on GitHub after payment, check the following.

## 1. Nooksweb (where payment happens)

Set these in **Nooksweb** env (Vercel / local `.env`):

| Variable | Description |
|----------|-------------|
| `BUILD_SERVICE_WEBHOOK_URL` | **Full URL** of the ALS build endpoint, e.g. `https://YOUR-RAILWAY-URL.up.railway.app/build` (no trailing slash). Must be reachable from Nooksweb (not localhost if Nooksweb is on Vercel). |
| `BUILD_SERVICE_WEBHOOK_SECRET` | Any shared secret string. Must match `BUILD_WEBHOOK_SECRET` on the ALS server. |

If either is missing, Nooksweb skips the build trigger and returns 200 with `skipped: true` (no error shown to the user).

## 2. ALS_draft0 server (this repo, e.g. on Railway)

Set these in the **server** env (e.g. Railway → Variables):

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub Personal Access Token (classic) with **repo** and **workflow** scope. From https://github.com/settings/tokens |
| `GITHUB_REPO` | Repo in form `owner/repo`, e.g. `Nooks-tech/ALS_draft0` |
| `GITHUB_BUILD_REF` | Branch to run the workflow from. Use `master` if that’s your default branch (default in code is `master`). |
| `BUILD_WEBHOOK_SECRET` | Same value as `BUILD_SERVICE_WEBHOOK_SECRET` in Nooksweb (optional but recommended). |

If `GITHUB_TOKEN` or `GITHUB_REPO` is missing, `POST /build` returns 500 and no workflow is triggered.

## 3. GitHub Actions (ALS_draft0 repo)

- **Workflow file:** `.github/workflows/nooks-build.yml` must exist on the branch you set in `GITHUB_BUILD_REF` (e.g. `master`).
- **Secrets** (repo → Settings → Secrets and variables → Actions):
  - `EXPO_TOKEN` – required for EAS build (from https://expo.dev → Access tokens).
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `API_URL`, `NOOKS_API_BASE_URL`, `MOYASAR_PUBLISHABLE_KEY` – used when writing `.env` in the workflow for EAS.

## 4. Quick checks

- **Nooksweb after payment:** Check server logs for `[finalize-subscription] Build trigger failed` or “Build webhook failed: 404/502”. If you see “Build webhook not configured”, set `BUILD_SERVICE_WEBHOOK_URL` and `BUILD_SERVICE_WEBHOOK_SECRET`.
- **ALS server:** Call `GET https://YOUR-RAILWAY-URL/build`. Response should show `configured: true` and `webhook_url`. If `configured: false`, set `GITHUB_TOKEN` and `GITHUB_REPO`.
- **GitHub:** After a successful payment, in the repo go to Actions → “Nooks-triggered build”. If no run appears, the dispatch from the ALS server failed (check server logs for `[Build] GitHub trigger failed`). If the run appears but fails, check the workflow log (often missing `EXPO_TOKEN` or other secrets).

## 5. Flow summary

1. Merchant pays on Nooksweb → verify-payment sets merchant to `active`.
2. Nooksweb calls `POST /api/billing/finalize-subscription` → that calls `POST /api/build/trigger` (same app).
3. Nooksweb `api/build/trigger` POSTs to `BUILD_SERVICE_WEBHOOK_URL` (your ALS server `/build`) with `x-nooks-secret: BUILD_SERVICE_WEBHOOK_SECRET`.
4. ALS server validates secret, then `POST https://api.github.com/repos/{GITHUB_REPO}/actions/workflows/nooks-build.yml/dispatches` with ref `GITHUB_BUILD_REF` and inputs (merchant_id, colors, etc.).
5. GitHub runs the workflow on that ref; EAS builds Android and iOS.
