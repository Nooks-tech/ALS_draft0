import { useRouter } from 'expo-router';
import { Mail, MessageCircle, Phone, X } from 'lucide-react-native';
import { Linking, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function ContactModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, contactEmail, contactPhone, contactWhatsapp } = useMerchantBranding();
  const isArabic = i18n.language === 'ar';

  const hasPhone = !!contactPhone;
  const hasEmail = !!contactEmail;
  const hasWhatsapp = !!contactWhatsapp;
  const hasAny = hasPhone || hasEmail || hasWhatsapp;

  const formatWhatsappUrl = (num: string) => {
    const digits = num.replace(/[^0-9]/g, '');
    return `https://wa.me/${digits}`;
  };

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View
          className="items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100"
          style={{ flexDirection: 'row' }}
        >
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'اتصل بنا' : 'Contact Us'}</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginEnd: -8 }}
          >
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {hasAny ? (
            <>
              <Text className="text-slate-600 mb-6">{isArabic ? 'تواصل معنا عبر أي من القنوات التالية. عادةً نرد خلال بضع ساعات.' : 'Reach out through any of the channels below. We typically respond within a few hours.'}</Text>
              {hasPhone && (
                <TouchableOpacity onPress={() => Linking.openURL(`tel:${contactPhone}`)} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
                  <View className="p-3 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}><Phone size={24} color={primaryColor} /></View>
                  <View><Text className="font-bold text-slate-800">{isArabic ? 'اتصل بنا' : 'Call Us'}</Text><Text className="text-slate-500 text-sm">{contactPhone}</Text></View>
                </TouchableOpacity>
              )}
              {hasEmail && (
                <TouchableOpacity onPress={() => Linking.openURL(`mailto:${contactEmail}`)} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
                  <View className="p-3 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}><Mail size={24} color={primaryColor} /></View>
                  <View><Text className="font-bold text-slate-800">{isArabic ? 'البريد الإلكتروني' : 'Email'}</Text><Text className="text-slate-500 text-sm">{contactEmail}</Text></View>
                </TouchableOpacity>
              )}
              {hasWhatsapp && (
                <TouchableOpacity onPress={() => Linking.openURL(formatWhatsappUrl(contactWhatsapp))} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
                  <View className="p-3 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}><MessageCircle size={24} color={primaryColor} /></View>
                  <View><Text className="font-bold text-slate-800">WhatsApp</Text><Text className="text-slate-500 text-sm">{isArabic ? 'تحدث معنا فوراً' : 'Chat with us instantly'}</Text></View>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <View className="items-center py-8">
              <Text className="text-slate-400 text-center">{isArabic ? 'لا توجد معلومات اتصال متاحة حالياً.' : 'No contact information available at the moment.'}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
