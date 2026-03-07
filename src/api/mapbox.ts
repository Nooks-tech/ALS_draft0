/**
 * Geocoding API – Google Maps Geocoding (replaces Mapbox)
 * Uses EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
 *
 * Exports keep the same interface so useMapboxSearch and add-address-modal
 * continue working without changes.
 */
import Constants from 'expo-constants';

const GOOGLE_MAPS_KEY =
  (Constants.expoConfig?.extra as { googleMapsApiKey?: string } | undefined)?.googleMapsApiKey ||
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
  '';

export interface MapboxSearchResult {
  address: string;
  lat: number;
  lng: number;
}

/**
 * Forward geocode: search for addresses matching a query.
 * Uses Google Geocoding API with region bias for Saudi Arabia.
 */
export async function searchAddresses(query: string, limit = 5): Promise<MapboxSearchResult[]> {
  if (!GOOGLE_MAPS_KEY) return [];
  if (!query || query.trim().length < 3) return [];

  const encoded = encodeURIComponent(query.trim());
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_MAPS_KEY}&region=sa&language=en`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.results?.length) return [];

    return data.results.slice(0, limit).map((r: any) => ({
      address: r.formatted_address,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
    }));
  } catch {
    return [];
  }
}

/**
 * Reverse geocode: get a human-readable address from coordinates.
 */
export async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  if (!GOOGLE_MAPS_KEY) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_KEY}&language=en`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) return null;
    return data.results[0].formatted_address ?? null;
  } catch {
    return null;
  }
}
