# Payment Testing Guide

## Issue 1: "Order fail not found" (Credit Card in-app)

**Cause:** Foodics API is not configured (`FOODICS_API_TOKEN` is placeholder). The app falls back to local orders when Foodics fails with "not found" or "unauthorized".

**Fix applied:** Orders are now created locally even when Foodics fails (demo mode). You can test the full flow without a real Foodics account.

---

## Issue 2: Apple Pay gets declined

**Cause:** Apple Pay requires proper configuration in Moyasar and Apple Developer:
- Merchant ID must be registered with Moyasar
- Apple Pay must be enabled in Moyasar dashboard
- Test cards may not work with Apple Pay

**Fix:** Use Credit Card instead for testing, or complete Apple Pay setup in [Moyasar Dashboard](https://moyasar.com/dashboard) and [Apple Developer](https://developer.apple.com).

---

## Issue 3: Credit card on Moyasar web page – payment succeeds but no navigation / no order

**Cause:** Moyasar requires an HTTPS `success_url` to redirect after payment. Without it, the app never receives the success signal.

**Fix:** Set `PAYMENT_REDIRECT_BASE_URL` in `server/.env`:

1. **Local dev** – use ngrok:
   ```bash
   ngrok http 3001
   ```
   Copy the `https` URL (e.g. `https://abc123.ngrok-free.app`) and add to `server/.env`:
   ```
   PAYMENT_REDIRECT_BASE_URL=https://abc123.ngrok-free.app
   ```

2. **Production** – use your deployed API URL:
   ```
   PAYMENT_REDIRECT_BASE_URL=https://api.als.delivery
   ```

3. Restart the server after changing `.env`.

---

## Quick test flow (without Foodics)

1. Add items to cart
2. Choose **Credit Card** (not Apple Pay for easiest testing)
3. **Option A – In-app form:** Tap Pay → enter card in the modal → order is created (Foodics fails but order is saved locally)
4. **Option B – Web page:** Tap Pay with Apple Pay → when the Moyasar page opens, choose "Pay with card" → complete payment. Requires `PAYMENT_REDIRECT_BASE_URL` for redirect back to the app.
