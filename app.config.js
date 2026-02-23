const dotenv = require('dotenv');
dotenv.config();

const appJson = require('./app.json');
const withApplePayEntitlement = require('./plugins/withApplePay');

const applePayMerchantId = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID || 'merchant.com.als';

// Option A: one build per merchant – branding baked in at build time (from EAS workflow / .env)
const buildTimeLogoUrl = process.env.EXPO_PUBLIC_LOGO_URL || '';
const buildTimePrimaryColor = process.env.EXPO_PUBLIC_PRIMARY_COLOR || '';
const buildTimeAccentColor = process.env.EXPO_PUBLIC_ACCENT_COLOR || '';
const buildTimeBackgroundColor = process.env.EXPO_PUBLIC_BACKGROUND_COLOR || '';

const config = {
  ...appJson,
  extra: {
    mapboxToken: process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '',
    moyasarPublishableKey: process.env.EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY || '',
    merchantId: process.env.EXPO_PUBLIC_MERCHANT_ID || '',
    skipAuthForDev: process.env.EXPO_PUBLIC_SKIP_AUTH_FOR_DEV === 'true',
    nooksApiBaseUrl: process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '',
    // Build-time branding (Option A: one app per merchant)
    logoUrl: buildTimeLogoUrl || null,
    primaryColor: buildTimePrimaryColor || '',
    accentColor: buildTimeAccentColor || '',
    backgroundColor: buildTimeBackgroundColor || '',
  },
};

// Add Apple Pay entitlement (required for iOS). Update merchantId once you have Apple Developer account.
config.expo.plugins = [
  ...(config.expo.plugins || []),
  [withApplePayEntitlement, { merchantId: applePayMerchantId }],
];

module.exports = config;
