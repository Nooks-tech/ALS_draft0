import { useRouter } from 'expo-router';
import { FileText, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function TermsModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Terms & Conditions</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <View className="items-center mb-6">
            <View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <FileText size={32} color={primaryColor} />
            </View>
          </View>
          <Text className="text-slate-600 leading-6 mb-4">
            <Text className="font-bold text-slate-800">Last updated: February 2025</Text>
            {'\n\n'}By using the ALS Coffee app, you agree to these terms and conditions.
          </Text>
          <Text className="text-slate-800 font-bold mb-2">Orders & Delivery</Text>
          <Text className="text-slate-600 leading-6 mb-4">Orders are subject to availability. We reserve the right to refuse or cancel orders. Delivery times are estimates and may vary. You are responsible for providing accurate delivery information.</Text>
          <Text className="text-slate-800 font-bold mb-2">Payments & Refunds</Text>
          <Text className="text-slate-600 leading-6 mb-4">All payments are processed at the time of order. Refunds are issued for cancelled orders or in cases of our error. Contact support for refund requests within 48 hours of delivery.</Text>
          <Text className="text-slate-800 font-bold mb-2">Promotions</Text>
          <Text className="text-slate-600 leading-6">Promotional offers and discount codes are subject to specific terms. One offer per order unless stated otherwise. ALS Coffee reserves the right to modify or end promotions at any time.</Text>
        </ScrollView>
      </View>
    </View>
  );
}
