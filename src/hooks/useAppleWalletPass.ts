/**
 * Apple Wallet pass add hook — extracted from app/(tabs)/offers.tsx
 * so the Polaroid offers screen can reuse the EXACT same wallet
 * flow (pkpass fetch, addPass call) without duplicating ~80 lines
 * of bridge plumbing.
 *
 * Returns:
 *   - available: bridge readiness + iOS check
 *   - loading: true while fetch / native addPass is in flight
 *   - addPass(): the handler bound to the AppleWalletAddPassButton
 *
 * configUpdatedAt is accepted for caller compatibility but no longer used —
 * the pass is always fetched fresh (no cache) as of 2026-07-17.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { API_URL } from '../api/config';
import { getAuthToken } from '../api/client';

type ExpoWalletBridge = {
  addPass?: (base64: string) => Promise<unknown>;
  isAvailable?: () => Promise<boolean>;
};

let ExpoWallet: ExpoWalletBridge | null = null;
let expoWalletAddPass: ((base64: string) => Promise<unknown>) | null = null;
let expoWalletIsAvailable: (() => Promise<boolean>) | null = null;
try {
  const walletModule = require('@giulio987/expo-wallet');
  const candidate = walletModule?.default ?? walletModule;
  ExpoWallet = candidate && typeof candidate === 'object' ? (candidate as ExpoWalletBridge) : null;
  expoWalletAddPass = typeof walletModule?.addPass === 'function' ? walletModule.addPass : null;
  expoWalletIsAvailable = typeof walletModule?.isAvailable === 'function' ? walletModule.isAvailable : null;
} catch {
  // Expo Go has no native wallet bridge — handled by `available=false`.
}

function canAddPassToAppleWallet(): boolean {
  return typeof expoWalletAddPass === 'function' || typeof ExpoWallet?.addPass === 'function';
}

async function isAppleWalletBridgeAvailable(): Promise<boolean> {
  try {
    if (typeof expoWalletIsAvailable === 'function') return !!(await expoWalletIsAvailable());
    if (typeof ExpoWallet?.isAvailable === 'function') return !!(await ExpoWallet.isAvailable());
  } catch {
    /* fall through */
  }
  return canAddPassToAppleWallet();
}

async function addPassToAppleWallet(base64: string): Promise<unknown> {
  if (typeof expoWalletAddPass === 'function') return expoWalletAddPass(base64);
  if (typeof ExpoWallet?.addPass === 'function') return ExpoWallet.addPass(base64);
  throw new Error('Apple Wallet is not available on this device.');
}

export function useAppleWalletPass(opts: {
  merchantId: string | null;
  userId: string | null;
  configUpdatedAt: string | number | null;
}) {
  const { merchantId, userId } = opts;
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    isAppleWalletBridgeAvailable().then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addPass = useCallback(async () => {
    if (!userId || !merchantId) return;
    setLoading(true);
    try {
      // Always fetch fresh. The pass renders the customer's LIVE balance, so
      // any cached copy is stale the moment they earn or redeem — and adding
      // a cached pass doesn't just show a stale preview, it INSTALLS the old
      // snapshot over the fresher pass already in the wallet (bit us
      // 2026-07-17: app said 5161 pts, the cached pass re-installed 5021).
      // One ~200KB fetch behind an explicit tap with a spinner is the right
      // trade.
      const authToken = await getAuthToken();
      if (!authToken) {
        Alert.alert('Error', 'Please sign in again to add this pass.');
        return;
      }
      const passUrl = `${API_URL}/api/loyalty/wallet-pass?customerId=${encodeURIComponent(
        userId,
      )}&merchantId=${encodeURIComponent(merchantId)}&format=base64`;
      const res = await fetch(passUrl, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!res.ok) {
        let msg = `Server returned ${res.status}`;
        try {
          const data = await res.json();
          if (data.error) msg = data.error;
        } catch {
          /* not JSON */
        }
        Alert.alert('Error', msg);
        return;
      }
      const data = await res.json();
      if (data.error) {
        Alert.alert('Error', data.error);
        return;
      }
      const base64 = data.base64 as string;
      if (!base64 || base64.length === 0) {
        Alert.alert('Error', 'Empty pass data from server.');
        return;
      }

      await addPassToAppleWallet(base64);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      const msg = e?.message || String(err);
      if (msg.includes('E_PASS_LIBRARY_CANNOT_ADD')) {
        Alert.alert('Not Added', 'Pass was not added to Wallet.');
      } else if (msg.includes('E_PASS_LIBRARY_INVALID_DATA')) {
        Alert.alert('Error', 'Invalid pass data received from server.');
      } else if (msg.includes('E_PASS_LIBRARY_UNAVAILABLE')) {
        Alert.alert('Error', 'Apple Wallet is not available on this device.');
      } else {
        Alert.alert('Error', msg || 'Could not add wallet pass.');
      }
    } finally {
      setLoading(false);
    }
  }, [merchantId, userId]);

  return { available, loading, addPass };
}
