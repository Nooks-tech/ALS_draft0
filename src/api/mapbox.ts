/**
 * Mapbox API - Geocoding for address search
 * Uses public token from EXPO_PUBLIC_MAPBOX_TOKEN
 */
import Constants from 'expo-constants';

const MAPBOX_TOKEN = Constants.expoConfig?.extra?.mapboxToken || process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '';

export interface MapboxPlace {
  id: string;
  place_name: string;
  center: [number, number]; // [lng, lat]
  address?: string;
}

export interface MapboxSearchResult {
  address: string;
  lat: number;
  lng: number;
}

export async function searchAddresses(query: string, limit = 5): Promise<MapboxSearchResult[]> {
  if (!MAPBOX_TOKEN) return [];
  if (!query || query.trim().length < 3) return [];

  const encoded = encodeURIComponent(query.trim());
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${MAPBOX_TOKEN}&limit=${limit}&types=address,place,locality,neighborhood`;

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) return [];
  const features = data.features || [];

  return features.map((f: any) => ({
    address: f.place_name,
    lng: f.center[0],
    lat: f.center[1],
  }));
}

export async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  if (!MAPBOX_TOKEN) return null;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_TOKEN}&limit=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const features = data.features || [];
    return features[0]?.place_name ?? null;
  } catch {
    return null;
  }
}
