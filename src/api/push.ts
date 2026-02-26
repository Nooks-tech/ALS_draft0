import { Platform } from 'react-native';
import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export async function registerPushToken(params: {
  merchantId: string;
  customerId: string;
  token: string;
}): Promise<void> {
  if (!BASE_URL.trim() || !params.merchantId.trim() || !params.customerId.trim() || !params.token.trim()) {
    return;
  }

  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(params.merchantId)}/push/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerId: params.customerId,
      token: params.token,
      platform: Platform.OS,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to register push token');
  }
}
