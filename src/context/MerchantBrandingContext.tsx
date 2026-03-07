/**
 * Merchant branding – Option A: one build per merchant.
 * Uses build-time values (from EAS/env: logoUrl, primaryColor, accentColor, backgroundColor in extra)
 * as initial state and fallback. When nooksweb API is configured, fetches and can override so
 * merchant can update branding without a new build.
 * See docs/NOOKSWEB_APIS_AND_BEHAVIOR.md and docs/MULTI_MERCHANT_ONE_APP_OR_MANY_BUILDS.md.
 */
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  backgroundColor: string;
  menuCardColor: string;
  textColor: string;
};

const DEFAULT_BRANDING: MerchantBranding = {
  logoUrl: null,
  primaryColor: '#0D9488',
  accentColor: '#0D9488',
  backgroundColor: '#f5f5f4',
  menuCardColor: '#f5f5f4',
  textColor: '#1f2937',
};

function normalizeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return value;
  if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return `#${value}`;
  return null;
}

function getBuildTimeBranding(): MerchantBranding {
  const extra = getExtra();
  const logo = extra?.logoUrl ?? process.env.EXPO_PUBLIC_LOGO_URL;
  const primary = normalizeColor(extra?.primaryColor)
    ?? normalizeColor(process.env.EXPO_PUBLIC_PRIMARY_COLOR)
    ?? DEFAULT_BRANDING.primaryColor;
  const accent = normalizeColor(extra?.accentColor)
    ?? normalizeColor(process.env.EXPO_PUBLIC_ACCENT_COLOR)
    ?? DEFAULT_BRANDING.accentColor;
  const bg = normalizeColor(extra?.backgroundColor)
    ?? normalizeColor(process.env.EXPO_PUBLIC_BACKGROUND_COLOR)
    ?? DEFAULT_BRANDING.backgroundColor;
  const card = normalizeColor(extra?.menuCardColor)
    ?? normalizeColor(process.env.EXPO_PUBLIC_MENU_CARD_COLOR)
    ?? DEFAULT_BRANDING.menuCardColor;
  const text = normalizeColor(extra?.textColor)
    ?? normalizeColor(process.env.EXPO_PUBLIC_TEXT_COLOR)
    ?? DEFAULT_BRANDING.textColor;
  return {
    logoUrl: typeof logo === 'string' && logo ? logo : null,
    primaryColor: primary,
    accentColor: accent,
    backgroundColor: bg,
    menuCardColor: card,
    textColor: text,
  };
}

function mergeBranding(prev: MerchantBranding, partial: Partial<MerchantBranding>): MerchantBranding {
  return {
    logoUrl: typeof partial.logoUrl === 'string' && partial.logoUrl ? partial.logoUrl : prev.logoUrl,
    primaryColor: normalizeColor(partial.primaryColor) ?? prev.primaryColor,
    accentColor: normalizeColor(partial.accentColor) ?? prev.accentColor,
    backgroundColor: normalizeColor(partial.backgroundColor) ?? prev.backgroundColor,
    menuCardColor: normalizeColor(partial.menuCardColor) ?? prev.menuCardColor,
    textColor: normalizeColor(partial.textColor) ?? prev.textColor,
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
  const buildTimeBranding = useMemo(() => getBuildTimeBranding(), []);
  const hasBuildTimeColors = useMemo(
    () => buildTimeBranding.primaryColor !== DEFAULT_BRANDING.primaryColor
      || buildTimeBranding.backgroundColor !== DEFAULT_BRANDING.backgroundColor
      || buildTimeBranding.menuCardColor !== DEFAULT_BRANDING.menuCardColor,
    [buildTimeBranding],
  );
  const [branding, setBranding] = useState<MerchantBranding>(() => buildTimeBranding);
  const [loading, setLoading] = useState(false);
  const cacheKey = useMemo(() => `@als_branding_${merchantId || 'default'}`, [merchantId]);
  const runIdRef = useRef(0);

  const fetchFromApi = useCallback(async (signal: { cancelled: boolean }) => {
    if (!baseUrl.trim() || !merchantId.trim()) return;
    const url = `${baseUrl.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/branding`;
    const res = await fetch(url);
    if (!res.ok || signal.cancelled) return;
    const data = (await res.json()) as Record<string, unknown>;
    if (signal.cancelled) return;
    const fetched: Partial<MerchantBranding> = {
      logoUrl: (data.logoUrl ?? data.logo_url) as string | undefined,
      primaryColor: (data.primaryColor ?? data.primary_color) as string | undefined,
      accentColor: (data.accentColor ?? data.accent_color) as string | undefined,
      backgroundColor: (data.backgroundColor ?? data.background_color) as string | undefined,
      menuCardColor: (data.menuCardColor ?? data.menu_card_color) as string | undefined,
      textColor: (data.textColor ?? data.text_color) as string | undefined,
    };
    if (signal.cancelled) return;
    setBranding((prev) => {
      const next = mergeBranding(prev, fetched);
      AsyncStorage.setItem(cacheKey, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [merchantId, baseUrl, cacheKey]);

  /**
   * Sequential load: cache first (fast), then API (authoritative).
   * The API call always runs AFTER the cache load completes, so the API
   * response always wins — no race condition.
   */
  useEffect(() => {
    const id = ++runIdRef.current;
    const signal = { cancelled: false };

    (async () => {
      setLoading(true);

      // Step 1: load from cache for fast initial render (only for local/dev builds)
      if (!hasBuildTimeColors) {
        try {
          const raw = await AsyncStorage.getItem(cacheKey);
          if (raw && !signal.cancelled) {
            const cached = JSON.parse(raw) as Partial<MerchantBranding>;
            setBranding((prev) => mergeBranding(prev, cached));
          }
        } catch {
          // ignore bad cache
        }
      } else {
        AsyncStorage.removeItem(cacheKey).catch(() => {});
      }

      // Step 2: ALWAYS fetch from API — runs after cache, so API values always win
      if (!signal.cancelled) {
        try {
          await fetchFromApi(signal);
        } catch {
          // keep current branding on network error
        }
      }

      if (id === runIdRef.current) setLoading(false);
    })();

    return () => { signal.cancelled = true; };
  }, [fetchFromApi, cacheKey, hasBuildTimeColors]);

  // Re-fetch when app comes back to foreground
  useEffect(() => {
    const signal = { cancelled: false };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchFromApi(signal).catch(() => {});
    });
    return () => {
      signal.cancelled = true;
      sub.remove();
    };
  }, [fetchFromApi]);

  const value = useMemo(() => ({ ...branding, loading }), [branding, loading]);

  return (
    <MerchantBrandingContext.Provider value={value}>
      {children}
    </MerchantBrandingContext.Provider>
  );
}

export const useMerchantBranding = () => useContext(MerchantBrandingContext);

export function MerchantBrandingWrapper({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  return <MerchantBrandingProvider merchantId={merchantId}>{children}</MerchantBrandingProvider>;
}
