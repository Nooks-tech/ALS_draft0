# Nooksweb: Loyalty → Apple Wallet logo size slider

**Audience:** Implement in the **nooksweb** repo (Next.js merchant dashboard). The ALS API and DB support are in **ALS_draft0**; apply the migration, deploy the server, then add the UI below.

---

## 1. Database (Supabase)

Run migration **`supabase/migrations/20260321000000_loyalty_wallet_card_logo_scale.sql`** from ALS (or paste SQL in SQL editor):

- Adds **`loyalty_config.wallet_card_logo_scale`** (`integer`, nullable, **20–200**).
- **`NULL`** = use the same % as **Appearance → In-app logo size** (`app_config.in_app_logo_scale`).
- Any **non-null** value = **Apple Wallet** strip logo uses this % independently.

---

## 2. API (already in ALS server)

- **`PUT /api/loyalty/config`** accepts **`wallet_card_logo_scale`** (number or `null` to clear).
- **`GET /api/loyalty/config?merchantId=…`** returns the column from `loyalty_config`.
- **`GET /api/loyalty/balance`** includes **`walletCardLogoScale`** (camelCase) for convenience.

Wallet pass generation (`server/routes/walletPass.ts`) uses **`resolveWalletLogoScale(loyalty_config, app_config.in_app_logo_scale)`**.

---

## 3. Nooksweb UI (Loyalty settings page)

Add a section **under Loyalty / Wallet card** (next to wallet background color, wallet logo URL, etc.):

| Label (EN) | Example |
|------------|---------|
| **Wallet logo size (Apple Wallet)** | Slider **20% – 200%**, step 1 |
| Helper text | “Size of the logo on the Apple Wallet pass. Leave ‘Same as app’ on to match **In-app logo size** in Appearance.” |

### Behavior

1. Load **`GET /api/loyalty/config?merchantId=`** and **`app_config`** (or your existing Appearance fetch) for **`in_app_logo_scale`**.
2. **Display value** for the slider:
   - If `wallet_card_logo_scale === null` → show **`in_app_logo_scale`** (or 100) and enable a **“Same as in-app logo”** switch (on).
3. When the merchant **turns off** “Same as in-app logo”, set slider to the resolved value and treat changes as **explicit** (save integer 20–200).
4. When **“Same as in-app”** is on, save **`wallet_card_logo_scale: null`** (inherit).
5. On save, **`PUT /api/loyalty/config`** with `{ merchantId, …existingFields, wallet_card_logo_scale }`.

### Minimal React pattern

```tsx
const [sameAsApp, setSameAsApp] = useState(
  loyalty.wallet_card_logo_scale == null,
);
const resolved =
  loyalty.wallet_card_logo_scale ??
  appConfig.in_app_logo_scale ??
  100;
const [pct, setPct] = useState(
  Math.min(200, Math.max(20, Math.round(Number(resolved) || 100))),
);

// Slider updates `pct` only; when sameAsApp, don't persist pct until user toggles off.

async function saveLoyalty() {
  await fetch(`${ALS_API}/api/loyalty/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      merchantId,
      // ...other loyalty fields
      wallet_card_logo_scale: sameAsApp ? null : pct,
    }),
  });
}
```

Use your design system **Slider** + **Switch** (shadcn / MUI / native) to match **In-app logo size** on Appearance.

---

## 4. QA

- **NULL + in-app 120%** → Wallet pass logo matches 120% (after server deploy).
- Set **Wallet** to **80%** while in-app stays **120%** → pass uses **80%**.
- Toggle **Same as in-app** → column **NULL**; change in-app scale → pass follows without editing Loyalty again.
