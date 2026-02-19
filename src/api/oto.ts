/**
 * OTO API client - delivery options and request delivery
 */
import { api } from './client';

export interface OTODeliveryOption {
  deliveryOptionId: number;
  deliveryCompanyName: string;
  deliveryOptionName: string;
  serviceType: string;
  price: number;
  avgDeliveryTime: string;
}

export interface OTORequestDeliveryPayload {
  orderId: string;
  amount: number;
  pickupLocationCode?: string;
  deliveryOptionId?: number;
  customer: { name: string; phone: string; email?: string };
  deliveryAddress: { address: string; lat?: number; lng?: number; city?: string };
  branch: { name: string; address?: string };
  items: Array<{ name: string; price: number; quantity: number }>;
}

export interface OTOOrderResponse {
  success: boolean;
  otoId: number;
}

export interface OTOOrderStatusResponse {
  orderId?: string;
  status?: string;
  deliveryCompanyName?: string;
  trackingNumber?: string;
  estimatedDeliveryTime?: string;
  printAWBUrl?: string;
  driverLat?: number;
  driverLon?: number;
}

export const otoApi = {
  getDeliveryOptions: (params: {
    originCity: string;
    destinationCity: string;
    weight?: number;
    originLat?: number;
    originLon?: number;
    destinationLat?: number;
    destinationLon?: number;
  }) => {
    const q: Record<string, string> = {
      originCity: params.originCity,
      destinationCity: params.destinationCity,
    };
    if (params.weight != null) q.weight = String(params.weight);
    if (params.originLat != null) q.originLat = String(params.originLat);
    if (params.originLon != null) q.originLon = String(params.originLon);
    if (params.destinationLat != null) q.destinationLat = String(params.destinationLat);
    if (params.destinationLon != null) q.destinationLon = String(params.destinationLon);
    return api.get<{ options: OTODeliveryOption[] }>('/api/oto/delivery-options?' + new URLSearchParams(q).toString());
  },

  requestDelivery: (payload: OTORequestDeliveryPayload) =>
    api.post<OTOOrderResponse>('/api/oto/request-delivery', payload),

  getOrderStatus: (otoId: number) =>
    api.get<OTOOrderStatusResponse>(`/api/oto/order-status?otoId=${encodeURIComponent(otoId)}`),
};
