/**
 * Merchant branding – Option A: one build per merchant.
 * Uses build-time values (from EAS/env: logoUrl, primaryColor, accentColor, backgroundColor in extra)
 * as initial state and fallback. When nooksweb API is configured, fetches and can override so
 * merchant can update branding without a new build.
 * See docs/NOOKSWEB_APIS_AND_BEHAVIOR.md and docs/MULTI_MERCHANT_ONE_APP_OR_MANY_BUILDS.md.
 */
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useMerchant } from './MerchantContext';

function getExtra(): Record<string, unknown> | undefined {
  return Constants.expoConfig?.extra as Record<string, unknown> | undefined;
}

function getBaseUrl() {
  const extra = getExtra();
  return (
    (typeof extra?.nooksApiBaseUrl === 'string' ? extra.nooksApiBaseUrl : '') ||
    process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
    ''
  );
}

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
  const extra = getExtra();
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
  const baseUrl = useMemo(() => getBaseUrl(), []);
  const [branding, setBranding] = useState<MerchantBranding>(() => getBuildTimeBranding());
  const [loading, setLoading] = useState(false);
  const cacheKey = useMemo(() => `@als_branding_${merchantId || 'default'}`, [merchantId]);

  const fetchBranding = useCallback(async () => {
    if (!baseUrl.trim() || !merchantId.trim()) return;
    setLoading(true);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/branding`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const logo = data.logoUrl ?? data.logo_url;
        const primary = data.primaryColor ?? data.primary_color;
        const accent = data.accentColor ?? data.accent_color;
        const bg = data.backgroundColor ?? data.background_color;
        const nextBranding = {
          logoUrl: typeof logo === 'string' && logo ? logo : branding.logoUrl,
          primaryColor: typeof primary === 'string' && primary ? primary : branding.primaryColor,
          accentColor: typeof accent === 'string' && accent ? accent : branding.accentColor,
          backgroundColor: typeof bg === 'string' && bg ? bg : branding.backgroundColor,
        };
        setBranding((prev) => ({
          logoUrl: typeof logo === 'string' && logo ? logo : prev.logoUrl,
          primaryColor: typeof primary === 'string' && primary ? primary : prev.primaryColor,
          accentColor: typeof accent === 'string' && accent ? accent : prev.accentColor,
          backgroundColor: typeof bg === 'string' && bg ? bg : prev.backgroundColor,
        }));
        await AsyncStorage.setItem(cacheKey, JSON.stringify(nextBranding));
      }
    } catch {
      // Keep current (build-time) branding
    } finally {
      setLoading(false);
    }
  }, [merchantId, baseUrl, cacheKey, branding.logoUrl, branding.primaryColor, branding.accentColor, branding.backgroundColor]);

  useEffect(() => {
    AsyncStorage.getItem(cacheKey).then((raw) => {
      if (!raw) return;
      try {
        const cached = JSON.parse(raw) as Partial<MerchantBranding>;
        setBranding((prev) => ({
          logoUrl: typeof cached.logoUrl === 'string' ? cached.logoUrl : prev.logoUrl,
          primaryColor: typeof cached.primaryColor === 'string' && cached.primaryColor ? cached.primaryColor : prev.primaryColor,
          accentColor: typeof cached.accentColor === 'string' && cached.accentColor ? cached.accentColor : prev.accentColor,
          backgroundColor:
            typeof cached.backgroundColor === 'string' && cached.backgroundColor ? cached.backgroundColor : prev.backgroundColor,
        }));
      } catch {
        // Ignore invalid cache payload
      }
    });
    fetchBranding();
  }, [fetchBranding, cacheKey]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchBranding();
    });
    return () => sub.remove();
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
