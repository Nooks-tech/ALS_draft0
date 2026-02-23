# Message from Nooks (what they send to ALS_draft0) and our response

Use this when coordinating with the Nooks/nooksweb side. It captures what they told us and what we do in return.

---

## What Nooks said (message you can send to ALS_draft0)

> **Build webhook:** After each successful payment we POST to your build URL with `merchant_id`, `logo_url`, `primary_color`, `accent_color`, and `platforms: ["android", "ios"]`. Please trigger one Android and one iOS build per payment using that payload.
>
> **Operations API:** `GET {NOOKS_BASE}/api/public/merchants/{merchantId}/operations` returns `store_status` (open | busy | closed), `prep_time_minutes`, and `delivery_mode` (delivery_and_pickup | pickup_only). Please poll this (or use Supabase Realtime on app_config) so the app reflects when the merchant changes store status, prep time, or turns delivery off in the dashboard.
>
> **Branches, Orders, Promos:** All live at the paths already documented; no change needed on your side except to use the operations endpoint above for store/delivery sync.

---

## Our response (ALS_draft0)

### Build webhook

- **We do:** Accept POST to our `/build` URL with `merchant_id`, `logo_url`, `primary_color`, `accent_color`. We trigger **one Android and one iOS** build per payment via GitHub Actions (EAS). Optional `platforms` in the payload is accepted and ignored (we always build both).
- **Config:** Nooks sets `BUILD_SERVICE_WEBHOOK_URL` to our deployed API base + `/build`, and sends `x-nooks-secret` header (see `docs/MESSAGE_FOR_NOOKS_AGENT_BUILD_WEBHOOK.md`).
- **Status:** Implemented.

### Operations API

- **We do:** Call `GET {NOOKS_BASE}/api/public/merchants/{merchantId}/operations` and use the response:
  - **store_status** (open | busy | closed) – we reflect it in the app (e.g. show “Store closed” or disable ordering when closed).
  - **prep_time_minutes** – we use it for estimated ready time / UX.
  - **delivery_mode** (delivery_and_pickup | pickup_only) – we show or hide delivery option accordingly.
- **How we sync:** We poll this endpoint when the app is in the merchant flow (or use Supabase Realtime on `app_config` when Nooks exposes it). See `src/api/nooksOperations.ts` and app usage of operations data.
- **Status:** API client and types added; app will poll (or subscribe) so the UI reflects store status, prep time, and delivery mode.

### Branches, Orders, Promos

- **We do:** No change to existing paths. We use the operations endpoint above for store/delivery sync only.
- **Status:** As documented; operations integration added as requested.
