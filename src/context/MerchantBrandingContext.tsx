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

/** Bump when branding shape changes (e.g. new API fields) so stale cache merges with defaults. */
const BRANDING_CACHE_PREFIX = '@als_branding_v2_';

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
  /** In-app / header logo (app_config.logo_url) */
  logoUrl: string | null;
  /** Launcher / store icon image URL (app_config.app_icon_url) */
  appIconUrl: string | null;
  /** Hex or "none" — home-screen style icon background from dashboard */
  appIconBgColor: string | null;
  /** 20–200: scales logo inside fixed header slot (does not grow header height) */
  inAppLogoScale: number;
  /** 20–150: used for native builds / future in-app icon previews */
  launcherIconScale: number;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  menuCardColor: string;
  textColor: string;
  tabTextColor: string;
  cafeName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactWhatsapp: string | null;
  aboutText: string | null;
};

const DEFAULT_BRANDING: MerchantBranding = {
  logoUrl: null,
  appIconUrl: null,
  appIconBgColor: null,
  inAppLogoScale: 100,
  launcherIconScale: 70,
  primaryColor: '#0D9488',
  accentColor: '#0D9488',
  backgroundColor: '#f5f5f4',
  menuCardColor: '#f5f5f4',
  textColor: '#1f2937',
  tabTextColor: '#ffffff',
  cafeName: null,
  contactEmail: null,
  contactPhone: null,
  contactWhatsapp: null,
  aboutText: null,
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
  const tabText = normalizeColor(extra?.tabTextColor)
    ?? normalizeColor(process.env.EXPO_PUBLIC_TAB_TEXT_COLOR)
    ?? DEFAULT_BRANDING.tabTextColor;
  return {
    logoUrl: typeof logo === 'string' && logo ? logo : null,
    appIconUrl: null,
    appIconBgColor: null,
    inAppLogoScale: 100,
    launcherIconScale: 70,
    primaryColor: primary,
    accentColor: accent,
    backgroundColor: bg,
    menuCardColor: card,
    textColor: text,
    tabTextColor: tabText,
    cafeName: null,
    contactEmail: null,
    contactPhone: null,
    contactWhatsapp: null,
    aboutText: null,
  };
}

function parseAppIconBg(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.toLowerCase() === 'none') return null;
  return normalizeColor(t) ?? null;
}

function parseScale(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseBrandingResponse(data: Record<string, unknown>): MerchantBranding {
  const logoUrl =
    typeof data.logoUrl === 'string' ? data.logoUrl
      : typeof data.logo_url === 'string' ? data.logo_url
      : null;
  const appIconUrl =
    typeof data.appIconUrl === 'string' ? data.appIconUrl
      : typeof data.app_icon_url === 'string' ? data.app_icon_url
      : null;

  return {
    logoUrl,
    appIconUrl,
    appIconBgColor: parseAppIconBg(data.appIconBgColor ?? data.app_icon_bg_color),
    inAppLogoScale: parseScale(data.inAppLogoScale ?? data.in_app_logo_scale, 100, 20, 200),
    launcherIconScale: parseScale(data.launcherIconScale ?? data.launcher_icon_scale, 70, 20, 150),
    primaryColor: normalizeColor(data.primaryColor) ?? normalizeColor(data.primary_color) ?? DEFAULT_BRANDING.primaryColor,
    accentColor: normalizeColor(data.accentColor) ?? normalizeColor(data.accent_color) ?? DEFAULT_BRANDING.accentColor,
    backgroundColor: normalizeColor(data.backgroundColor) ?? normalizeColor(data.background_color) ?? DEFAULT_BRANDING.backgroundColor,
    menuCardColor: normalizeColor(data.menuCardColor) ?? normalizeColor(data.menu_card_color) ?? DEFAULT_BRANDING.menuCardColor,
    textColor: normalizeColor(data.textColor) ?? normalizeColor(data.text_color) ?? DEFAULT_BRANDING.textColor,
    tabTextColor: normalizeColor(data.tabTextColor) ?? normalizeColor(data.tab_text_color) ?? DEFAULT_BRANDING.tabTextColor,
    cafeName: typeof data.cafeName === 'string' ? data.cafeName : typeof data.cafe_name === 'string' ? data.cafe_name : null,
    contactEmail: typeof data.contactEmail === 'string' && data.contactEmail ? data.contactEmail : null,
    contactPhone: typeof data.contactPhone === 'string' && data.contactPhone ? data.contactPhone : null,
    contactWhatsapp: typeof data.contactWhatsapp === 'string' && data.contactWhatsapp ? data.contactWhatsapp : null,
    aboutText: typeof data.aboutText === 'string' && data.aboutText ? data.aboutText : null,
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
            const parsed = JSON.parse(cached) as Partial<MerchantBranding>;
            if (parsed.primaryColor) {
              setBranding({ ...DEFAULT_BRANDING, ...parsed });
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
