import { useRouter } from 'expo-router';
import { Shield, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function PrivacyModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, appName, cafeName, contactEmail } = useMerchantBranding();
  const isArabic = i18n.language === 'ar';
  const brandName = appName || cafeName || 'the app';
  const brandNameAr = appName || cafeName || 'التطبيق';
  const email = contactEmail || 'support@nooks.sa';

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View
          className="items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100"
          style={{ flexDirection: 'row' }}
        >
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'سياسة الخصوصية' : 'Privacy Policy'}</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginEnd: -8 }}
          >
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 24 }} showsVerticalScrollIndicator={false}>
          <View className="items-center mb-6">
            <View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Shield size={32} color={primaryColor} />
            </View>
          </View>

          {isArabic ? (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'آخر تحديث: أبريل ٢٠٢٦'}</Text>
                {'\n\n'}
                {'يلتزم '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' بحماية خصوصية مستخدميه. توضّح هذه السياسة البيانات التي نجمعها وكيفية استخدامها وحقوقك فيما يتعلق بها، وذلك وفقًا لنظام حماية البيانات الشخصية الصادر بالمرسوم الملكي رقم م/١٩ وتاريخ ١٤٤٣/٢/٩هـ ("النظام"). يعمل هذا التطبيق على منصة نُوكس التقنية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١. البيانات التي نجمعها'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نجمع الفئات التالية من البيانات عند استخدامك للتطبيق:\n\n'}
                {'• بيانات الحساب: رقم الهاتف الجوال، الاسم (اختياري)، البريد الإلكتروني (اختياري).\n'}
                {'• بيانات الموقع الجغرافي (GPS): لتحديد عنوان التوصيل وعرض الفروع القريبة.\n'}
                {'• معرّف الجهاز (Device ID): لأغراض الأمان ومنع الاحتيال.\n'}
                {'• بيانات الطلبات: تفاصيل الطلبات السابقة، المفضّلات، وسجل المعاملات.\n'}
                {'• بيانات الدفع: رموز المعاملات (Tokens) فقط — لا نخزّن بيانات البطاقات.\n'}
                {'• بيانات الاستخدام: كيفية تفاعلك مع التطبيق لتحسين الخدمة والأداء.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٢. كيفية استخدام البيانات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نستخدم بياناتك للأغراض التالية:\n\n'}
                {'• معالجة الطلبات وتنفيذها.\n'}
                {'• التحقق من هوية المستخدم عبر رسائل OTP.\n'}
                {'• إرسال إشعارات تتعلق بحالة الطلب.\n'}
                {'• إرسال عروض ترويجية (بموافقتك المسبقة فقط).\n'}
                {'• تشغيل برنامج الولاء وإدارة النقاط/الطوابع/الاسترداد النقدي.\n'}
                {'• تحسين تجربة المستخدم وتطوير خدمات المنصة.\n'}
                {'• الامتثال للمتطلبات القانونية والتنظيمية في المملكة العربية السعودية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٣. مشاركة البيانات مع أطراف ثالثة'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نحن لا نبيع بياناتك الشخصية لأي جهة. نشارك بعض البيانات الضرورية مع شركائنا لتنفيذ الخدمة:\n\n'}
                {'• مُيسَّر (Moyasar): رموز المعاملات لمعالجة المدفوعات — مرخّصة من البنك المركزي السعودي.\n'}
                {'• مزوّدو التوصيل (مثل OTO): عنوان التوصيل ورقم الهاتف لإتمام التوصيل.\n'}
                {'• مزوّد الرسائل النصية: رقم الهاتف لإرسال رموز التحقق.\n'}
                {'• نظام نقاط البيع (Foodics): تفاصيل الطلب لتنفيذه في المتجر.\n'}
                {'• التاجر: تفاصيل الطلب فقط لتنفيذه.\n'}
                {'• الجهات الحكومية: عند الطلب وفقًا للأنظمة السعودية المعمول بها.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٤. أمن البيانات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• نستخدم تشفير TLS/SSL لجميع الاتصالات بين التطبيق وخوادمنا.\n'}
                {'• لا نخزّن بيانات البطاقات الائتمانية أو بطاقات مدى — تتم معالجتها بالكامل بواسطة مُيسَّر وفق معايير PCI-DSS.\n'}
                {'• نطبّق ضوابط وصول صارمة على قواعد البيانات.\n'}
                {'• يتم تخزين البيانات في مراكز بيانات آمنة تابعة لمزوّدي خدمات سحابية معتمدين.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٥. حقوقك'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'وفقًا لنظام حماية البيانات الشخصية السعودي، يحق لك:\n\n'}
                {'• الوصول: طلب نسخة من بياناتك الشخصية المحفوظة لدينا.\n'}
                {'• التصحيح: طلب تعديل أي بيانات غير دقيقة.\n'}
                {'• الحذف: طلب حذف بياناتك، مع مراعاة التزاماتنا القانونية.\n'}
                {'• سحب الموافقة: يحق لك سحب موافقتك على معالجة البيانات في أي وقت، مع العلم أن ذلك قد يؤثر على قدرتك على استخدام بعض خدمات التطبيق.\n\n'}
                {'لممارسة أي من هذه الحقوق، تواصل معنا عبر: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٦. الاحتفاظ بالبيانات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نحتفظ ببياناتك طالما كان حسابك نشطًا أو حسب ما تقتضيه الأنظمة السعودية (مثل الاحتفاظ بسجلات المعاملات المالية لمدة لا تقل عن ٥ سنوات وفقًا لمتطلبات البنك المركزي السعودي). عند حذف حسابك، سيتم حذف بياناتك الشخصية خلال ٣٠ يومًا، باستثناء ما يتطلبه القانون.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٧. تعديل السياسة'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحق لنا تحديث هذه السياسة في أي وقت. سنخطرك بأي تغييرات جوهرية عبر التطبيق. استمرارك في استخدام التطبيق بعد التحديث يُعدّ موافقةً على السياسة المعدّلة.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٨. الاتصال بنا'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'لأي استفسارات أو شكاوى تتعلق بالخصوصية:\n'}
                {'البريد الإلكتروني: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>
            </>
          ) : (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'Last updated: April 2026'}</Text>
                {'\n\n'}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' is committed to protecting the privacy of its users. This policy explains what data we collect, how we use it, and your rights, in accordance with the Saudi Personal Data Protection Law (Royal Decree No. M/19, dated 9/2/1443H) ("PDPL"). This application is powered by the Nooks technology platform.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'1. Data We Collect'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We collect the following categories of data when you use the application:\n\n'}
                {'• Account Data: Mobile phone number, name (optional), email (optional).\n'}
                {'• Location Data (GPS): Used to determine your delivery address and display nearby branches.\n'}
                {'• Device Identifier: For security and fraud prevention purposes.\n'}
                {'• Order Data: Details of past orders, favorites, and transaction history.\n'}
                {'• Payment Data: Transaction tokens only — we never store card details.\n'}
                {'• Usage Data: How you interact with the app, used to improve the service and performance.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'2. How We Use Your Data'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We use your data for the following purposes:\n\n'}
                {'• Processing and fulfilling your orders.\n'}
                {'• Verifying your identity via OTP messages.\n'}
                {'• Sending order status notifications and updates.\n'}
                {'• Sending promotional offers (with your prior consent only).\n'}
                {'• Operating the loyalty program and managing points/stamps/cashback.\n'}
                {'• Improving user experience and developing platform features.\n'}
                {'• Complying with applicable Saudi Arabian laws and regulatory requirements.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'3. Data Sharing with Third Parties'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We do not sell your personal data to any third party. We share certain data with essential partners to fulfill the service:\n\n'}
                {'• Moyasar: Transaction tokens for payment processing — licensed by the Saudi Central Bank (SAMA).\n'}
                {'• Delivery Providers (e.g. OTO): Delivery address and phone number to complete the delivery.\n'}
                {'• SMS Provider: Phone number for sending OTP verification codes.\n'}
                {'• POS System (Foodics): Order details for in-store fulfillment.\n'}
                {'• The Merchant: Order details strictly necessary for fulfillment.\n'}
                {'• Government Authorities: When required under applicable Saudi laws.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'4. Data Security'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• We use TLS/SSL encryption for all communications between the app and our servers.\n'}
                {'• We do not store credit card or Mada card data — all payment data is processed by Moyasar in compliance with PCI-DSS standards.\n'}
                {'• We enforce strict access controls on our databases.\n'}
                {'• Data is stored in secure data centers operated by approved cloud service providers.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'5. Your Rights'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'Under the Saudi Personal Data Protection Law, you have the right to:\n\n'}
                {'• Access: Request a copy of the personal data we hold about you.\n'}
                {'• Correction: Request the correction of any inaccurate data.\n'}
                {'• Deletion: Request deletion of your data, subject to our legal obligations.\n'}
                {'• Withdraw Consent: You may withdraw your consent to data processing at any time, noting this may affect your ability to use certain app features.\n\n'}
                {'To exercise any of these rights, contact us at: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'6. Data Retention'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We retain your data for as long as your account is active or as required by Saudi regulations (e.g., financial transaction records must be retained for a minimum of 5 years per SAMA requirements). Upon account deletion, your personal data will be removed within 30 days, except where retention is required by law.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'7. Policy Updates'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We reserve the right to update this Privacy Policy at any time. We will notify you of any material changes via in-app notifications. Your continued use of the application after an update constitutes acceptance of the revised policy.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'8. Contact Us'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'For any privacy-related inquiries or complaints:\n'}
                {'Email: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
