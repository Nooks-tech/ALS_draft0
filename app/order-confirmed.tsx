import { useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle, Edit3 } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useOrders } from '../src/context/OrdersContext';
import { useCart } from '../src/context/CartContext';

const EDIT_WINDOW_MS = 5000;

export default function OrderConfirmedScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { orders, holdOrderForEdit, resumeHeldOrder } = useOrders();
  const { setCartFromOrder } = useCart();
  const [timeLeft, setTimeLeft] = useState(EDIT_WINDOW_MS);
  const [editPressed, setEditPressed] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const order = orders.find((o) => o.id === orderId);

  useEffect(() => {
    const start = Date.now();
    timerRef.current = setInterval(() => {
      const remaining = Math.max(0, EDIT_WINDOW_MS - (Date.now() - start));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
          if (!editPressed) {
            router.replace('/(tabs)/orders');
          }
        });
      }
    }, 100);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleEdit = useCallback(async () => {
    if (!order || editPressed) return;
    setEditPressed(true);
    if (timerRef.current) clearInterval(timerRef.current);

    const result = await holdOrderForEdit(order.id);
    if (result.success) {
      setCartFromOrder({
        items: order.items,
        orderType: order.orderType,
        branchId: order.branchId,
        branchName: order.branchName,
        deliveryAddress: order.deliveryAddress,
        deliveryLat: order.deliveryLat,
        deliveryLng: order.deliveryLng,
      });
      router.dismissAll();
      router.replace('/cart');
    } else {
      Alert.alert('Cannot Edit', result.error || 'The edit window has expired.');
      router.replace('/(tabs)/orders');
    }
  }, [order, holdOrderForEdit, setCartFromOrder, router, editPressed]);

  const progressWidth = (timeLeft / EDIT_WINDOW_MS) * 100;
  const seconds = Math.ceil(timeLeft / 1000);

  return (
    <SafeAreaView className="flex-1 bg-white items-center justify-center px-6">
      <View className="items-center mb-8">
        <View className="w-20 h-20 rounded-full items-center justify-center mb-4" style={{ backgroundColor: `${primaryColor}15` }}>
          <CheckCircle size={48} color={primaryColor} />
        </View>
        <Text className="text-2xl font-bold text-slate-900 mb-2">Order Confirmed!</Text>
        <Text className="text-slate-500 text-center">
          Your order is being prepared. You'll be notified of status updates.
        </Text>
      </View>

      {/* Edit order button - fades out after 5 seconds */}
      {timeLeft > 0 && !editPressed && (
        <Animated.View style={{ opacity: fadeAnim, width: '100%' }}>
          <TouchableOpacity
            onPress={handleEdit}
            className="py-4 rounded-2xl items-center flex-row justify-center gap-2 border-2 mb-4"
            style={{ borderColor: primaryColor }}
          >
            <Edit3 size={20} color={primaryColor} />
            <Text className="font-bold text-base" style={{ color: primaryColor }}>
              Edit your order ({seconds}s)
            </Text>
          </TouchableOpacity>
          <View className="h-1 bg-slate-100 rounded-full overflow-hidden">
            <View
              className="h-full rounded-full"
              style={{ backgroundColor: primaryColor, width: `${progressWidth}%` }}
            />
          </View>
        </Animated.View>
      )}

      {editPressed && (
        <View className="items-center">
          <Text className="text-slate-500">Preparing your cart for editing...</Text>
        </View>
      )}

      <TouchableOpacity
        onPress={() => router.replace('/(tabs)/orders')}
        className="mt-8 py-4 px-8 rounded-2xl"
        style={{ backgroundColor: primaryColor }}
      >
        <Text className="text-white font-bold text-base">View Orders</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
