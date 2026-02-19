/**
 * Merchant branding from Nooks (logo, colors). Fetches when EXPO_PUBLIC_NOOKS_API_BASE_URL
 * and merchantId are set. Fallback to defaults when API not available or not implemented yet.
 * See docs/NOOKSWEB_ANSWERS.md – app_config: logo_url, primary_color, accent_color.
 */
import Constants from 'expo-constants';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useMerchant } from './MerchantContext';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type MerchantBranding = {
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
};

const DEFAULT_BRANDING: MerchantBranding = {
  logoUrl: null,
  primaryColor: '#0D9488',
  accentColor: '#0D9488',
};

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
  const [branding, setBranding] = useState<MerchantBranding>(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(false);

  const fetchBranding = useCallback(async () => {
    if (!BASE_URL.trim() || !merchantId.trim()) return;
    setLoading(true);
    try {
      const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/branding`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { logo_url?: string; primary_color?: string; accent_color?: string };
        setBranding({
          logoUrl: data.logo_url ?? null,
          primaryColor: data.primary_color ?? DEFAULT_BRANDING.primaryColor,
          accentColor: data.accent_color ?? DEFAULT_BRANDING.accentColor,
        });
      }
    } catch {
      // Keep defaults
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
