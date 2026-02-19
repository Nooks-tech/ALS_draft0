/**
 * Foodics API Service
 * Docs: https://developers.foodics.com
 * Fetches menu, branches, and creates orders.
 */

const FOODICS_BASE = process.env.FOODICS_API_URL || 'https://api.foodics.com/v2';
const FOODICS_TOKEN = process.env.FOODICS_API_TOKEN;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (!FOODICS_TOKEN) {
    throw Object.assign(new Error('FOODICS_API_TOKEN not configured'), { status: 400 });
  }

  const url = `${FOODICS_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${FOODICS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw Object.assign(
      new Error(data?.message || data?.errors?.[0]?.detail || `Foodics API error ${res.status}`),
      { status: res.status }
    );
  }

  return data as T;
}

export interface FoodicsProduct {
  id: string;
  name: string;
  price: number;
  description?: string;
  image?: string;
  product_options?: Array<{
    id: string;
    name: string;
    product_option_values: Array<{
      id: string;
      value: string;
      price_modifier: number;
    }>;
  }>;
}

export interface FoodicsBranch {
  id: string;
  name: string;
  address?: string;
}

export interface FoodicsMenuResponse {
  products?: { data: FoodicsProduct[] };
}

export interface FoodicsBranchesResponse {
  branches?: { data: FoodicsBranch[] };
}

function mapFoodicsToAppProduct(p: FoodicsProduct) {
  const modifierGroups = (p.product_options || []).map((opt) => ({
    id: opt.id,
    title: opt.name,
    options: opt.product_option_values.map((v) => ({
      name: v.value,
      price: v.price_modifier || 0,
    })),
  }));

  return {
    id: String(p.id),
    name: p.name,
    price: Number(p.price),
    category: 'Menu',
    description: p.description || '',
    image: p.image || '',
    modifierGroups,
  };
}

export const foodicsService = {
  async getMenu() {
    const data = await request<FoodicsMenuResponse>('/products?include=product_options');
    const products = data?.products?.data || [];
    return {
      products: products.map(mapFoodicsToAppProduct),
      categories: [...new Set(products.map((p) => (p as any).category?.name).filter(Boolean))],
    };
  },

  async getBranches() {
    const data = await request<FoodicsBranchesResponse>('/branches');
    const branches = data?.branches?.data || [];
    return branches.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address || '',
      distance: '',
    }));
  },

  async createOrder(payload: {
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
    discount?: {
      reference: string;
      amount: number;
      type: 'amount';
      name?: string;
    };
  }) {
    if (!FOODICS_TOKEN) {
      console.log('[Foodics] No token – using mock order (add FOODICS_API_TOKEN for real orders)');
      return { id: `mock-${Date.now()}`, status: 'pending' };
    }
    const body: Record<string, unknown> = {
      branch_id: payload.branchId,
      type: payload.orderType,
      order_items: payload.items.map((i) => ({
        product_id: i.productId,
        quantity: i.quantity,
        product_option_values: i.options
          ? Object.entries(i.options).map(([optId, valId]) => ({ product_option_value_id: valId }))
          : [],
        price: i.price,
      })),
      customer: payload.customer,
      delivery_address: payload.deliveryAddress,
    };
    if (payload.discount && payload.discount.amount > 0) {
      body.discount = {
        reference: payload.discount.reference,
        amount: payload.discount.amount,
        type: payload.discount.type,
        name: payload.discount.name || 'App Promo',
      };
    }
    return request('/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
