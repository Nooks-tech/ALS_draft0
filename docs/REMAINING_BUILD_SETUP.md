# Build webhook – 2 things only you can do

Repo is pushed. Server and workflow are configured. You still need to add **two secrets** (we can’t do these for you):

---

## 1. EXPO_TOKEN (in GitHub)

- **Where:** GitHub → **Nooks-tech/ALS_draft0** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
- **Name:** `EXPO_TOKEN`
- **Value:** Create at [expo.dev](https://expo.dev) → Profile → Account settings → Access tokens → Create token → copy and paste here

---

## 2. GITHUB_TOKEN (in server/.env)

- **Where:** Open `server/.env` and replace the placeholder value for `GITHUB_TOKEN`
- **Value:** Create at [github.com/settings/tokens](https://github.com/settings/tokens) → Generate new token (classic) → check **repo** scope → copy
- **Set:** `GITHUB_TOKEN=ghp_xxxxxxxxxxxx` (your token after the `=`)

---

After that, when you deploy the server, set **BUILD_WEBHOOK_BASE_URL** in the deployed env and give Nooks the URL from **GET /build**.
