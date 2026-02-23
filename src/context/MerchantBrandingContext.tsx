/**
 * Merchant branding – Option A: one build per merchant.
 * Uses build-time values (from EAS/env: logoUrl, primaryColor, accentColor, backgroundColor in extra)
 * as initial state and fallback. When nooksweb API is configured, fetches and can override so
 * merchant can update branding without a new build.
 * See docs/NOOKSWEB_APIS_AND_BEHAVIOR.md and docs/MULTI_MERCHANT_ONE_APP_OR_MANY_BUILDS.md.
 */
import Constants from 'expo-constants';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useMerchant } from './MerchantContext';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;

export type MerchantBranding = {
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  /** Screen and card backgrounds; default #f5f5f4 */
  backgroundColor: string;
};

const DEFAULT_BRANDING: MerchantBranding = {
  logoUrl: null,
  primaryColor: '#0D9488',
  accentColor: '#0D9488',
  backgroundColor: '#f5f5f4',
};

/** Build-time branding from app.config.js extra (set by EAS workflow per merchant). */
function getBuildTimeBranding(): MerchantBranding {
  const logo = extra?.logoUrl;
  const primary = typeof extra?.primaryColor === 'string' && extra.primaryColor ? extra.primaryColor : DEFAULT_BRANDING.primaryColor;
  const accent = typeof extra?.accentColor === 'string' && extra.accentColor ? extra.accentColor : DEFAULT_BRANDING.accentColor;
  const bg = typeof extra?.backgroundColor === 'string' && extra.backgroundColor ? extra.backgroundColor : DEFAULT_BRANDING.backgroundColor;
  return {
    logoUrl: typeof logo === 'string' && logo ? logo : null,
    primaryColor: primary,
    accentColor: accent,
    backgroundColor: bg,
  };
}

const MerchantBrandingContext = createContext<MerchantBranding & { loading: boolean }>({
  ...DEFAULT_BRANDING,
  loading: false,
});

export function MerchantBrandingProvider({
  children,
  merchantId,
}: {
  children: ReactNode;
  merchantId: string;
}) {
  const [branding, setBranding] = useState<MerchantBranding>(() => getBuildTimeBranding());
  const [loading, setLoading] = useState(false);

  const fetchBranding = useCallback(async () => {
    if (!BASE_URL.trim() || !merchantId.trim()) return;
    setLoading(true);
    try {
      const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/branding`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          logo_url?: string | null;
          primary_color?: string;
          accent_color?: string;
          background_color?: string;
        };
        setBranding((prev) => ({
          logoUrl: data.logo_url ?? prev.logoUrl,
          primaryColor: data.primary_color ?? prev.primaryColor,
          accentColor: data.accent_color ?? prev.accentColor,
          backgroundColor: data.background_color ?? prev.backgroundColor,
        }));
      }
    } catch {
      // Keep current (build-time) branding
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    fetchBranding();
  }, [fetchBranding]);

  return (
    <MerchantBrandingContext.Provider value={{ ...branding, loading }}>
      {children}
    </MerchantBrandingContext.Provider>
  );
}

export const useMerchantBranding = () => useContext(MerchantBrandingContext);

/** Use inside MerchantProvider. Wraps children with MerchantBrandingProvider using current merchantId. */
export function MerchantBrandingWrapper({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  return <MerchantBrandingProvider merchantId={merchantId}>{children}</MerchantBrandingProvider>;
}
