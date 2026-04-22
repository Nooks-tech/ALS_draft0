import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type DriverLocationSnapshot = {
  driver_lat: number | null;
  driver_lng: number | null;
  driver_location_updated_at: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  status: string | null;
};

/**
 * Poll nooksweb for the driver's latest GPS while an order is out for
 * delivery. Returns all nulls if Foodics DMS hasn't started posting
 * location for this order yet, which is fine — the map renders with
 * destination only until coords start coming through.
 */
export async function fetchDriverLocation(
  merchantId: string,
  orderId: string,
): Promise<DriverLocationSnapshot | null> {
  if (!BASE_URL.trim() || !merchantId || !orderId) return null;
  try {
    const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(
      merchantId,
    )}/orders/${encodeURIComponent(orderId)}/driver-location`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as DriverLocationSnapshot | null;
    return data;
  } catch {
    return null;
  }
}
