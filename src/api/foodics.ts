/**
 * Foodics API client - calls ALS backend which proxies to Foodics
 */
import { api } from './client';

export interface MenuProduct {
  id: string;
  name: string;
  price: number;
  category: string;
  description: string;
  image: string;
  modifierGroups: Array<{
    id: string;
    title: string;
    options: Array<{ name: string; price: number }>;
  }>;
}

export interface MenuResponse {
  products: MenuProduct[];
  categories: string[];
}

export interface Branch {
  id: string;
  name: string;
  address: string;
  distance: string;
}

export interface OrderDiscount {
  reference: string;
  amount: number;
  type: 'amount';
  name?: string;
}

export interface CreateOrderPayload {
  branchId: string;
  orderType: 'delivery' | 'pickup';
  items: Array<{
    productId: string;
    quantity: number;
    options?: Record<string, string>;
    price: number;
  }>;
  customer?: { name: string; phone: string };
  deliveryAddress?: { address: string; lat?: number; lng?: number };
  discount?: OrderDiscount;
}

export const foodicsApi = {
  getMenu: () => api.get<MenuResponse>('/api/foodics/menu'),
  getBranches: () => api.get<Branch[]>('/api/foodics/branches'),
  createOrder: (payload: CreateOrderPayload) =>
    api.post<{ id: string; status: string }>('/api/foodics/orders', payload),
};
