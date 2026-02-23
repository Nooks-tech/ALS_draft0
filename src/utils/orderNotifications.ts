/**
 * Local notifications for order status updates (e.g. from Supabase Realtime).
 * Uses expo-notifications; request permissions in app _layout.
 */
import * as Notifications from 'expo-notifications';

const STATUS_MESSAGES: Record<string, string> = {
  Preparing: 'Your order is being prepared',
  Ready: 'Your order is ready for pickup / out for delivery',
  'Out for delivery': 'Your order is on the way',
  Delivered: 'Your order has been delivered',
  Cancelled: 'Your order was cancelled',
};

export async function notifyOrderStatusUpdate(orderId: string, status: string): Promise<void> {
  try {
    const shortId = orderId.replace('order-', '');
    const body = STATUS_MESSAGES[status] ?? `Order #${shortId} is now ${status}`;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Order update',
        body,
        data: { orderId, status },
      },
      trigger: null,
    });
  } catch {
    // Ignore if notifications not set up or permission denied
  }
}
