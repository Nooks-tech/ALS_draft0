import { useLocalSearchParams, useRouter } from 'expo-router';
import { Car, CheckCircle, Utensils } from 'lucide-react-native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function OrderConfirmedScreen() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { i18n } = useTranslation();
  const { orderType } = useLocalSearchParams<{ orderId?: string; orderType?: string }>();
  const isArabic = i18n.language === 'ar';
  const isDrivethru = orderType === 'drivethru';
  const isDineIn = orderType === 'dine_in';

  return (
    <SafeAreaView className="flex-1 bg-white items-center justify-center px-6">
      <View className="items-center mb-6">
        <View className="w-20 h-20 rounded-full items-center justify-center mb-4" style={{ backgroundColor: `${primaryColor}15` }}>
          <CheckCircle size={48} color={primaryColor} />
        </View>
        <Text className="text-2xl font-bold text-slate-900 mb-2">{isArabic ? 'تم تأكيد الطلب!' : 'Order Confirmed!'}</Text>
        <Text className="text-slate-500 text-center">
          {isArabic ? 'طلبك قيد التحضير الآن.' : 'Your order is now being prepared.'}
        </Text>
      </View>

      {/* Dine-in confirmation — they're already at the table, so
          the focus is reassurance that their order is on the way.
          Brand-tinted (matches the Utensils icon in the cart). */}
      {isDineIn && (
        <View
          className="w-full rounded-2xl border p-4 mb-2"
          style={{
            backgroundColor: `${primaryColor}15`,
            borderColor: `${primaryColor}40`,
          }}
        >
          <View className="flex-row items-start">
            <Utensils size={20} color={primaryColor} style={{ marginTop: 2 }} />
            <View className="flex-1 ms-3">
              <Text className="font-bold text-base mb-1" style={{ color: primaryColor }}>
                {isArabic ? 'طلبك في الطريق إلى طاولتك' : "Your order's on its way to your table"}
              </Text>
              <Text className="text-sm leading-5 text-slate-700">
                {isArabic
                  ? 'ابقَ في مكانك — سيقدم لك المتجر طلبك بعد قليل.'
                  : "Sit tight — the store will bring your order over shortly."}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Drivethru reminder — the cashier has no way to see the
          customer is physically there until the customer taps
          "I've arrived" on the order page. Surface that ahead of
          time so they don't drive up expecting to be served
          immediately. Amber card to read as informational, not as
          a warning/error. */}
      {isDrivethru && (
        <View
          className="w-full rounded-2xl border p-4 mb-2"
          style={{
            backgroundColor: '#FEF3C7',
            borderColor: '#FCD34D',
          }}
        >
          <View className="flex-row items-start">
            <Car size={20} color="#B45309" style={{ marginTop: 2 }} />
            <View className="flex-1 ms-3">
              <Text className="font-bold text-base mb-1" style={{ color: '#92400E' }}>
                {isArabic ? 'لا تنسَ إعلامنا عند وصولك' : "Don't forget to notify us"}
              </Text>
              <Text className="text-sm leading-5" style={{ color: '#92400E' }}>
                {isArabic
                  ? 'لما توصل المتجر بسيارتك، افتح صفحة الطلبات واضغط زر "وصلت" داخل بطاقة الطلب عشان الكاشير يعرف.'
                  : "When you pull up at the store, open the Orders page and tap the “I've arrived” button on your order card so the cashier knows."}
              </Text>
            </View>
          </View>
        </View>
      )}

      <TouchableOpacity
        onPress={() => {
          // /order-confirmed is itself a modal stack screen (see
          // app/_layout.tsx presentation: 'modal'). A plain replace
          // to /(tabs)/orders from inside the modal stack just
          // swaps the modal's content, which renders the Orders
          // tab AS a modal sheet (back arrow on top, swipe-down
          // handle, doesn't switch the bottom-tab selection).
          // Dismiss the modal first, then switch tabs from the
          // root context.
          router.dismissAll();
          router.replace('/(tabs)/orders');
        }}
        className="mt-6 py-4 px-8 rounded-2xl"
        style={{ backgroundColor: primaryColor }}
      >
        <Text className="text-white font-bold text-base">{isArabic ? 'عرض الطلبات' : 'View Orders'}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
