# Build webhook – explained simply

## Why does this exist?

When a **merchant pays through Nooks**, Nooks needs to tell **your system** to build a custom app for that merchant (with their logo and colors). Your system doesn’t run the build itself: it asks **GitHub** to run a workflow that uses **Expo** to build the Android and iOS apps.

So the flow is:

```
Merchant pays in Nooks
    → Nooks calls YOUR server (at /build)
    → Your server tells GitHub “run the build workflow”
    → GitHub runs the workflow, which uses Expo to build the app
```

To make that work, several pieces need to “log in” or “know where to call.” Those pieces are the tokens and settings in the table.

---

## What each thing is (in simple words)

| Name | What it really is | Who uses it |
|------|-------------------|-------------|
| **EXPO_TOKEN** | A **password** that proves “GitHub Actions is allowed to use your Expo account to build the app.” | **GitHub** (when it runs the workflow) |
| **GITHUB_TOKEN** | A **password** that proves “your server is allowed to tell GitHub to start the workflow.” | **Your server** (when Nooks calls /build) |
| **GITHUB_REPO** | The **name of your repo** in the form `username/repo-name` (e.g. `abdul/ALS_draft0`). So the server knows *which* repo to trigger. | **Your server** |
| **BUILD_WEBHOOK_BASE_URL** | The **public address of your API** (e.g. `https://als-api.railway.app`). So your server can tell Nooks “call this URL to trigger a build.” | **Your server** (and you give the full URL to Nooks) |
| **BUILD_WEBHOOK_SECRET** | (Optional) A **shared secret** that only your server and Nooks know. Your server checks it so only Nooks (not random people on the internet) can trigger builds. | **Your server** and **Nooks** |

So:

- **EXPO_TOKEN** → you give it to **GitHub** (as a repo secret).
- **GITHUB_TOKEN** and **GITHUB_REPO** → you put them in **server/.env** (and in your deployed server’s env).
- **BUILD_WEBHOOK_BASE_URL** → you set it in **server/.env** once your API is deployed (so the “webhook URL” you give Nooks is correct).
- **BUILD_WEBHOOK_SECRET** → (optional) you put it in **server/.env** and give the same value to **Nooks** so they can send it in a header.

---

## Step-by-step: what you do

### Step 1 – EXPO_TOKEN (for GitHub)

- **What:** A token from Expo so GitHub can build your app.
- **Get it:**  
  1. Go to [expo.dev](https://expo.dev), log in.  
  2. Profile (top right) → **Account settings** → **Access tokens**.  
  3. **Create token**, name it e.g. “GitHub Actions”, copy the token (it’s shown only once).
- **Set it:**  
  - On GitHub: your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.  
  - Name: `EXPO_TOKEN`, Value: paste the token → **Add secret**.

---

### Step 2 – GITHUB_TOKEN (for your server)

- **What:** A GitHub “personal access token” so your server can trigger the workflow.
- **Get it:**  
  1. Go to [github.com/settings/tokens](https://github.com/settings/tokens).  
  2. **Generate new token (classic)**.  
  3. Name it e.g. “ALS build webhook”, under scopes check **repo**, generate, then copy the token (shown only once).
- **Set it:** In **server/.env** add:  
  `GITHUB_TOKEN=ghp_xxxxxxxxxxxx`  
  (paste your token after the `=`).

---

### Step 3 – GITHUB_REPO (for your server)

- **What:** Your repo identifier so the server knows which repo to trigger.
- **Get it:** Look at your repo URL. If it’s `https://github.com/abdul/ALS_draft0`, then it’s `abdul/ALS_draft0`.
- **Set it:** In **server/.env** add:  
  `GITHUB_REPO=abdul/ALS_draft0`  
  (use your real username and repo name).

---

### Step 4 – BUILD_WEBHOOK_BASE_URL (optional until you deploy)

- **What:** The public base URL of your API. Used so when someone asks “what URL should Nooks call?”, your server can answer with the full webhook URL.
- **Get it:** After you deploy the server (e.g. Railway, Render), the host gives you a URL like `https://als-api.railway.app`. That’s your base (no `/build` at the end).
- **Set it:** In **server/.env** add:  
  `BUILD_WEBHOOK_BASE_URL=https://als-api.railway.app`  
  (use your real deployed URL).

---

### Step 5 – BUILD_WEBHOOK_SECRET (optional)

- **What:** A secret string so only Nooks (or someone who has this secret) can trigger builds.
- **Get it:** Create a long random string (e.g. run in terminal:  
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`  
  and copy the output).
- **Set it:** In **server/.env** add:  
  `BUILD_WEBHOOK_SECRET=the_string_you_generated`  
  Then give **the same string** to Nooks and ask them to send it in the **x-nooks-secret** header when they call your webhook.

---

## After you set everything

1. Deploy your server (if you haven’t).
2. Open in a browser or with curl:  
   `https://YOUR_API_URL/build`  
   (use your real API URL). You’ll get JSON with a **webhook_url**.
3. Give Nooks that **webhook_url** as their **BUILD_SERVICE_WEBHOOK_URL**. If you use **BUILD_WEBHOOK_SECRET**, give them that value for the **x-nooks-secret** header.

Then when a merchant pays, Nooks will call that URL, your server will trigger GitHub, and GitHub will run the Expo build. You don’t need to understand the code for that; you just need these five things set correctly.
