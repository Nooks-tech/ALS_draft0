import { useRouter } from 'expo-router';
import { FileText, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function TermsModal() {
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
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'الشروط والأحكام' : 'Terms & Conditions'}</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginEnd: -8 }}
          >
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          <View className="items-center mb-6">
            <View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <FileText size={32} color={primaryColor} />
            </View>
          </View>

          {isArabic ? (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'آخر تحديث: أبريل ٢٠٢٦'}</Text>
                {'\n\n'}
                {'مرحبًا بك في تطبيق '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {'. يعمل هذا التطبيق على منصة نُوكس التقنية (مؤسسة نُوكس لتقنية المعلومات). باستخدامك للتطبيق فإنك توافق على هذه الشروط والأحكام بالكامل. في حال عدم موافقتك، يُرجى عدم استخدام التطبيق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١. طبيعة الخدمة'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'هذا التطبيق هو تطبيق طلب إلكتروني يُمكّنك من تصفّح قائمة المنتجات وتقديم الطلبات والدفع إلكترونيًا. التاجر ('}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {') هو المسؤول عن جودة المنتجات وسلامتها الغذائية والالتزام بالأنظمة الصحية. منصة نُوكس توفّر البنية التقنية فقط.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٢. حسابات المستخدمين'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• يجب ألا يقل عمر المستخدم عن ١٨ عامًا، أو أن يستخدم التطبيق تحت إشراف ولي أمر.\n'}
                {'• يتحمّل المستخدم مسؤولية الحفاظ على سرية بيانات حسابه (رقم الجوال، رمز التحقق OTP).\n'}
                {'• يحق لنا تعليق أو إلغاء أي حساب يُساء استخدامه أو يُخالف هذه الشروط.\n'}
                {'• يلتزم المستخدم بتقديم معلومات صحيحة ودقيقة عند التسجيل.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٣. الطلبات والأسعار'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تُعرض الأسعار بالريال السعودي (SAR) وتشمل ضريبة القيمة المضافة (١٥٪) ما لم يُذكر خلاف ذلك.\n'}
                {'• يحق للتاجر تعديل الأسعار وتوفّر المنتجات في أي وقت.\n'}
                {'• يُعتبر الطلب مؤكّدًا بمجرد إتمام عملية الدفع بنجاح واستلام التاجر للطلب.\n'}
                {'• قد تُطبّق رسوم توصيل إضافية يتم عرضها بوضوح قبل تأكيد الطلب.\n'}
                {'• قد تُطبّق رسوم خدمة يتم عرضها في ملخص الطلب قبل الدفع.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٤. المدفوعات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'تتم معالجة جميع المدفوعات بشكل آمن عبر بوابة مُيسَّر (Moyasar) المرخّصة من البنك المركزي السعودي (ساما). وسائل الدفع المقبولة:\n\n'}
                {'• بطاقة مدى\n'}
                {'• Visa / MasterCard\n'}
                {'• Apple Pay\n\n'}
                {'لا يتم تخزين بيانات البطاقات على خوادمنا. جميع بيانات الدفع تُعالج مباشرة بواسطة مُيسَّر وفق معايير PCI-DSS.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٥. التوصيل وإخلاء المسؤولية'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'قد يتم التوصيل عبر مزوّدي خدمات لوجستية من أطراف ثالثة (مثل OTO وشركاته المتكاملة). أوقات التوصيل المعروضة تقديرية وقد تختلف بحسب الظروف.\n\n'}
                {'لا نتحمّل المسؤولية عن:\n'}
                {'• التأخير الناتج عن حركة المرور أو الظروف الجوية أو عوامل خارجة عن سيطرتنا.\n'}
                {'• أي أضرار ناتجة عن سوء التعامل مع الطلب أثناء النقل من قِبَل مزوّد التوصيل.\n\n'}
                {'يحق للمستخدم التواصل مع فريق الدعم في حال وجود أي مشكلة متعلقة بالتوصيل.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٦. العروض الترويجية وبرنامج الولاء'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تخضع العروض الترويجية وأكواد الخصم لشروط محددة.\n'}
                {'• عرض واحد لكل طلب ما لم يُذكر خلاف ذلك.\n'}
                {'• يحتفظ التاجر بحقه في تعديل العروض أو إيقافها في أي وقت.\n'}
                {'• نقاط/طوابع الولاء غير قابلة للتحويل أو الاستبدال نقدًا.\n'}
                {'• يحق للتاجر تعديل برنامج الولاء مع إخطار مسبق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٧. الملكية الفكرية'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'جميع حقوق الملكية الفكرية المتعلقة بالمنصة التقنية — بما في ذلك التصميم والكود البرمجي — مملوكة لمؤسسة نُوكس لتقنية المعلومات. العلامة التجارية والشعارات الخاصة بالتاجر مملوكة للتاجر. يُحظر نسخ أو إعادة إنتاج أي جزء من التطبيق دون إذن كتابي مسبق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٨. تحديد المسؤولية'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• التطبيق يُقدَّم "كما هو" دون ضمانات صريحة أو ضمنية فيما يتعلق بالتوفّر الدائم أو خلوّه من الأخطاء التقنية.\n'}
                {'• لا نتحمّل المسؤولية عن أي خسائر غير مباشرة ناتجة عن استخدام التطبيق.\n'}
                {'• مسؤوليتنا القصوى لا تتجاوز قيمة الطلب المتأثر.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٩. تعديل الشروط'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحق لنا تعديل هذه الشروط في أي وقت. سيتم إخطار المستخدمين بالتغييرات الجوهرية عبر التطبيق. استمرار استخدام التطبيق بعد التعديل يُعدّ موافقةً على الشروط المحدّثة.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٠. القانون الواجب التطبيق'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'تخضع هذه الشروط لأنظمة المملكة العربية السعودية. أي نزاع ينشأ عن استخدام التطبيق يخضع لاختصاص المحاكم المختصة في المملكة العربية السعودية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١١. الاتصال بنا'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'للاستفسارات أو الشكاوى المتعلقة بهذه الشروط:\n'}
                {'البريد الإلكتروني: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>
            </>
          ) : (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'Last updated: April 2026'}</Text>
                {'\n\n'}
                {'Welcome to the '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' app. This application is powered by the Nooks technology platform (Nooks Technology Est.). By using this app, you agree to these Terms & Conditions in their entirety. If you do not agree, please refrain from using the application.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'1. Nature of the Service'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'This application is an electronic ordering platform that allows you to browse the product menu, place orders, and pay electronically. The merchant ('}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {') is responsible for product quality, food safety, and compliance with health regulations. The Nooks platform provides the technical infrastructure only.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'2. User Accounts'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Users must be at least 18 years of age, or use the app under the supervision of a legal guardian.\n'}
                {'• Users are responsible for maintaining the confidentiality of their account credentials (phone number and OTP codes).\n'}
                {'• We reserve the right to suspend or terminate any account that is misused or found in violation of these terms.\n'}
                {'• Users must provide accurate and truthful information during registration.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'3. Orders & Pricing'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• All prices are displayed in Saudi Riyals (SAR) and are inclusive of Value-Added Tax (15%) unless otherwise stated.\n'}
                {'• The merchant may update product prices and availability at any time.\n'}
                {'• An order is deemed confirmed once payment has been successfully processed and the merchant has received the order.\n'}
                {'• Additional delivery fees may apply and will be clearly displayed before order confirmation.\n'}
                {'• A service fee may apply and will be shown in the order summary before payment.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'4. Payments'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'All payments are processed securely through Moyasar, a payment gateway licensed by the Saudi Central Bank (SAMA). Accepted payment methods:\n\n'}
                {'• Mada debit cards\n'}
                {'• Visa / MasterCard\n'}
                {'• Apple Pay\n\n'}
                {'We do not store card information on our servers. All payment data is processed directly by Moyasar in compliance with PCI-DSS standards.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'5. Delivery & Limitation of Liability'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'Delivery may be provided by third-party logistics providers (e.g. OTO and its connected carriers). Displayed delivery times are estimates and may vary.\n\n'}
                {'We shall not be held liable for:\n'}
                {'• Delays caused by traffic, weather, or circumstances beyond our reasonable control.\n'}
                {'• Damage to the order caused by the delivery provider during transit.\n\n'}
                {'Users are encouraged to contact support if they experience any delivery-related issues.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'6. Promotions & Loyalty Program'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Promotional offers and discount codes are subject to specific terms.\n'}
                {'• One offer per order unless stated otherwise.\n'}
                {'• The merchant reserves the right to modify or end promotions at any time.\n'}
                {'• Loyalty points/stamps are non-transferable and cannot be redeemed for cash.\n'}
                {'• The merchant may modify the loyalty program with prior notice.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'7. Intellectual Property'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'All intellectual property rights pertaining to the technology platform — including design and source code — are the exclusive property of Nooks Technology Est. The merchant\'s brand, trademarks, and logos are the property of the merchant. Unauthorized reproduction or distribution of any part of the application is strictly prohibited.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'8. Limitation of Liability'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• The application is provided "as is" without express or implied warranties regarding continuous availability or the absence of technical errors.\n'}
                {'• We shall not be liable for any indirect losses arising from the use of the application.\n'}
                {'• Our maximum liability shall not exceed the value of the affected order.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'9. Amendments'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We reserve the right to modify these Terms & Conditions at any time. Users will be notified of material changes via in-app notifications. Continued use of the application after any amendment constitutes acceptance of the updated terms.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'10. Governing Law'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'These terms are governed by the laws of the Kingdom of Saudi Arabia. Any disputes arising from the use of this application shall fall under the exclusive jurisdiction of the competent courts in the Kingdom of Saudi Arabia.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'11. Contact Us'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'For any inquiries or complaints regarding these terms:\n'}
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
