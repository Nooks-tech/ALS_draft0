import { useRouter } from 'expo-router';
import { MessageCircle, X } from 'lucide-react-native';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function SupportModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Support</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <View className="items-center mb-6">
<View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
            <MessageCircle size={32} color={primaryColor} />
            </View>
            <Text className="text-slate-600 text-center mt-4">Having an issue? We're here to help. Send us a message and we'll get back to you within 24 hours.</Text>
          </View>
          <View className="mb-4">
            <Text className="text-slate-500 text-sm font-bold mb-2">Subject</Text>
            <TextInput placeholder="How can we help?" className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium" />
          </View>
          <View className="mb-6">
            <Text className="text-slate-500 text-sm font-bold mb-2">Message</Text>
            <TextInput placeholder="Describe your issue or question..." className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium h-32" multiline textAlignVertical="top" />
          </View>
          <TouchableOpacity className="py-4 rounded-2xl items-center" style={{ backgroundColor: primaryColor }}>
            <Text className="text-white font-bold text-lg">Send Message</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </View>
  );
}
