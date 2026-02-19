# Apple Pay Setup Guide

This project is **ready for Apple Pay**. Once you have an Apple Developer account ($99/year), follow these steps. No MacBook required—use EAS Build to build in the cloud.

---

## Pre-requisites Checklist

- [ ] **Apple Developer Account** (enrolled, $99/year)
- [ ] **Moyasar Account** (free at [moyasar.com](https://moyasar.com))
- [ ] **EAS CLI** installed: `npm install -g eas-cli`
- [ ] **EAS account** (same as Expo): `eas login`

---

## Step 1: Create Merchant ID (Apple Developer Portal)

1. Go to [developer.apple.com](https://developer.apple.com) → Certificates, Identifiers & Profiles
2. **Identifiers** → **+** (Add) → **Merchant IDs**
3. Description: `ALS Payments` (or your app name)
4. Identifier: `merchant.com.als` (or `merchant.com.yourcompany.als`)
5. **Register**

**Save this identifier**—you'll use it in Step 5.

---

## Step 2: Payment Processing Certificate (Moyasar)

1. [Moyasar Dashboard](https://dashboard.moyasar.com) → Settings → **Apple Pay** → **Certificate**
2. Click **Request CSR** → **Download CSR**
3. In Apple Developer: go to your Merchant ID → **Create Certificate**
4. When asked "Is the merchant within China Mainland?" → **No**
5. Upload the CSR → Download the signed `.cer` file
6. Back in Moyasar → **Upload** the signed certificate

---

## Step 3: Configure Moyasar in Your Project

Add to your `.env` (create from `.env.example`):

```env
# Moyasar publishable key (pk_test_ for sandbox, pk_live_ for production)
EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxx

# Your Merchant ID from Step 1
EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID=merchant.com.als
```

Get your publishable key from Moyasar Dashboard → API Keys.

---

## Step 4: Build iOS App with EAS

From your project folder (Windows is fine):

```bash
# Install EAS CLI if needed
npm install -g eas-cli

# Build for iOS (development build to test on device)
eas build --profile development --platform ios
```

EAS will build in the cloud. When done, scan the QR code with your iPhone to install.

---

## Step 5: Test Apple Pay

1. Install the app on your iPhone
2. Add items to cart → Checkout
3. Select **Apple Pay**
4. Tap **Place Order**
5. Complete payment with Face ID / Touch ID

---

## Already Implemented in This Project

| Component | Status |
|-----------|--------|
| Apple Pay entitlement (iOS) | ✅ Config plugin adds `com.apple.developer.in-app-payments` |
| Moyasar React Native SDK | ✅ Integrated in checkout |
| Payment flow (Apple Pay → create order) | ✅ Implemented |
| EAS Build config | ✅ `eas.json` ready |
| Credit Card & Cash | ✅ Working now |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Apple Pay not configured" | Add `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY` and `EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID` to `.env` |
| Apple Pay button doesn't appear | Only shown on iOS; hidden on Android/Web |
| Payment fails | Ensure Payment Processing Certificate is uploaded in Moyasar and matches Merchant ID |
| Build fails | Run `npx expo prebuild --clean` then `eas build` |

---

## Summary

**What you need to do once you have the Apple Developer account:**

1. Create Merchant ID in Apple Developer Portal
2. Request CSR in Moyasar → sign in Apple → upload back to Moyasar
3. Add `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY` and `EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID` to `.env`
4. Run `eas build --profile development --platform ios`
5. Test on your iPhone

**Estimated time:** 30–45 minutes.
