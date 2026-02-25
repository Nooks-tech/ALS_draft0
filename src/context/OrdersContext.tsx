import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { customerCancelOrder, fetchOrdersForCustomer, holdOrder, insertOrder, resumeOrder, subscribeToOrders, type OrderRow } from '../api/orders';
import { notifyOrderStatusUpdate } from '../utils/orderNotifications';
import type { CartItem } from './CartContext';
import { useAuth } from './AuthContext';

const ORDER_STATUSES = ['Preparing', 'Ready', 'Out for delivery', 'Delivered', 'Cancelled', 'On Hold'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type PlacedOrder = {
  id: string;
  status: OrderStatus;
  total: number;
  date: string;
  items: CartItem[];
  orderType: 'delivery' | 'pickup';
  merchantId?: string;
  branchName?: string;
  branchId?: string;
  deliveryAddress?: string;
  deliveryLat?: number;
  deliveryLng?: number;
  otoId?: number;
  cancellationReason?: string;
  cancelledBy?: string;
  refundStatus?: string;
  createdAt?: string;
  deliveryFee?: number;
  paymentId?: string;
};

export type OrdersContextType = {
  orders: PlacedOrder[];
  loading: boolean;
  addOrder: (order: Omit<PlacedOrder, 'id' | 'date' | 'status'> & { otoId?: number; deliveryFee?: number; paymentId?: string }, generatedId?: string) => void;
  cancelOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  holdOrderForEdit: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  resumeHeldOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>;
};

const OrdersContext = createContext<OrdersContextType | undefined>(undefined);

function formatOrderDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `Today, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

function rowToOrder(row: OrderRow): PlacedOrder {
  const items = (Array.isArray(row.items) ? row.items : []) as Array<Record<string, unknown>>;
  const cartItems: CartItem[] = items.map((it, i) => ({
    id: String(it.id ?? ''),
    name: String(it.name ?? ''),
    price: Number(it.price ?? 0),
    quantity: Number(it.quantity ?? 1),
    image: String(it.image ?? ''),
    uniqueId: String(it.uniqueId ?? `${it.id}-${i}`),
    ...(it.customizations && { customizations: it.customizations as Record<string, unknown> }),
  }));
  const status = ORDER_STATUSES.includes(row.status as OrderStatus) ? (row.status as OrderStatus) : 'Preparing';
  return {
    id: row.id,
    status,
    total: Number(row.total_sar),
    date: formatOrderDate(row.created_at),
    items: cartItems,
    orderType: row.order_type,
    merchantId: row.merchant_id ?? undefined,
    branchName: row.branch_name ?? undefined,
    branchId: row.branch_id ?? undefined,
    deliveryAddress: row.delivery_address ?? undefined,
    deliveryLat: row.delivery_lat ?? undefined,
    deliveryLng: row.delivery_lng ?? undefined,
    otoId: row.oto_id ?? undefined,
    cancellationReason: row.cancellation_reason ?? undefined,
    cancelledBy: row.cancelled_by ?? undefined,
    refundStatus: row.refund_status ?? undefined,
    createdAt: row.created_at,
    deliveryFee: row.delivery_fee ?? undefined,
    paymentId: row.payment_id ?? undefined,
  };
}

export const OrdersProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [orders, setOrders] = useState<PlacedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const customerId = user?.id ?? null;

  useEffect(() => {
    if (!customerId) {
      setOrders([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchOrdersForCustomer(customerId).then((rows) => {
      if (!cancelled) {
        setOrders(rows.map(rowToOrder));
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  useEffect(() => {
    if (!customerId) return;
    channelRef.current = subscribeToOrders(
      customerId,
      (row) => setOrders((prev) => [rowToOrder(row), ...prev.filter((o) => o.id !== row.id)]),
      (row) => {
        setOrders((prev) => prev.map((o) => (o.id === row.id ? rowToOrder(row) : o)));
        notifyOrderStatusUpdate(row.id, row.status);
      }
    );
    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [customerId]);

  const addOrder = useCallback(
    (order: Omit<PlacedOrder, 'id' | 'date' | 'status'> & { otoId?: number; deliveryFee?: number; paymentId?: string }, generatedId?: string) => {
      const id = generatedId ?? `order-${Date.now()}`;
      const now = new Date().toISOString();
      const date = formatOrderDate(now);
      const status: OrderStatus = 'Preparing';
      const placed: PlacedOrder = {
        ...order,
        id,
        date,
        status,
        createdAt: now,
      };
      setOrders((prev) => [placed, ...prev]);

      if (customerId && customerId !== 'guest') {
        insertOrder({
          id,
          merchant_id: order.merchantId ?? null,
          branch_id: order.branchId ?? null,
          branch_name: order.branchName ?? null,
          customer_id: customerId,
          total_sar: order.total,
          status,
          items: order.items,
          order_type: order.orderType,
          delivery_address: order.deliveryAddress ?? null,
          delivery_lat: order.deliveryLat ?? null,
          delivery_lng: order.deliveryLng ?? null,
          delivery_city: null,
          oto_id: order.otoId ?? null,
          delivery_fee: order.deliveryFee ?? null,
          payment_id: order.paymentId ?? null,
        });
      }
    },
    [customerId]
  );

  const cancelOrder = useCallback(async (orderId: string) => {
    try {
      const result = await customerCancelOrder(orderId);
      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'Cancelled' as OrderStatus, cancelledBy: 'customer', cancellationReason: 'Cancelled by customer', refundStatus: result.refundStatus } : o))
        );
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to cancel' };
    }
  }, []);

  const holdOrderForEdit = useCallback(async (orderId: string) => {
    try {
      const result = await holdOrder(orderId);
      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'On Hold' as OrderStatus } : o))
        );
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to hold' };
    }
  }, []);

  const resumeHeldOrder = useCallback(async (orderId: string) => {
    try {
      const result = await resumeOrder(orderId);
      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: 'Preparing' as OrderStatus } : o))
        );
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to resume' };
    }
  }, []);

  return (
    <OrdersContext.Provider value={{ orders, loading, addOrder, cancelOrder, holdOrderForEdit, resumeHeldOrder }}>
      {children}
    </OrdersContext.Provider>
  );
};

export const useOrders = () => {
  const ctx = useContext(OrdersContext);
  if (!ctx) throw new Error('useOrders must be used within OrdersProvider');
  return ctx;
};
