# Android Play Internal-Track Setup

One-time setup so `nooks-build.yml` can produce `.aab` builds and ship them straight to Play Console's **Internal Testing track** — Google's equivalent of TestFlight.

## What this gets you

- Production builds: AAB → uploaded to Play Internal Track → testers install via Play Store.
- Preview builds: APK → no Play submit, distribute via direct download / sideload.
- EAS auto-manages the upload signing key (no keystore juggling).

## Prerequisites (one-time, on Google's side)

### 1. Create the app in Play Console

1. Open <https://play.google.com/console>.
2. **Create app**.
3. Use package name **`com.nooksbusiness.als`** (must match `app.json` → `expo.android.package`).
4. Pick a name + default language. Mark it as a real app (not a game), free, etc. — you can edit later.
5. Don't fill the store listing yet. We just need the app entry to exist so we can target it.

### 2. Generate a service account with Play API access

This is what EAS uses to upload AAB files to your app's Internal track.

1. Open <https://console.cloud.google.com>.
2. Create or pick a project. Name doesn't matter — Play Console doesn't care which project owns the service account.
3. Open **APIs & Services → Library**, search for **"Google Play Android Developer API"**, **Enable**.
4. Open **IAM & Admin → Service Accounts → Create service account**:
   - Name: `nooks-eas-publisher` (or anything).
   - Role: **none required at this layer** (Play Console grants its own permissions).
   - Skip the "Grant users access" step.
5. Click the new service account → **Keys → Add key → Create new key → JSON**. Save the downloaded `*.json` file securely.

### 3. Grant the service account access to your Play Console app

1. Back in Play Console: **Setup → API access** (in the left sidebar of your app, NOT global).
2. Find the service account you just created (Play Console auto-detects service accounts in linked Google Cloud projects). If it's not listed, click **Link existing project** and link the Cloud project.
3. **Grant access** on the service account row:
   - Account permissions: leave default (developer-account level).
   - App permissions: add your Nooks app, with at minimum **Release manager** + **View app information**. (Release manager is what lets EAS upload AABs.)
4. **Invite user** / **Save**.

It takes a few minutes for the permission to propagate. If the first submit fails with `403 The caller does not have permission`, wait 5 minutes and re-run.

## GitHub secret

Convert the JSON to base64 and add it as a repo secret.

```sh
# macOS / Linux
base64 -w0 path/to/service-account.json | pbcopy   # macOS — pbcopy puts it in clipboard
base64 -w0 path/to/service-account.json            # Linux — copy the output

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\service-account.json")) | Set-Clipboard
```

Paste it into a new repo secret named **`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`** (Settings → Secrets and variables → Actions → New repository secret).

The workflow's "Decode Google Play service-account JSON" step base64-decodes this back to `fastlane/google-service-account.json` at runtime. The path matches `eas.json`'s `submit.production.android.serviceAccountKeyPath`.

## Trigger a real build

Run `nooks-build.yml` from the GitHub Actions tab the same way you do for iOS. The workflow will:

1. Patch app.json + assets per merchant inputs.
2. Build Android AAB on EAS (≈10 min).
3. Auto-submit to Play Internal track on success.

After ~15 minutes total, the build appears under **Testing → Internal testing → Releases**.

## Adding internal testers

1. Play Console → **Testing → Internal testing → Testers**.
2. Create an email list (or paste emails directly), add the testers.
3. Copy the **opt-in URL** at the bottom of the Testers tab.
4. Send the URL to your testers — they tap, click "Become a tester", and the app shows up in their Play Store within minutes.

Up to 100 testers per list. No review delay (unlike Production track).

## First-build signing

EAS auto-generates an upload key on the first Android build because `eas.json` has `credentialsSource: "remote"`. You'll see something like:

```
[android] Generated a new Android Keystore...
```

You don't need to do anything — EAS stores it server-side and reuses it for every future build of this app. If you ever need to migrate signing or rotate the key, do that via Play Console + `eas credentials`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (403)` on submit | Service account not linked to the app, or not propagated yet | Wait 5 min after granting App permissions; verify the SA email shows under Setup → API access for THIS app |
| `Package name not found` | App not yet created in Play Console | Create the app entry first (Step 1 above) |
| `versionCode already used` | Old workflow run reused a build number | The workflow bumps `versionCode` from a Unix timestamp, so this shouldn't happen — if it does, manually bump in `app.json` |
| Submit succeeds but tester doesn't see app | Tester not on the testers list, or list not saved | Re-check Testing → Internal testing → Testers; the list takes effect immediately |
