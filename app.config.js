const dotenv = require('dotenv');
dotenv.config();

const appJson = require('./app.json');
const withApplePayEntitlement = require('./plugins/withApplePay');

const applePayMerchantId = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID || 'merchant.com.als';

const config = {
  ...appJson,
  extra: {
    mapboxToken: process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '',
    moyasarPublishableKey: process.env.EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY || '',
    merchantId: process.env.EXPO_PUBLIC_MERCHANT_ID || '',
    skipAuthForDev: process.env.EXPO_PUBLIC_SKIP_AUTH_FOR_DEV === 'true',
    nooksApiBaseUrl: process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '',
  },
};

// Add Apple Pay entitlement (required for iOS). Update merchantId once you have Apple Developer account.
config.expo.plugins = [
  ...(config.expo.plugins || []),
  [withApplePayEntitlement, { merchantId: applePayMerchantId }],
];

module.exports = config;
