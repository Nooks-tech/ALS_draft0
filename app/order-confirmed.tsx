import { useRouter } from 'expo-router';
import { CheckCircle } from 'lucide-react-native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function OrderConfirmedScreen() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';

  return (
    <SafeAreaView className="flex-1 bg-white items-center justify-center px-6">
      <View className="items-center mb-8">
        <View className="w-20 h-20 rounded-full items-center justify-center mb-4" style={{ backgroundColor: `${primaryColor}15` }}>
          <CheckCircle size={48} color={primaryColor} />
        </View>
        <Text className="text-2xl font-bold text-slate-900 mb-2">{isArabic ? 'تم تأكيد الطلب!' : 'Order Confirmed!'}</Text>
        <Text className="text-slate-500 text-center">
          {isArabic ? 'طلبك قيد التحضير الآن.' : 'Your order is now being prepared.'}
        </Text>
      </View>

      <TouchableOpacity
        onPress={() => router.replace('/(tabs)/orders')}
        className="mt-8 py-4 px-8 rounded-2xl"
        style={{ backgroundColor: primaryColor }}
      >
        <Text className="text-white font-bold text-base">{isArabic ? 'عرض الطلبات' : 'View Orders'}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
