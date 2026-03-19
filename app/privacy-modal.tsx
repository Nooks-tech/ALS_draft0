import { useRouter } from 'expo-router';
import { Shield, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function PrivacyModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const isArabic = i18n.language === 'ar';

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'سياسة الخصوصية' : 'Privacy Policy'}</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <View className="items-center mb-6">
            <View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Shield size={32} color={primaryColor} />
            </View>
          </View>
          <Text className="text-slate-600 leading-6 mb-4">
            <Text className="font-bold text-slate-800">{isArabic ? 'آخر تحديث: فبراير 2025' : 'Last updated: February 2025'}</Text>
            {'\n\n'}
            {isArabic ? 'نحن نأخذ خصوصيتك على محمل الجد. توضح هذه السياسة كيف يجمع ALS Coffee معلوماتك الشخصية ويستخدمها ويحميها.' : 'We take your privacy seriously. This policy describes how ALS Coffee collects, uses, and protects your personal information.'}
          </Text>
          <Text className="text-slate-800 font-bold mb-2">{isArabic ? 'المعلومات التي نجمعها' : 'Information We Collect'}</Text>
          <Text className="text-slate-600 leading-6 mb-4">{isArabic ? 'نجمع اسمك ورقم جوالك وبريدك الإلكتروني وعنوان التوصيل ومعلومات الدفع عند إجراء الطلب. كما نجمع بعض بيانات الاستخدام لتحسين تجربة التطبيق.' : 'We collect your name, phone number, email, delivery address, and payment information when you place an order. We also collect usage data to improve our app experience.'}</Text>
          <Text className="text-slate-800 font-bold mb-2">{isArabic ? 'كيف نستخدم بياناتك' : 'How We Use Your Data'}</Text>
          <Text className="text-slate-600 leading-6 mb-4">{isArabic ? 'نستخدم معلوماتك لمعالجة الطلبات والتواصل معك بشأن التوصيل وإرسال العروض الترويجية بموافقتك وتحسين خدماتنا.' : 'Your information is used to process orders, communicate with you about your delivery, send promotional offers (with your consent), and improve our services.'}</Text>
          <Text className="text-slate-800 font-bold mb-2">{isArabic ? 'أمان البيانات' : 'Data Security'}</Text>
          <Text className="text-slate-600 leading-6">{isArabic ? 'نستخدم وسائل تشفير بمعايير معتمدة لحماية بياناتك. تتم معالجة معلومات الدفع بشكل آمن عبر بوابات دفع معتمدة، ولا نقوم بتخزين بيانات بطاقتك الكاملة.' : 'We use industry-standard encryption to protect your data. Payment information is processed securely through certified payment gateways. We never store your full card details.'}</Text>
        </ScrollView>
      </View>
    </View>
  );
}
