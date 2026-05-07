# Monitoring setup

Goal: when something breaks in production, you find out within a minute via Slack — not via an angry customer DM.

Three pieces:
- **Sentry** — catches errors in mobile + Express API + nooksweb dashboard
- **Better Uptime** — pings the API every minute, alerts when it's down
- **Slack** — single `#nooks-alerts` channel that both feed into

The code is already wired (Sentry SDKs installed, init calls in place). All that's left is creating the accounts and pasting env vars into the right places.

## 1. Sentry env vars

Three projects, three DSNs. Add each one to the right deploy target:

| Project | DSN env var name | Where to set it |
|---------|------------------|-----------------|
| **nooks-mobile** | `EXPO_PUBLIC_SENTRY_DSN` | `Nooks-tech/ALS_draft0` GitHub repo Secrets — the build workflow inlines it into the JS bundle |
| **nooks-api** | `SENTRY_DSN` | Railway → ALS_draft0 service → Variables |
| **nooks-web** | `NEXT_PUBLIC_SENTRY_DSN` | Railway → nooksweb service → Variables |

The DSNs are not secrets in the cryptographic sense — Sentry designs them to be embeddable in client code. Treating them like env vars keeps the codebase clean and lets you swap projects without redeploying.

### Wire EXPO_PUBLIC_SENTRY_DSN into the build pipeline

Add one line to `.github/workflows/nooks-build.yml` in the "Write .env for EAS" step:

```yaml
echo "EXPO_PUBLIC_SENTRY_DSN=${{ secrets.SENTRY_DSN_MOBILE }}" >> .env
```

Then add `SENTRY_DSN_MOBILE` as a GitHub Secret with the nooks-mobile DSN. Every subsequent build embeds it into the JS bundle automatically.

## 2. Uptime monitor (Better Uptime / BetterStack)

Free tier is enough for pilot.

1. Sign up at https://betterstack.com/uptime → New Monitor
2. URL: `https://alsdraft0-production.up.railway.app/health` (the Express server's health endpoint — already exposed at `server/index.ts:85`, returns `{"status":"ok"}`)
3. Check frequency: 1 minute
4. Method: GET
5. Expected status: 200
6. Notification → Slack → connect your workspace → pick `#nooks-alerts` → save

Optional: add a second monitor for `https://your-nooksweb-url.up.railway.app/api/healthz` once nooksweb has its own health endpoint (low priority — Railway already restarts the service if it crashes).

## 3. Slack channel

If you don't have a Slack workspace yet, https://slack.com/get-started — free.

1. Create channel `#nooks-alerts`
2. **For Sentry → Slack**:
   - Sentry → Settings → Integrations → Slack → Install
   - Pick `#nooks-alerts`
   - Project alerts: enable on each of the 3 projects (nooks-mobile, nooks-api, nooks-web). Default rule "alert me on any new issue in production" is what you want.
3. **For Better Uptime → Slack**: handled in step 2 above.

## 4. Verify it works

Once env vars are set and a build / redeploy has gone out:

- **Mobile**: open the app, navigate the merchant tile so something runs. Then in Sentry's `nooks-mobile` project, send a test error: `Sentry.captureException(new Error("test from mobile"))` from a temporary button. Confirm it appears in Sentry within 30 seconds.
- **API**: `curl https://alsdraft0-production.up.railway.app/api/this-route-doesnt-exist` — Express returns 404, but if you wrap any route in a deliberate `throw new Error('test')`, Sentry catches it.
- **Uptime**: temporarily change the monitor URL to a 404 path → Better Uptime should ping `#nooks-alerts` within 1-2 minutes → revert.

## 5. Day-to-day operation

When an alert hits `#nooks-alerts`:

1. Click the Sentry link → see the stack trace, request payload, breadcrumbs
2. Identify whether it's a new bug (new fingerprint) or a recurring one (Sentry groups by stack frame)
3. If recurring → bump the issue, ignore the alert
4. If new and impacting customers → fix forward, ship the OTA, mark resolved in Sentry

Sentry's free tier: 5K errors / month per project. If you hit that ceiling on `nooks-api` or `nooks-mobile`, it usually means there's ONE bug throwing on every request — fix it, don't pay for more quota.

## 6. What's intentionally NOT in here

- **Datadog / New Relic** — overkill for pilot. Add when you have >100 merchants.
- **PagerDuty** — same. Slack notifications are fine for a single founder on-call.
- **Performance traces (`tracesSampleRate`)** — disabled (set to 0) on all three SDKs. Turn on to 0.1 once you want to see slow API endpoints; turning on at 1.0 will burn the free tier in a day.
- **Replay (Sentry's session replay)** — privacy risk for Saudi customers entering phone numbers; skip until you have a privacy policy that covers it.
- **Custom dashboards** — useful eventually, not needed now.
