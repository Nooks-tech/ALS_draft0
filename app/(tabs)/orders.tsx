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
  const { primaryColor, backgroundColor, textColor } = useMerchantBranding();

  const orderItemsSummary = (order: (typeof orders)[0]) =>
    order.items.map((i) => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');

  return (
    <View className="flex-1" style={{ backgroundColor }}>
      <StatusBar barStyle="dark-content" />
      <View
        className="pt-14 pb-4 px-5 flex-row items-center"
        style={{ backgroundColor, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}
      >
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color={textColor} />
        </TouchableOpacity>
        <Text className="text-xl font-bold" style={{ color: textColor }}>Orders</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center py-12">
          <ActivityIndicator size="large" color={primaryColor} />
          <Text className="mt-3" style={{ color: textColor }}>{t('orders_loading')}</Text>
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
              <Text style={{ color: textColor }}>{t('no_orders_yet')}</Text>
              <Text className="text-sm mt-1" style={{ color: textColor }}>{t('no_orders_hint')}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}
