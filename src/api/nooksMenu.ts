import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type NooksMenuItem = {
  id: string;
  foodics_product_id?: string | null;
  name: string;
  description?: string | null;
  price: number;
  image_url?: string | null;
  sort_order?: number;
  is_available?: boolean;
  modifier_groups?: Array<{
    id: string;
    title: string;
    options: {
      id?: string;
      name: string;
      price: number;
    }[];
  }[];
};

export type NooksMenuCategory = {
  id: string;
  name: string;
  sort_order?: number;
  items: NooksMenuItem[];
};

export type NooksMenuResponse = {
  source?: 'live' | 'mock' | 'empty';
  categories: NooksMenuCategory[];
};

export async function fetchNooksMenu(merchantId: string): Promise<NooksMenuResponse | null> {
  if (!BASE_URL.trim() || !merchantId.trim()) return null;
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/menu`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as NooksMenuResponse | null;
    if (!data || !Array.isArray(data.categories)) return null;
    return data;
  } catch {
    return null;
  }
}
