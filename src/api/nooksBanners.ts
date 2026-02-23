/**
 * Nooks public API – marketing banners (slider, popup, etc.).
 * GET {NOOKS_BASE}/api/public/merchants/{merchantId}/banners
 * Used in Offers tab and menu slider when Nooks Marketing Studio is available.
 * Returns [] when EXPO_PUBLIC_NOOKS_API_BASE_URL is not set or endpoint fails.
 */
import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type BannerPlacement = 'slider' | 'popup' | 'offers';

export type NooksBanner = {
  id: string;
  image_url: string;
  title?: string;
  subtitle?: string;
  placement?: BannerPlacement;
  deep_link?: string; // Foodics category or product link
};

export async function fetchNooksBanners(merchantId: string): Promise<NooksBanner[]> {
  if (!BASE_URL.trim() || !merchantId.trim()) return [];
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/banners`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as NooksBanner[] | { banners?: NooksBanner[] };
    if (Array.isArray(data)) return data;
    if (data && Array.isArray((data as { banners?: NooksBanner[] }).banners)) return (data as { banners: NooksBanner[] }).banners;
    return [];
  } catch {
    return [];
  }
}
