const dotenv = require('dotenv');
dotenv.config();

const appJson = require('./app.json');
const withApplePayEntitlement = require('./plugins/withApplePay');
const withExpoWalletPatch = require('./plugins/withExpoWalletPatch');

const applePayMerchantId = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID || 'merchant.com.nooks';
const buildTimeAppName = process.env.EXPO_PUBLIC_APP_NAME || '';
const buildTimeAppIconFile = process.env.EXPO_PUBLIC_APP_ICON_FILE || '';
const resolvedAppIconFile = buildTimeAppIconFile.trim() || './assets/images/icon.png';

// Option A: one build per merchant – branding baked in at build time (from EAS workflow / .env)
const buildTimeLogoUrl = process.env.EXPO_PUBLIC_LOGO_URL || '';
const buildTimePrimaryColor = process.env.EXPO_PUBLIC_PRIMARY_COLOR || '';
const buildTimeAccentColor = process.env.EXPO_PUBLIC_ACCENT_COLOR || '';
const buildTimeBackgroundColor = process.env.EXPO_PUBLIC_BACKGROUND_COLOR || '';
const buildTimeMenuCardColor = process.env.EXPO_PUBLIC_MENU_CARD_COLOR || '';
const buildTimeTextColor = process.env.EXPO_PUBLIC_TEXT_COLOR || '';
const buildTimeAppIconBgColor = process.env.EXPO_PUBLIC_APP_ICON_BG_COLOR || '';
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '';

const config = {
  ...appJson,
};

config.expo = config.expo || {};
if (buildTimeAppName.trim()) {
  config.expo.name = buildTimeAppName.trim();
}
if (buildTimeAppIconFile.trim()) {
  config.expo.icon = buildTimeAppIconFile.trim();
}
const resolvedIcon = config.expo.icon || resolvedAppIconFile;
config.expo.android = {
  ...(config.expo.android || {}),
  adaptiveIcon: {
    backgroundColor: (buildTimeAppIconBgColor && buildTimeAppIconBgColor !== 'none')
      ? buildTimeAppIconBgColor
      : (config.expo.android?.adaptiveIcon?.backgroundColor || '#E6F4FE'),
    foregroundImage: resolvedIcon,
    monochromeImage: resolvedIcon,
  },
  config: {
    ...((config.expo.android && config.expo.android.config) || {}),
    ...(googleMapsApiKey ? { googleMaps: { apiKey: googleMapsApiKey } } : {}),
  },
};

// Ensure splash uses the merchant-selected app icon too (prevents red placeholder flash on startup).
const existingPlugins = Array.isArray(config.expo.plugins) ? config.expo.plugins : [];
let splashUpdated = false;
config.expo.plugins = existingPlugins.map((pluginEntry) => {
  if (Array.isArray(pluginEntry) && pluginEntry[0] === 'expo-splash-screen') {
    splashUpdated = true;
    const prevOptions = (pluginEntry[1] && typeof pluginEntry[1] === 'object') ? pluginEntry[1] : {};
    return [
      'expo-splash-screen',
      {
        ...prevOptions,
        image: resolvedIcon,
      },
    ];
  }
  return pluginEntry;
});
if (!splashUpdated) {
  config.expo.plugins = [
    ...config.expo.plugins,
    ['expo-splash-screen', { image: resolvedIcon, resizeMode: 'contain', backgroundColor: '#ffffff' }],
  ];
}

config.expo.extra = {
  ...(config.expo.extra || {}),
  eas: {
    projectId: 'fb36734a-26d7-4ea6-8eec-35bb94bdbfda',
  },
  mapboxToken: process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '',
  moyasarPublishableKey: process.env.EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY || '',
  merchantId: process.env.EXPO_PUBLIC_MERCHANT_ID || '',
  skipAuthForDev: process.env.EXPO_PUBLIC_SKIP_AUTH_FOR_DEV === 'true',
  nooksApiBaseUrl: process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '',
  googleMapsApiKey: googleMapsApiKey || '',
  logoUrl: buildTimeLogoUrl || null,
  appName: buildTimeAppName || '',
  appIconFile: buildTimeAppIconFile || '',
  primaryColor: buildTimePrimaryColor || '',
  accentColor: buildTimeAccentColor || '',
  backgroundColor: buildTimeBackgroundColor || '',
  menuCardColor: buildTimeMenuCardColor || '',
  textColor: buildTimeTextColor || '',
  appIconBgColor: buildTimeAppIconBgColor || '',
};

// Add Apple Pay entitlement (required for iOS). Update merchantId once you have Apple Developer account.
config.expo.plugins = [
  ...(config.expo.plugins || []),
  [withApplePayEntitlement, { merchantId: applePayMerchantId }],
  withExpoWalletPatch,
];

module.exports = config;
