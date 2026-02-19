import { useRouter } from 'expo-router';
import { Mail, MessageCircle, Phone, X } from 'lucide-react-native';
import { Linking, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function ContactModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Contact Us</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <Text className="text-slate-600 mb-6">Reach out through any of the channels below. We typically respond within a few hours.</Text>
          <TouchableOpacity onPress={() => Linking.openURL('tel:+966500000000')} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
            <View className="p-3 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}><Phone size={24} color={primaryColor} /></View>
            <View><Text className="font-bold text-slate-800">Call Us</Text><Text className="text-slate-500 text-sm">+966 50 000 0000</Text></View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL('mailto:support@alscoffee.sa')} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
            <View className="p-3 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}><Mail size={24} color={primaryColor} /></View>
            <View><Text className="font-bold text-slate-800">Email</Text><Text className="text-slate-500 text-sm">support@alscoffee.sa</Text></View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL('https://wa.me/966500000000')} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
            <View className="p-3 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}><MessageCircle size={24} color={primaryColor} /></View>
            <View><Text className="font-bold text-slate-800">WhatsApp</Text><Text className="text-slate-500 text-sm">Chat with us instantly</Text></View>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </View>
  );
}
