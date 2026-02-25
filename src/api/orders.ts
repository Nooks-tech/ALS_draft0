/**
 * Customer orders – persist to Supabase (customer_orders table) when user is logged in.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { api } from './client';
import { supabase } from './supabase';

export type OrderRow = {
  id: string;
  merchant_id: string | null;
  branch_id: string | null;
  branch_name: string | null;
  customer_id: string;
  total_sar: number;
  status: string;
  items: unknown;
  order_type: 'delivery' | 'pickup';
  delivery_address: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_city: string | null;
  oto_id: number | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  refund_status: string | null;
  delivery_fee: number | null;
  payment_id: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderInsert = {
  id: string;
  merchant_id?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  customer_id: string;
  total_sar: number;
  status: string;
  items: unknown;
  order_type: 'delivery' | 'pickup';
  delivery_address?: string | null;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
  delivery_city?: string | null;
  oto_id?: number | null;
  delivery_fee?: number | null;
  payment_id?: string | null;
};

export async function fetchOrdersForCustomer(customerId: string): Promise<OrderRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('customer_orders')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[Orders] Fetch error:', error.message);
    return [];
  }
  return (data ?? []) as OrderRow[];
}

export async function insertOrder(row: OrderInsert): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from('customer_orders').insert({
    id: row.id,
    merchant_id: row.merchant_id ?? null,
    branch_id: row.branch_id ?? null,
    branch_name: row.branch_name ?? null,
    customer_id: row.customer_id,
    total_sar: row.total_sar,
    status: row.status,
    items: row.items,
    order_type: row.order_type,
    delivery_address: row.delivery_address ?? null,
    delivery_lat: row.delivery_lat ?? null,
    delivery_lng: row.delivery_lng ?? null,
    delivery_city: row.delivery_city ?? null,
    oto_id: row.oto_id ?? null,
    delivery_fee: row.delivery_fee ?? null,
    payment_id: row.payment_id ?? null,
  });
  if (error) {
    console.warn('[Orders] Insert error:', error.message);
    return false;
  }
  return true;
}

export async function customerCancelOrder(orderId: string): Promise<{ success: boolean; refundStatus?: string; error?: string }> {
  return api.post<{ success: boolean; refundStatus?: string; error?: string }>(`/api/orders/${orderId}/customer-cancel`, {});
}

export async function holdOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  return api.post<{ success: boolean; error?: string }>(`/api/orders/${orderId}/hold`, {});
}

export async function resumeOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  return api.post<{ success: boolean; error?: string }>(`/api/orders/${orderId}/resume`, {});
}

export async function getOrderStatus(orderId: string): Promise<{
  status: string;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  canCustomerCancel: boolean;
  cancelTimeRemaining: number;
}> {
  return api.get(`/api/orders/${orderId}/status`);
}

export function subscribeToOrders(
  customerId: string,
  onInsert: (row: OrderRow) => void,
  onUpdate: (row: OrderRow) => void
): RealtimeChannel | null {
  if (!supabase) return null;
  const channel = supabase
    .channel('customer_orders')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'customer_orders',
        filter: `customer_id=eq.${customerId}`,
      },
      (payload) => {
        onInsert(payload.new as OrderRow);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'customer_orders',
        filter: `customer_id=eq.${customerId}`,
      },
      (payload) => {
        onUpdate(payload.new as OrderRow);
      }
    )
    .subscribe();
  return channel;
}
