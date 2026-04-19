import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type DeliveryQuoteRequest = {
  merchantId: string;
  branchId: string;
  items: Array<{ product_id: string; quantity: number; price_sar?: number }>;
  lat: number;
  lng: number;
  address?: string;
};

export type DeliveryQuoteResult =
  | { feeSar: number; withinServiceArea: true }
  | { feeSar: null; withinServiceArea: false; reason: 'out_of_zone' | 'error' };

/**
 * Ask nooksweb to run Foodics `orders_calculator` for this address and
 * return the delivery fee. The fee is what the merchant configured
 * inside Foodics for the zone that contains `lat/lng`. If the address
 * falls outside every zone, `withinServiceArea: false` comes back and
 * the checkout screen disables the Pay button.
 *
 * Network / 5xx failures resolve to `{ withinServiceArea: false,
 * reason: 'error' }` so the caller can show a generic "couldn't compute
 * fee" state without crashing.
 */
export async function getDeliveryQuote(
  req: DeliveryQuoteRequest,
): Promise<DeliveryQuoteResult> {
  if (!BASE_URL.trim() || !req.merchantId || !req.branchId) {
    return { feeSar: null, withinServiceArea: false, reason: 'error' };
  }
  try {
    const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(
      req.merchantId,
    )}/delivery-quote`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branchId: req.branchId,
        items: req.items,
        lat: req.lat,
        lng: req.lng,
        address: req.address,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      feeSar?: number | null;
      withinServiceArea?: boolean;
      reason?: 'out_of_zone' | 'error';
      error?: string;
    };
    if (!res.ok) {
      return { feeSar: null, withinServiceArea: false, reason: 'error' };
    }
    if (data.withinServiceArea && typeof data.feeSar === 'number') {
      return { feeSar: data.feeSar, withinServiceArea: true };
    }
    return {
      feeSar: null,
      withinServiceArea: false,
      reason: data.reason === 'out_of_zone' ? 'out_of_zone' : 'error',
    };
  } catch {
    return { feeSar: null, withinServiceArea: false, reason: 'error' };
  }
}
