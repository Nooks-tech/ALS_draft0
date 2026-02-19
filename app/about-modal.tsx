import { useRouter } from 'expo-router';
import { Coffee, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function AboutModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">About</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <View className="items-center mb-8">
            <View className="w-20 h-20 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Coffee size={40} color={primaryColor} />
            </View>
            <Text className="text-2xl font-bold text-slate-800 mt-4">ALS Coffee</Text>
            <Text className="text-slate-500">Version 1.0.0</Text>
          </View>
          <Text className="text-slate-600 leading-6 mb-4">
            ALS Coffee brings you the finest specialty coffee and fresh pastries, crafted with care and delivered to your doorstep. 
            From our signature Spanish Latte to hand-poured V60, every cup tells a story of quality and passion.
          </Text>
          <Text className="text-slate-600 leading-6">
            Founded in the heart of Dammam, we're committed to sourcing the best beans and creating a welcoming space for coffee lovers across the Kingdom.
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}
