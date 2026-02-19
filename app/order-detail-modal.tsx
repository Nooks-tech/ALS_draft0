import { useLocalSearchParams, useRouter } from 'expo-router';
import { Map, MapPin, Store, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useOrders } from '../src/context/OrdersContext';
import { getBranchOtoConfig } from '../src/config/branchOtoConfig';
import { OrderStatusStepper } from '../src/components/order/OrderStatusStepper';
import { OrderTrackingMap } from '../src/components/order/OrderTrackingMap';
import { otoApi, type OTOOrderStatusResponse } from '../src/api/oto';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function OrderDetailModal() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const { orders } = useOrders();
  const order = orders.find((o) => o.id === orderId);
  const { primaryColor } = useMerchantBranding();
  const [otoStatus, setOtoStatus] = useState<OTOOrderStatusResponse | null>(null);
  useEffect(() => {
    if (!order?.otoId) return;
    let cancelled = false;
    otoApi.getOrderStatus(order.otoId).then((data) => {
      if (!cancelled) setOtoStatus(data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [order?.otoId]);

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
  const canShowMap = branchLat != null && branchLon != null;

  const statusBadgeColors: Record<string, { bg: string; text: string }> = {
    Preparing: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
    Ready: { bg: 'bg-green-100', text: 'text-green-700' },
    'Out for delivery': { bg: 'bg-blue-100', text: 'text-blue-700' },
    Delivered: { bg: 'bg-gray-100', text: 'text-gray-600' },
    Cancelled: { bg: 'bg-red-100', text: 'text-red-600' },
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

          {order.status !== 'Cancelled' && (
            <View className="mb-6">
              <Text className="font-bold text-slate-800 mb-3">Order status</Text>
              <OrderStatusStepper status={order.status} orderType={order.orderType} accentColor={primaryColor} />
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

          {canShowMap && (
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
              </View>
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
        </ScrollView>
      </View>
    </View>
  );
}
