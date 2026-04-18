/**
 * Relay customer orders to nooksweb through the ALS backend so the shared
 * internal secret never ships in the mobile app bundle.
 */
import { api } from './client';

export type NooksOrderItem = {
  product_id: string;
  name: string;
  quantity: number;
  price_sar: number;
  customizations?: Record<string, unknown>;
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
    items: { id: string; name: string; price: number; quantity: number; customizations?: Record<string, unknown> }[];
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
    items: order.items.map((i) => {
      // Send the product's own base unit price — Foodics adds modifier
      // surcharges itself from options[]. See server/routes/orders.ts for
      // the matching logic on the other relay path.
      const rawBase = (i as { basePrice?: number }).basePrice;
      let basePrice: number;
      if (typeof rawBase === 'number' && Number.isFinite(rawBase)) {
        basePrice = rawBase;
      } else {
        const modifierSum = Object.values(i.customizations ?? {}).reduce(
          (sum: number, opt: any) => sum + Number(opt?.price ?? 0),
          0,
        );
        basePrice = Math.max(0, Number(i.price ?? 0) - Number(modifierSum || 0));
      }
      return {
        product_id: i.id,
        name: i.name,
        quantity: i.quantity,
        price_sar: basePrice,
        ...(i.customizations ? { customizations: i.customizations } : {}),
      };
    }),
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

/** Fire-and-forget. Logs failures but never blocks local order history. */
export async function submitOrderToNooks(payload: NooksOrderPayload): Promise<void> {
  try {
    await api.post('/api/orders/relay-to-nooks', payload);
  } catch (e) {
    console.warn('[Nooks] Order submit error:', e);
  }
}
