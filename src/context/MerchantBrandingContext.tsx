/**
 * Merchant branding – fetches branding colors from the nooksweb API.
 * Build-time values (from EAS/env) are used as initial state.
 * Runtime fetch always overrides when nooksweb API is reachable.
 * Branding is cached in AsyncStorage so it loads instantly on subsequent opens.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import React, { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useMerchant } from './MerchantContext';

const BRANDING_CACHE_PREFIX = '@als_branding_';

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

function parseBrandingResponse(data: Record<string, unknown>): MerchantBranding {
  return {
    logoUrl: typeof data.logoUrl === 'string' ? data.logoUrl
      : typeof data.logo_url === 'string' ? data.logo_url
      : null,
    primaryColor: normalizeColor(data.primaryColor) ?? normalizeColor(data.primary_color) ?? DEFAULT_BRANDING.primaryColor,
    accentColor: normalizeColor(data.accentColor) ?? normalizeColor(data.accent_color) ?? DEFAULT_BRANDING.accentColor,
    backgroundColor: normalizeColor(data.backgroundColor) ?? normalizeColor(data.background_color) ?? DEFAULT_BRANDING.backgroundColor,
    menuCardColor: normalizeColor(data.menuCardColor) ?? normalizeColor(data.menu_card_color) ?? DEFAULT_BRANDING.menuCardColor,
    textColor: normalizeColor(data.textColor) ?? normalizeColor(data.text_color) ?? DEFAULT_BRANDING.textColor,
  };
}

const MerchantBrandingContext = createContext<MerchantBranding & { loading: boolean }>({
  ...DEFAULT_BRANDING,
  loading: false,
});

const BASE_URL = getBaseUrl().replace(/\/$/, '');

export function MerchantBrandingProvider({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  const [branding, setBranding] = useState<MerchantBranding>(getBuildTimeBranding);
  const [loading, setLoading] = useState(true);
  const runIdRef = useRef(0);
  const merchantIdRef = useRef(merchantId);
  const cacheLoaded = useRef(false);
  merchantIdRef.current = merchantId;

  // Load cached branding instantly on mount
  useEffect(() => {
    if (!merchantId) return;
    const key = `${BRANDING_CACHE_PREFIX}${merchantId}`;
    AsyncStorage.getItem(key)
      .then((cached) => {
        if (cached && !cacheLoaded.current) {
          try {
            const parsed = JSON.parse(cached) as MerchantBranding;
            if (parsed.primaryColor) {
              setBranding(parsed);
            }
          } catch { /* ignore corrupt cache */ }
        }
        cacheLoaded.current = true;
      })
      .catch(() => { cacheLoaded.current = true; });
  }, [merchantId]);

  useEffect(() => {
    if (!BASE_URL || !merchantId) {
      setLoading(false);
      return;
    }

    const id = ++runIdRef.current;
    let cancelled = false;

    const doFetch = async () => {
      const url = `${BASE_URL}/api/public/merchants/${encodeURIComponent(merchantId)}/branding`;
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as Record<string, unknown>;
      if (cancelled) return;
      const parsed = parseBrandingResponse(data);
      setBranding(parsed);
      const key = `${BRANDING_CACHE_PREFIX}${merchantId}`;
      AsyncStorage.setItem(key, JSON.stringify(parsed)).catch(() => {});
    };

    setLoading(true);
    doFetch()
      .catch(() => {})
      .finally(() => { if (id === runIdRef.current) setLoading(false); });

    return () => { cancelled = true; };
  }, [merchantId]);

  useEffect(() => {
    if (!BASE_URL) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const mid = merchantIdRef.current;
      if (!mid) return;
      const url = `${BASE_URL}/api/public/merchants/${encodeURIComponent(mid)}/branding`;
      fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) return;
          const parsed = parseBrandingResponse(data as Record<string, unknown>);
          setBranding(parsed);
          AsyncStorage.setItem(`${BRANDING_CACHE_PREFIX}${mid}`, JSON.stringify(parsed)).catch(() => {});
        })
        .catch(() => {});
    });
    return () => sub.remove();
  }, []);

  const value = useMemo(() => ({ ...branding, loading }), [branding, loading]);

  return (
    <MerchantBrandingContext.Provider value={value}>
      {children}
    </MerchantBrandingContext.Provider>
  );
}

export const useMerchantBranding = () => useContext(MerchantBrandingContext);

export function MerchantBrandingWrapper({ children }: { children: ReactNode }) {
  return <MerchantBrandingProvider>{children}</MerchantBrandingProvider>;
}
