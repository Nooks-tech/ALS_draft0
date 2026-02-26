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
  const logo = extra?.logoUrl ?? process.env.EXPO_PUBLIC_LOGO_URL;
  const primary =
    (typeof extra?.primaryColor === 'string' && extra.primaryColor) ||
    process.env.EXPO_PUBLIC_PRIMARY_COLOR ||
    DEFAULT_BRANDING.primaryColor;
  const accent =
    (typeof extra?.accentColor === 'string' && extra.accentColor) ||
    process.env.EXPO_PUBLIC_ACCENT_COLOR ||
    DEFAULT_BRANDING.accentColor;
  const bg =
    (typeof extra?.backgroundColor === 'string' && extra.backgroundColor) ||
    process.env.EXPO_PUBLIC_BACKGROUND_COLOR ||
    DEFAULT_BRANDING.backgroundColor;
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
        const data = (await res.json()) as Record<string, unknown>;
        const logo = data.logoUrl ?? data.logo_url;
        const primary = data.primaryColor ?? data.primary_color;
        const accent = data.accentColor ?? data.accent_color;
        const bg = data.backgroundColor ?? data.background_color;
        setBranding((prev) => ({
          logoUrl: typeof logo === 'string' && logo ? logo : prev.logoUrl,
          primaryColor: typeof primary === 'string' && primary ? primary : prev.primaryColor,
          accentColor: typeof accent === 'string' && accent ? accent : prev.accentColor,
          backgroundColor: typeof bg === 'string' && bg ? bg : prev.backgroundColor,
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
