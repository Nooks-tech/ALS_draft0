/**
 * Nooks order API – submit customer orders to Nooks when they expose POST /api/public/orders.
 * When EXPO_PUBLIC_NOOKS_API_BASE_URL is not set, all calls no-op.
 * See docs/NOOKSWEB_ANSWERS.md for payload shape.
 */
import Constants from 'expo-constants';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type NooksOrderItem = {
  product_id: string;
  name: string;
  quantity: number;
  price_sar: number;
};

export type NooksOrderPayload = {
  merchant_id: string;
  branch_id: string;
  customer_id?: string;
  total_sar: number;
  status: string;
  order_type?: 'delivery' | 'pickup';
  branch_name?: string;
  delivery_fee?: number;
  payment_id?: string;
  payment_method?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  items: NooksOrderItem[];
  promo_code?: string;
  delivery_address?: string;
  delivery_lat?: number;
  delivery_lng?: number;
  delivery_city?: string;
};

export function buildNooksOrderPayload(
  order: {
    merchantId?: string;
    branchId?: string;
    total: number;
    items: { id: string; name: string; price: number; quantity: number }[];
    orderType?: 'delivery' | 'pickup';
    branchName?: string;
    deliveryFee?: number;
    promoCode?: string;
    paymentId?: string;
    paymentMethod?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    deliveryAddress?: string;
    deliveryLat?: number;
    deliveryLng?: number;
  },
  customerId?: string,
  deliveryCity?: string
): NooksOrderPayload | null {
  if (!order.merchantId || !order.branchId) return null;
  return {
    merchant_id: order.merchantId,
    branch_id: order.branchId,
    total_sar: order.total,
    status: 'pending',
    ...(order.orderType ? { order_type: order.orderType } : {}),
    ...(order.branchName ? { branch_name: order.branchName } : {}),
    ...(order.deliveryFee != null ? { delivery_fee: order.deliveryFee } : {}),
    items: order.items.map((i) => ({
      product_id: i.id,
      name: i.name,
      quantity: i.quantity,
      price_sar: i.price,
    })),
    ...(order.promoCode && { promo_code: order.promoCode }),
    ...(order.paymentId && { payment_id: order.paymentId }),
    ...(order.paymentMethod && { payment_method: order.paymentMethod }),
    ...(order.customerName && { customer_name: order.customerName }),
    ...(order.customerPhone && { customer_phone: order.customerPhone }),
    ...(order.customerEmail && { customer_email: order.customerEmail }),
    ...(order.deliveryAddress && { delivery_address: order.deliveryAddress }),
    ...(order.deliveryLat != null && { delivery_lat: order.deliveryLat }),
    ...(order.deliveryLng != null && { delivery_lng: order.deliveryLng }),
    ...(deliveryCity && { delivery_city: deliveryCity }),
    ...(customerId ? { customer_id: customerId } : {}),
  };
}

/** Fire-and-forget. No-op if BASE_URL not set or request fails. */
export async function submitOrderToNooks(payload: NooksOrderPayload): Promise<void> {
  if (!BASE_URL.trim()) return;
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/orders`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('[Nooks] Order submit failed:', res.status, await res.text());
    }
  } catch (e) {
    console.warn('[Nooks] Order submit error:', e);
  }
}
