/**
 * Merchant context – which Nooks merchant (store/brand) the customer is ordering from.
 * Used for: Nooks API (branches/branding), order attribution.
 *
 * Resolution order:
 * 1. Build-time env (EXPO_PUBLIC_MERCHANT_ID) — set by the EAS build workflow per merchant.
 * 2. URL param (?merchant=xxx) — for local dev / deep-link override.
 * 3. Auto-discover from nooksweb API (/api/public/discover) — when neither 1 nor 2 is set.
 */
import * as Linking from 'expo-linking';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import Constants from 'expo-constants';

function getExtra(): Record<string, unknown> | undefined {
  return Constants.expoConfig?.extra as Record<string, unknown> | undefined;
}

const ENV_MERCHANT_ID =
  Constants.expoConfig?.extra?.merchantId ??
  Constants.expoConfig?.extra?.merchant_id ??
  process.env.EXPO_PUBLIC_MERCHANT_ID ??
  '';

function getNooksBaseUrl(): string {
  const extra = getExtra();
  return (
    (typeof extra?.nooksApiBaseUrl === 'string' ? extra.nooksApiBaseUrl : '') ||
    process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
    ''
  );
}

/** Option A builds set this; then we never override from URL or API. */
const isBuildTimeMerchant = ENV_MERCHANT_ID.trim() !== '';

function parseMerchantFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = Linking.parse(url);
    const q = parsed.queryParams ?? {};
    const m = q.merchant ?? q.merchant_id;
    return typeof m === 'string' ? m.trim() || null : null;
  } catch {
    return null;
  }
}

export type MerchantContextType = {
  /** Current merchant id or slug (from env or URL). Empty = single-tenant / default. */
  merchantId: string;
};

const MerchantContext = createContext<MerchantContextType>({
  merchantId: ENV_MERCHANT_ID,
});

export const MerchantProvider = ({ children }: { children: ReactNode }) => {
  const [merchantId, setMerchantId] = useState(ENV_MERCHANT_ID);

  useEffect(() => {
    if (isBuildTimeMerchant) return;

    // Try URL param first
    Linking.getInitialURL().then((url) => {
      const fromUrl = parseMerchantFromUrl(url);
      if (fromUrl) {
        setMerchantId(fromUrl);
        return;
      }
      // No build-time ID and no URL param — auto-discover from nooksweb
      const baseUrl = getNooksBaseUrl().replace(/\/$/, '');
      if (!baseUrl) return;
      fetch(`${baseUrl}/api/public/discover`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const mid = data?.merchantId;
          if (typeof mid === 'string' && mid.trim()) {
            setMerchantId(mid.trim());
          }
        })
        .catch(() => {});
    });

    const sub = Linking.addEventListener('url', (e) => {
      const fromUrl = parseMerchantFromUrl(e.url);
      if (fromUrl) setMerchantId(fromUrl);
    });
    return () => sub.remove();
  }, []);

  return (
    <MerchantContext.Provider value={{ merchantId }}>
      {children}
    </MerchantContext.Provider>
  );
};

export const useMerchant = () => useContext(MerchantContext);
