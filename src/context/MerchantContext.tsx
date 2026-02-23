/**
 * Merchant context – which Nooks merchant (store/brand) the customer is ordering from.
 * Used for: Nooks API (branches/branding), order attribution.
 *
 * Option A (one build per merchant): When EXPO_PUBLIC_MERCHANT_ID is set at build time,
 * that merchant is fixed for this app; URL params are ignored.
 * Option B / dev: When env merchant is empty, merchant can come from URL (e.g. ?merchant=xxx).
 */
import * as Linking from 'expo-linking';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import Constants from 'expo-constants';

const ENV_MERCHANT_ID =
  Constants.expoConfig?.extra?.merchantId ??
  process.env.EXPO_PUBLIC_MERCHANT_ID ??
  '';

/** Option A builds set this; then we never override from URL. */
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
    if (isBuildTimeMerchant) return; // Option A: do not override from URL
    Linking.getInitialURL().then((url) => {
      const fromUrl = parseMerchantFromUrl(url);
      if (fromUrl) setMerchantId(fromUrl);
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
