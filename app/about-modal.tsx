import { useRouter } from 'expo-router';
import { Coffee, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function AboutModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, aboutText, cafeName } = useMerchantBranding();
  const isArabic = i18n.language === 'ar';

  const displayName = cafeName || 'Nooks App';

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View
          className="items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100"
          style={{ flexDirection: 'row' }}
        >
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'عن التطبيق' : 'About'}</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginEnd: -8 }}
          >
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <View className="items-center mb-8">
            <View className="w-20 h-20 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Coffee size={40} color={primaryColor} />
            </View>
            <Text className="text-2xl font-bold text-slate-800 mt-4">{displayName}</Text>
            <Text className="text-slate-500">{isArabic ? 'الإصدار 1.0.0' : 'Version 1.0.0'}</Text>
          </View>
          {aboutText ? (
            <Text className="text-slate-600 leading-6">{aboutText}</Text>
          ) : (
            <Text className="text-slate-400 text-center">{isArabic ? 'لا يوجد وصف متاح حالياً.' : 'No description available at the moment.'}</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
