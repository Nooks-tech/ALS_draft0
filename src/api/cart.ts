/**
 * Cart sync — talks to the ALS server's /api/cart route.
 *
 * Phase D: the cart is persisted server-side per (merchant, customer)
 * so the abandonment cron can drive the 15-min reminder push and the
 * 1-hour cleanup. The local AsyncStorage cache in CartContext stays
 * (for offline-resilience + instant UI), but the server is the
 * source of truth across devices and survives app reinstalls.
 */

import { supabase } from './supabase';
import { API_URL } from './config';

export type ServerCartItem = {
  id: string;
  name: string;
  price: number;
  basePrice?: number;
  quantity: number;
  image?: string;
  uniqueId: string;
  customizations?: Record<string, unknown>;
  rewardMilestoneId?: string;
  rewardOriginalPriceSar?: number;
};

export type ServerCart = {
  items: ServerCartItem[];
  subtotal_sar: number;
  branch_id: string | null;
  order_type: 'delivery' | 'pickup' | 'drivethru' | null;
  updated_at: string | null;
  notified_at: string | null;
};

// Wrong env var name (EXPO_PUBLIC_API_BASE_URL) silently no-op'd this
// whole file for weeks — saveServerCart returned false at the first
// guard, customer_carts stayed empty platform-wide, the abandoned-
// cart cron had nothing to chase. API_URL from config.ts is the same
// ALS-server base URL every other api/* file uses (EXPO_PUBLIC_API_URL
// with the dev fallback).
const API_BASE = API_URL ?? '';

async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function fetchServerCart(merchantId: string): Promise<ServerCart | null> {
  if (!API_BASE || !merchantId) return null;
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${API_BASE.replace(/\/$/, '')}/api/cart?merchantId=${encodeURIComponent(merchantId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    return (await res.json()) as ServerCart;
  } catch {
    return null;
  }
}

export async function saveServerCart(
  merchantId: string,
  payload: {
    items: ServerCartItem[];
    subtotal_sar: number;
    branch_id: string | null;
    order_type: 'delivery' | 'pickup' | 'drivethru' | null;
  },
): Promise<boolean> {
  if (!API_BASE || !merchantId) return false;
  const token = await getAccessToken();
  if (!token) return false;
  try {
    const res = await fetch(
      `${API_BASE.replace(/\/$/, '')}/api/cart?merchantId=${encodeURIComponent(merchantId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteServerCart(merchantId: string): Promise<boolean> {
  if (!API_BASE || !merchantId) return false;
  const token = await getAccessToken();
  if (!token) return false;
  try {
    const res = await fetch(
      `${API_BASE.replace(/\/$/, '')}/api/cart?merchantId=${encodeURIComponent(merchantId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
