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
  /** Menu and list card background; defaults to screen background when not provided */
  menuCardColor: string;
  /** Global text color; default #1f2937 */
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

function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Build-time branding from app.config.js extra (set by EAS workflow per merchant). */
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
    ?? bg;
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
  const enforceBuildCardColor = useMemo(
    () => !sameColor(buildTimeBranding.menuCardColor, buildTimeBranding.backgroundColor),
    [buildTimeBranding.menuCardColor, buildTimeBranding.backgroundColor]
  );
  const [branding, setBranding] = useState<MerchantBranding>(() => buildTimeBranding);
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
        const primary = normalizeColor(data.primaryColor ?? data.primary_color);
        const accent = normalizeColor(data.accentColor ?? data.accent_color);
        const bg = normalizeColor(data.backgroundColor ?? data.background_color);
        const card = normalizeColor(data.menuCardColor ?? data.menu_card_color);
        const text = normalizeColor(data.textColor ?? data.text_color);
        const resolvedBg = bg ?? branding.backgroundColor ?? buildTimeBranding.backgroundColor;
        // Guard against API fallback that returns card == background.
        const apiCard = card && !(enforceBuildCardColor && sameColor(card, resolvedBg)) ? card : null;
        const resolvedCard = apiCard ?? buildTimeBranding.menuCardColor ?? branding.menuCardColor ?? resolvedBg;
        const nextBranding = {
          logoUrl: typeof logo === 'string' && logo ? logo : branding.logoUrl,
          primaryColor: primary ?? branding.primaryColor,
          accentColor: accent ?? branding.accentColor,
          backgroundColor: resolvedBg,
          menuCardColor: resolvedCard,
          textColor: text ?? branding.textColor,
        };
        setBranding((prev) => ({
          logoUrl: typeof logo === 'string' && logo ? logo : prev.logoUrl,
          primaryColor: primary ?? prev.primaryColor,
          accentColor: accent ?? prev.accentColor,
          backgroundColor: resolvedBg,
          menuCardColor: resolvedCard,
          textColor: text ?? prev.textColor,
        }));
        await AsyncStorage.setItem(cacheKey, JSON.stringify(nextBranding));
      }
    } catch {
      // Keep current (build-time) branding
    } finally {
      setLoading(false);
    }
  }, [
    merchantId,
    baseUrl,
    cacheKey,
    branding.logoUrl,
    branding.primaryColor,
    branding.accentColor,
    branding.backgroundColor,
    branding.menuCardColor,
    branding.textColor,
    buildTimeBranding.backgroundColor,
    buildTimeBranding.menuCardColor,
    enforceBuildCardColor,
  ]);

  useEffect(() => {
    AsyncStorage.getItem(cacheKey).then((raw) => {
      if (!raw) return;
      try {
        const cached = JSON.parse(raw) as Partial<MerchantBranding>;
        const cachedBg = normalizeColor(cached.backgroundColor);
        const cachedCard = normalizeColor(cached.menuCardColor);
        const safeCachedCard =
          cachedCard && !(enforceBuildCardColor && sameColor(cachedCard, cachedBg ?? buildTimeBranding.backgroundColor))
            ? cachedCard
            : (enforceBuildCardColor ? buildTimeBranding.menuCardColor : null);
        setBranding((prev) => ({
          logoUrl: typeof cached.logoUrl === 'string' ? cached.logoUrl : prev.logoUrl,
          primaryColor: normalizeColor(cached.primaryColor) ?? prev.primaryColor,
          accentColor: normalizeColor(cached.accentColor) ?? prev.accentColor,
          backgroundColor: cachedBg ?? prev.backgroundColor,
          menuCardColor: safeCachedCard ?? prev.menuCardColor,
          textColor: normalizeColor(cached.textColor) ?? prev.textColor,
        }));
      } catch {
        // Ignore invalid cache payload
      }
    });
    fetchBranding();
  }, [fetchBranding, cacheKey, enforceBuildCardColor, buildTimeBranding.backgroundColor, buildTimeBranding.menuCardColor]);

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
