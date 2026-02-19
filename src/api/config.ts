/**
 * API configuration - points to your ALS backend
 * For local dev: use your machine IP (not localhost) when testing on device
 */
import Constants from 'expo-constants';

const ENV = {
  dev: {
    apiUrl: 'http://localhost:3001',
  },
  staging: {
    apiUrl: 'https://api-staging.als.delivery',
  },
  prod: {
    apiUrl: 'https://api.als.delivery',
  },
};

const getEnvVars = () => {
  const releaseChannel = Constants.expoConfig?.extra?.releaseChannel ?? '';
  if (__DEV__) return ENV.dev;
  if (releaseChannel.includes('staging')) return ENV.staging;
  return ENV.prod;
};

export const API_CONFIG = getEnvVars();

/** Override via env - for device testing use your computer's IP, e.g. http://192.168.1.5:3001 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL || API_CONFIG.apiUrl;

/** Moyasar publishable key (pk_test_... or pk_live_...) - required for Apple Pay & Credit Card */
export const MOYASAR_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY || '';

/** Apple Pay merchant ID from Apple Developer - required for Apple Pay on iOS */
export const APPLE_PAY_MERCHANT_ID = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID || 'merchant.com.als';

/** Moyasar API base URL - use https://apimig.moyasar.com for staging */
export const MOYASAR_BASE_URL = process.env.EXPO_PUBLIC_MOYASAR_BASE_URL || 'https://api.moyasar.com';
