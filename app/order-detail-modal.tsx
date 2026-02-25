import { useLocalSearchParams, useRouter } from 'expo-router';
import { AlertTriangle, Map, MapPin, RefreshCw, Store, Truck, X, XCircle } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useOrders } from '../src/context/OrdersContext';
import { useCart } from '../src/context/CartContext';
import { getBranchOtoConfig } from '../src/config/branchOtoConfig';
import { OrderStatusStepper } from '../src/components/order/OrderStatusStepper';
import { OrderTrackingMap } from '../src/components/order/OrderTrackingMap';
import { otoApi, type OTOOrderStatusResponse } from '../src/api/oto';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

const CANCEL_WINDOW_MS = 2 * 60 * 1000;

export default function OrderDetailModal() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const { orders, cancelOrder } = useOrders();
  const { setCartFromOrder } = useCart();
  const order = orders.find((o) => o.id === orderId);
  const { primaryColor } = useMerchantBranding();
  const [otoStatus, setOtoStatus] = useState<OTOOrderStatusResponse | null>(null);
  const [cancelTimeLeft, setCancelTimeLeft] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const driverPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!order?.createdAt || order.status !== 'Preparing') return;
    const updateTimer = () => {
      const elapsed = Date.now() - new Date(order.createdAt!).getTime();
      const remaining = Math.max(0, CANCEL_WINDOW_MS - elapsed);
      setCancelTimeLeft(remaining);
      if (remaining <= 0 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    updateTimer();
    timerRef.current = setInterval(updateTimer, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [order?.createdAt, order?.status]);

  useEffect(() => {
    if (!order?.otoId) return;
    let cancelled = false;
    const poll = () => {
      otoApi.getOrderStatus(order.otoId!).then((data) => {
        if (!cancelled) setOtoStatus(data);
      }).catch(() => {});
    };
    poll();
    if (order.status === 'Out for delivery') {
      driverPollRef.current = setInterval(poll, 10000);
    }
    return () => {
      cancelled = true;
      if (driverPollRef.current) clearInterval(driverPollRef.current);
    };
  }, [order?.otoId, order?.status]);

  const handleCancel = useCallback(async () => {
    if (!order) return;
    Alert.alert(
      'Cancel Order',
      'Are you sure you want to cancel this order? You will receive a full refund.',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            const result = await cancelOrder(order.id);
            setCancelling(false);
            if (!result.success) {
              Alert.alert('Cannot Cancel', result.error || 'Failed to cancel order.');
            }
          },
        },
      ]
    );
  }, [order, cancelOrder]);

  const handleReorder = useCallback(() => {
    if (!order) return;
    setCartFromOrder({
      items: order.items,
      orderType: order.orderType,
      branchId: order.branchId,
      branchName: order.branchName,
      deliveryAddress: order.deliveryAddress,
      deliveryLat: order.deliveryLat,
      deliveryLng: order.deliveryLng,
    });
    router.back();
    router.replace('/(tabs)/menu');
  }, [order, setCartFromOrder, router]);

  if (!order) {
    return (
      <View className="flex-1 justify-center items-center bg-black/60">
        <View className="bg-white rounded-2xl p-6 max-w-sm">
          <Text className="text-slate-600 text-center">Order not found</Text>
          <TouchableOpacity onPress={() => router.back()} className="mt-4 py-3 rounded-xl" style={{ backgroundColor: primaryColor }}>
            <Text className="text-white font-bold text-center">Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const branchOto = getBranchOtoConfig(order.branchId ?? '', order.branchName);
  const branchLat = branchOto?.lat;
  const branchLon = branchOto?.lon;
  const isOutForDelivery = order.status === 'Out for delivery';
  const showDriverMap = isOutForDelivery && order.orderType === 'delivery' && branchLat != null && branchLon != null;
  const canShowMap = branchLat != null && branchLon != null;
  const canCancel = order.status === 'Preparing' && cancelTimeLeft > 0;
  const cancelMinutes = Math.floor(cancelTimeLeft / 60000);
  const cancelSeconds = Math.floor((cancelTimeLeft % 60000) / 1000);

  const statusBadgeColors: Record<string, { bg: string; text: string }> = {
    Preparing: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
    Ready: { bg: 'bg-green-100', text: 'text-green-700' },
    'Out for delivery': { bg: 'bg-blue-100', text: 'text-blue-700' },
    Delivered: { bg: 'bg-gray-100', text: 'text-gray-600' },
    Cancelled: { bg: 'bg-red-100', text: 'text-red-600' },
    'On Hold': { bg: 'bg-orange-100', text: 'text-orange-600' },
  };
  const badge = statusBadgeColors[order.status] ?? { bg: 'bg-slate-100', text: 'text-slate-600' };

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Order #{order.id.replace('order-', '')}</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-4" showsVerticalScrollIndicator={false}>
          <View className="mb-4">
            <View className={`self-start px-3 py-1 rounded-full ${badge.bg}`}>
              <Text className={`text-xs font-bold ${badge.text}`}>{order.status}</Text>
            </View>
            <Text className="text-slate-500 text-sm mt-2">{order.date}</Text>
          </View>

          {/* Cancellation reason (shown when merchant cancels) */}
          {order.status === 'Cancelled' && order.cancellationReason && (
            <View className="mb-4 p-4 bg-red-50 rounded-xl flex-row items-start">
              <AlertTriangle size={18} color="#EF4444" style={{ marginTop: 2 }} />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-red-700 text-sm">
                  {order.cancelledBy === 'merchant' ? 'Cancelled by store' : 'You cancelled this order'}
                </Text>
                <Text className="text-red-600 text-sm mt-1">{order.cancellationReason}</Text>
                {order.refundStatus === 'refunded' && (
                  <Text className="text-green-600 text-xs mt-1 font-medium">Refund processed</Text>
                )}
                {order.refundStatus === 'pending_manual' && (
                  <Text className="text-amber-600 text-xs mt-1 font-medium">Refund being processed</Text>
                )}
              </View>
            </View>
          )}

          {/* Cancel button with countdown (2-min window) */}
          {canCancel && (
            <TouchableOpacity
              onPress={handleCancel}
              disabled={cancelling}
              className="mb-4 py-3 px-4 rounded-xl border border-red-200 bg-red-50 flex-row items-center justify-center"
            >
              {cancelling ? (
                <ActivityIndicator size="small" color="#EF4444" />
              ) : (
                <>
                  <XCircle size={18} color="#EF4444" />
                  <Text className="text-red-600 font-bold ml-2">
                    Cancel Order ({cancelMinutes}:{cancelSeconds.toString().padStart(2, '0')})
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {order.status !== 'Cancelled' && order.status !== 'On Hold' && (
            <View className="mb-6">
              <Text className="font-bold text-slate-800 mb-3">Order status</Text>
              <OrderStatusStepper status={order.status as any} orderType={order.orderType} accentColor={primaryColor} />
            </View>
          )}

          {order.orderType === 'delivery' && order.deliveryAddress && (
            <View className="flex-row items-start mb-4 p-3 bg-slate-50 rounded-xl">
              <MapPin size={18} color={primaryColor} style={{ marginTop: 2 }} />
              <Text className="flex-1 ml-2 text-slate-700">{order.deliveryAddress}</Text>
            </View>
          )}
          {order.orderType === 'pickup' && order.branchName && (
            <View className="flex-row items-start mb-4 p-3 bg-slate-50 rounded-xl">
              <Store size={18} color="#F59E0B" style={{ marginTop: 2 }} />
              <Text className="flex-1 ml-2 text-slate-700">{order.branchName}</Text>
            </View>
          )}

          {/* Live driver tracking map – shown for "Out for delivery" status */}
          {showDriverMap && (
            <View className="mb-6">
              <View className="flex-row items-center gap-2 mb-3">
                <Truck size={18} color={primaryColor} />
                <Text className="font-bold text-slate-800">Live driver tracking</Text>
              </View>
              <OrderTrackingMap
                branchLat={branchLat}
                branchLon={branchLon}
                deliveryLat={order.deliveryLat}
                deliveryLng={order.deliveryLng}
                driverLat={otoStatus?.driverLat}
                driverLon={otoStatus?.driverLon}
                branchName={order.branchName}
                accentColor={primaryColor}
              />
              <View className="flex-row flex-wrap gap-2 mt-2">
                <View className="flex-row items-center gap-1.5">
                  <View className="w-2 h-2 rounded-full bg-amber-500" />
                  <Text className="text-slate-500 text-xs">Branch</Text>
                </View>
                {(order.deliveryLat != null && order.deliveryLng != null) && (
                  <View className="flex-row items-center gap-1.5">
                    <View className="w-2 h-2 rounded-full" style={{ backgroundColor: primaryColor }} />
                    <Text className="text-slate-500 text-xs">Your location</Text>
                  </View>
                )}
                {otoStatus?.driverLat != null && (
                  <View className="flex-row items-center gap-1.5">
                    <View className="w-2 h-2 rounded-full bg-indigo-500" />
                    <Text className="text-slate-500 text-xs">Driver</Text>
                  </View>
                )}
              </View>
              {otoStatus?.estimatedDeliveryTime && (
                <Text className="text-slate-500 text-xs mt-2">
                  ETA: {otoStatus.estimatedDeliveryTime}
                </Text>
              )}
            </View>
          )}

          {/* Static map for non-delivery-tracking orders */}
          {canShowMap && !showDriverMap && order.status !== 'Cancelled' && (
            <View className="mb-6">
              <View className="flex-row items-center gap-2 mb-3">
                <Map size={18} color={primaryColor} />
                <Text className="font-bold text-slate-800">Track on map</Text>
              </View>
              <OrderTrackingMap
                branchLat={branchLat}
                branchLon={branchLon}
                deliveryLat={order.deliveryLat}
                deliveryLng={order.deliveryLng}
                driverLat={otoStatus?.driverLat}
                driverLon={otoStatus?.driverLon}
                branchName={order.branchName}
                accentColor={primaryColor}
              />
            </View>
          )}

          <Text className="font-bold text-slate-800 mb-2">Items</Text>
          {order.items.map((item) => (
            <View key={item.uniqueId} className="flex-row items-center mb-3 p-3 bg-slate-50 rounded-xl">
              <Image source={{ uri: item.image }} className="w-12 h-12 rounded-lg bg-slate-200" />
              <View className="flex-1 ml-3">
                <Text className="font-bold text-slate-800">{item.name}</Text>
                <Text className="text-slate-500 text-sm">
                  {item.quantity} × {item.price} SAR = {item.price * item.quantity} SAR
                </Text>
              </View>
              <Text className="font-bold" style={{ color: primaryColor }}>{item.price * item.quantity} SAR</Text>
            </View>
          ))}

          <View className="border-t border-slate-200 mt-4 pt-4 flex-row justify-between">
            <Text className="font-bold text-slate-800">Total</Text>
            <Text className="font-bold text-lg" style={{ color: primaryColor }}>{order.total} SAR</Text>
          </View>

          {/* Re-order button for Delivered or Cancelled orders */}
          {(order.status === 'Delivered' || order.status === 'Cancelled') && (
            <TouchableOpacity
              onPress={handleReorder}
              className="mt-6 py-4 rounded-2xl items-center flex-row justify-center gap-2"
              style={{ backgroundColor: primaryColor }}
            >
              <RefreshCw size={18} color="white" />
              <Text className="text-white font-bold text-base">Re-order</Text>
            </TouchableOpacity>
          )}

          <View className="h-6" />
        </ScrollView>
      </View>
    </View>
  );
}
