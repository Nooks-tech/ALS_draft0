import Constants from 'expo-constants';
import { Platform } from 'react-native';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';
const BUILD_CHANNEL = (Constants.expoConfig?.extra as { buildChannel?: string } | undefined)?.buildChannel ?? 'production';

/**
 * Post a crash envelope to nooksweb's first-party error reporter.
 * Fire-and-forget — must never throw (otherwise an error inside the
 * ErrorBoundary handler would become infinite). Wired from the mobile
 * ErrorBoundary and the 401 interceptor's refresh-failure branch.
 */
export function reportCrash(params: {
  error: unknown;
  screen?: string;
  merchantId?: string | null;
}): void {
  if (!BASE_URL.trim()) return;
  try {
    const err = params.error;
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    fetch(`${BASE_URL.replace(/\/$/, '')}/api/public/errors/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId: params.merchantId ?? null,
        platform: Platform.OS,
        appVersion: APP_VERSION,
        buildChannel: BUILD_CHANNEL,
        errorName: name,
        errorMessage: message,
        errorStack: stack,
        screen: params.screen ?? null,
      }),
    }).catch(() => {});
  } catch {
    // Reporting must never escape.
  }
}
