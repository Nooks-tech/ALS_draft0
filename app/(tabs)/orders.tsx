import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { ActivityIndicator, FlatList, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OrderCard } from '../../src/components/order/OrderCard';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useOrders } from '../../src/context/OrdersContext';

export default function OrdersScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { orders, loading } = useOrders();
  const { primaryColor } = useMerchantBranding();

  const orderItemsSummary = (order: (typeof orders)[0]) =>
    order.items.map((i) => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');

  return (
    <View className="flex-1 bg-slate-50">
      <StatusBar barStyle="dark-content" />
      <View className="pt-14 pb-4 px-5 bg-white border-b border-slate-100 flex-row items-center">
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color="#334155" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-slate-800">Orders</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center py-12">
          <ActivityIndicator size="large" color={primaryColor} />
          <Text className="text-slate-500 mt-3">{t('orders_loading')}</Text>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <OrderCard
              id={item.id.replace('order-', '')}
              status={item.status}
              price={item.total}
              date={item.date}
              items={orderItemsSummary(item)}
              onPress={() => router.push({ pathname: '/order-detail-modal', params: { orderId: item.id } })}
            />
          )}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <View className="items-center py-12">
              <Text className="text-slate-500">{t('no_orders_yet')}</Text>
              <Text className="text-slate-400 text-sm mt-1">{t('no_orders_hint')}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}
