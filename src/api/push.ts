import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from './supabase';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export async function registerPushToken(params: {
  merchantId: string;
  customerId: string;
  token: string;
  appLanguage?: string;
}): Promise<void> {
  if (!BASE_URL.trim() || !params.merchantId.trim() || !params.customerId.trim() || !params.token.trim()) {
    return;
  }

  // Server now requires the Supabase access token so it can verify
  // `customerId` really is the signed-in user before registering the
  // Expo push token against that account. Without a session we can't
  // authenticate — bail silently; _layout.tsx only invokes this when
  // user?.id is present so in practice we always have one.
  const session = (await supabase?.auth.getSession())?.data?.session ?? null;
  if (!session?.access_token) return;

  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(params.merchantId)}/push/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      customerId: params.customerId,
      token: params.token,
      platform: Platform.OS,
      ...(params.appLanguage ? { appLanguage: params.appLanguage } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to register push token');
  }
}

export async function unregisterPushToken(params: {
  merchantId: string;
  customerId: string;
  token?: string;
}): Promise<void> {
  if (!BASE_URL.trim() || !params.merchantId.trim() || !params.customerId.trim()) {
    return;
  }
  const session = (await supabase?.auth.getSession())?.data?.session ?? null;
  if (!session?.access_token) return;

  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(params.merchantId)}/push/unregister`;
  try {
    await fetch(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        customerId: params.customerId,
        ...(params.token ? { token: params.token } : {}),
      }),
    });
  } catch {
    // Non-fatal — sign-out continues regardless.
  }
}
