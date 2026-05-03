const dotenv = require('dotenv');
const fs = require('fs');
dotenv.config();

const appJson = require('./app.json');
const withApplePayEntitlement = require('./plugins/withApplePay');
const withExpoWalletPatch = require('./plugins/withExpoWalletPatch');

// Wire up Firebase google-services.json if present at the project
// root. The file contains FCM client config for every merchant
// Android package registered under the Nooks Firebase project — one
// file with multiple `client` entries, Firebase SDK on-device picks
// the right one based on the AAB's package name. Without this file,
// Android FCM token registration silently no-ops and pushes never
// reach Android devices. See docs/ANDROID_PUSH_SETUP.md for the
// per-merchant onboarding flow that keeps the file in sync.
const googleServicesFilePath = './google-services.json';
const hasGoogleServicesFile = fs.existsSync(googleServicesFilePath);

const applePayMerchantId = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID || 'merchant.com.nooks';
const buildTimeAppName = process.env.EXPO_PUBLIC_APP_NAME || '';
const buildTimeAppIconFile = process.env.EXPO_PUBLIC_APP_ICON_FILE || '';
const resolvedAppIconFile = buildTimeAppIconFile.trim() || './assets/images/icon.png';
const iosBundleId = process.env.EXPO_PUBLIC_IOS_BUNDLE_IDENTIFIER || '';
const androidPackageId = process.env.EXPO_PUBLIC_ANDROID_PACKAGE || '';

// Option A: one build per merchant – branding baked in at build time (from EAS workflow / .env)
const buildTimeLogoUrl = process.env.EXPO_PUBLIC_LOGO_URL || '';
const buildTimePrimaryColor = process.env.EXPO_PUBLIC_PRIMARY_COLOR || '';
const buildTimeAccentColor = process.env.EXPO_PUBLIC_ACCENT_COLOR || '';
const buildTimeBackgroundColor = process.env.EXPO_PUBLIC_BACKGROUND_COLOR || '';
const buildTimeMenuCardColor = process.env.EXPO_PUBLIC_MENU_CARD_COLOR || '';
const buildTimeTextColor = process.env.EXPO_PUBLIC_TEXT_COLOR || '';
const buildTimeTabTextColor = process.env.EXPO_PUBLIC_TAB_TEXT_COLOR || '';
const buildTimeAppIconBgColor = process.env.EXPO_PUBLIC_APP_ICON_BG_COLOR || '';
const buildTimeLauncherIconScale = process.env.EXPO_PUBLIC_LAUNCHER_ICON_SCALE || '';
const buildTimeSplashImageFile = process.env.EXPO_PUBLIC_SPLASH_IMAGE_FILE || './assets/images/splash-icon.png';
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
config.expo.ios = {
  ...(config.expo.ios || {}),
  ...(iosBundleId.trim() ? { bundleIdentifier: iosBundleId.trim() } : {}),
  entitlements: {
    ...(config.expo.ios?.entitlements || {}),
    'com.apple.developer.in-app-payments': [applePayMerchantId],
  },
};
const resolvedIcon = config.expo.icon || resolvedAppIconFile;
config.expo.android = {
  ...(config.expo.android || {}),
  ...(androidPackageId.trim() ? { package: androidPackageId.trim() } : {}),
  ...(hasGoogleServicesFile ? { googleServicesFile: googleServicesFilePath } : {}),
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

// Keep the cold-start native splash separate from the in-app language-change overlay.
// Native splash should stay on the darker app-icon/primary color, while the JS overlay
// can still use the merchant background color at runtime.
const existingPlugins = Array.isArray(config.expo.plugins) ? config.expo.plugins : [];
let splashUpdated = false;
config.expo.plugins = existingPlugins.map((pluginEntry) => {
  if (Array.isArray(pluginEntry) && pluginEntry[0] === 'expo-splash-screen') {
    splashUpdated = true;
    const prevOptions = (pluginEntry[1] && typeof pluginEntry[1] === 'object') ? pluginEntry[1] : {};
    const preferredSplashBg =
      (buildTimeAppIconBgColor && buildTimeAppIconBgColor.trim() && buildTimeAppIconBgColor.trim() !== 'none'
        ? buildTimeAppIconBgColor.trim()
        : '') ||
      (buildTimePrimaryColor && buildTimePrimaryColor.trim()) ||
      prevOptions.backgroundColor ||
      '#3B5F1D';
    const splashBg =
      preferredSplashBg;
    const darkBg =
      preferredSplashBg ||
      (prevOptions.dark && prevOptions.dark.backgroundColor) ||
      splashBg;
    return [
      'expo-splash-screen',
      {
        ...prevOptions,
        image: buildTimeSplashImageFile.trim() || prevOptions.image || './assets/images/splash-icon.png',
        imageWidth: 280,
        backgroundColor: splashBg,
        dark: {
          ...(typeof prevOptions.dark === 'object' ? prevOptions.dark : {}),
          backgroundColor: darkBg,
        },
      },
    ];
  }
  return pluginEntry;
});
if (!splashUpdated) {
  const fallbackSplashBg =
    (buildTimeAppIconBgColor && buildTimeAppIconBgColor.trim() && buildTimeAppIconBgColor.trim() !== 'none'
      ? buildTimeAppIconBgColor.trim()
      : '') ||
    (buildTimePrimaryColor && buildTimePrimaryColor.trim()) ||
    '#3B5F1D';
  config.expo.plugins = [
    ...config.expo.plugins,
    [
      'expo-splash-screen',
      {
        image: buildTimeSplashImageFile.trim() || './assets/images/splash-icon.png',
        imageWidth: 280,
        resizeMode: 'contain',
        backgroundColor: fallbackSplashBg,
        dark: { backgroundColor: fallbackSplashBg },
      },
    ],
  ];
}

config.expo.extra = {
  ...(config.expo.extra || {}),
  // projectId is set by `eas init` in app.json under extra.eas.projectId — don't hardcode here
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
  tabTextColor: buildTimeTabTextColor || '',
  appIconBgColor: buildTimeAppIconBgColor || '',
  launcherIconScale: buildTimeLauncherIconScale || '',
};

// Add Apple Pay entitlement (required for iOS). Update merchantId once you have Apple Developer account.
config.expo.plugins = [
  ...(config.expo.plugins || []),
  [withApplePayEntitlement, { merchantId: applePayMerchantId }],
  withExpoWalletPatch,
];

module.exports = config;
