import { useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, Package } from 'lucide-react-native';
import { ActivityIndicator, FlatList, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OrderCard } from '../../src/components/order/OrderCard';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useOrders } from '../../src/context/OrdersContext';

export default function OrdersScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { orders, loading } = useOrders();
  const { primaryColor, backgroundColor, textColor } = useMerchantBranding();
  const isArabic = i18n.language === 'ar';
  const BackIcon = isArabic ? ArrowRight : ArrowLeft;

  const orderItemsSummary = (order: (typeof orders)[0]) =>
    order.items.map((i) => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');

  return (
    <View className="flex-1" style={{ backgroundColor }}>
      <StatusBar barStyle="dark-content" />
      <View
        className="pt-14 pb-4 px-5 items-center"
        style={{ backgroundColor, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', flexDirection: 'row' }}
      >
        <TouchableOpacity
          onPress={() => router.replace('/(tabs)/menu')}
          className="p-2"
          style={{ marginEnd: 16 }}
        >
          <BackIcon size={24} color={textColor} />
        </TouchableOpacity>
        <Text className="text-xl font-bold" style={{ color: textColor }}>{t('orders')}</Text>
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
          renderItem={({ item }) => {
            // Show the gross bill the customer cleared — item.total
            // is post-cashback (= what the card+wallet had to cover)
            // which understates the real outlay for cashback orders.
            // Adding cashbackPaidSar back gets the pre-discount total
            // the customer was committed to, matching the detail
            // modal's "Total paid" line and what they actually see
            // billed across all payment sources.
            const grossTotal =
              (typeof item.total === 'number' ? item.total : 0) +
              (typeof item.cashbackPaidSar === 'number' ? item.cashbackPaidSar : 0);
            return (
              <OrderCard
                id={item.id.replace('order-', '')}
                status={item.status}
                orderType={item.orderType}
                price={grossTotal}
                date={item.date}
                items={orderItemsSummary(item)}
                refundStatus={item.refundStatus}
                onPress={() => router.push({ pathname: '/order-detail-modal', params: { orderId: item.id } })}
              />
            );
          }}
          contentContainerStyle={orders.length === 0 ? { flexGrow: 1, padding: 16 } : { padding: 16 }}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center px-8">
              <Package size={52} color="#94a3b8" />
              <Text className="text-xl mt-4 text-center" style={{ color: '#94a3b8' }}>
                {t('no_orders_yet')}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
