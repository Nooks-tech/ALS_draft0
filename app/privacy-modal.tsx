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
                <Text className="font-bold text-slate-800">{'سارية من ١٠ مايو ٢٠٢٦ · النسخة ٢٫٠'}</Text>
                {'\n\n'}
                {'يوضّح هذا الإشعار كيفية معالجة بياناتك الشخصية عند استخدامك تطبيق '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {'، وذلك وفقاً لـ'}
                <Text className="font-bold text-slate-800">{'نظام حماية البيانات الشخصية'}</Text>
                {' الصادر بالمرسوم الملكي رقم م/١٩ بتاريخ ١٤٤٣/٢/٩هـ ولوائحه التنفيذية. تعمل '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' بصفتها '}
                <Text className="font-bold text-slate-800">{'المتحكم في البيانات (Data Controller)'}</Text>
                {'، بينما تعمل '}
                <Text className="font-bold text-slate-800">{'مؤسسة نُوكس لتقنية المعلومات'}</Text>
                {' بصفتها '}
                <Text className="font-bold text-slate-800">{'المعالج (Data Processor)'}</Text>
                {' الذي يشغّل البنية التقنية للتطبيق نيابةً عن التاجر بموجب اتفاقية معالجة بيانات قياسية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١. البيانات التي نجمعها'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نجمع الفئات التالية عند استخدامك للتطبيق:\n\n'}
                {'• رقم الجوال (إلزامي للتسجيل والتحقق عبر OTP).\n'}
                {'• الاسم (لتخصيص التجربة).\n'}
                {'• البريد الإلكتروني (اختياري).\n'}
                {'• إحداثيات الموقع الجغرافي (GPS) لتحديد عنوان التوصيل وعرض الفروع القريبة.\n'}
                {'• معرّف الجهاز (Device ID) لأغراض الأمان ومنع الاحتيال.\n'}
                {'• سجل الطلبات والمفضّلات وعناوين التوصيل.\n'}
                {'• رموز الإشعارات الفورية (Push Tokens) من Apple وGoogle.\n'}
                {'• رموز الدفع (Payment Tokens) الصادرة من Moyasar وآخر ٤ أرقام من البطاقة فقط — '}
                <Text className="font-bold text-slate-800">{'لا نخزّن رقم البطاقة الكامل أبداً'}</Text>
                {'.\n'}
                {'• سجلات OTP وزمنها (٣٠ يوماً) لمنع الاحتيال.\n'}
                {'• الصور المرفقة مع الشكاوى لإثبات الحالة.\n'}
                {'• بيانات الاستخدام المجهّلة لتحسين الأداء.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٢. كيف نستخدم بياناتك'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نستخدم بياناتك للأغراض المشروعة التالية فقط:\n\n'}
                {'• تنفيذ طلباتك ومعالجة الدفع.\n'}
                {'• التحقق من هويتك عبر رموز OTP المُرسلة من Corbit.\n'}
                {'• إرسال إشعارات حالة الطلب (تأكيد، تحضير، خرج للتوصيل، تم التسليم).\n'}
                {'• تشغيل برنامج الولاء (الطوابع، النقاط، الاسترداد النقدي).\n'}
                {'• إرسال عروض ترويجية '}
                <Text className="font-bold text-slate-800">{'بموافقتك المسبقة فقط (Opt-in)'}</Text>
                {' — يمكنك سحب موافقتك في أي وقت.\n'}
                {'• الامتثال للأنظمة السعودية ذات الصلة (PDPL، نظام التجارة الإلكترونية، متطلبات هيئة الزكاة والضريبة).\n'}
                {'• حماية المنصة ومنع الاحتيال وإساءة الاستخدام.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٣. الأساس القانوني للمعالجة'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• '}
                <Text className="font-bold text-slate-800">{'تنفيذ العقد:'}</Text>
                {' معظم المعالجة لازمة لتقديم خدمة الطلب لك.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'الموافقة:'}</Text>
                {' الإشعارات التسويقية، تتبّع الموقع الدقيق، حملات البريد الإلكتروني.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'المصلحة المشروعة:'}</Text>
                {' منع الاحتيال، أمن النظام، تحسين الخدمة.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'الالتزام القانوني:'}</Text>
                {' الاحتفاظ بسجلات المعاملات وفقاً لمتطلبات هيئة الزكاة والضريبة والبنك المركزي السعودي.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٤. مشاركة البيانات (المعالجون الفرعيون)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'لا نبيع بياناتك الشخصية لأي جهة. '}</Text>
                {'نشاركها فقط مع الشركاء التقنيين الضروريين لتشغيل الخدمة:\n\n'}
                {'• Moyasar — معالجة المدفوعات (مرخّصة من البنك المركزي السعودي).\n'}
                {'• OTO و Foodics DMS — توصيل الطلبات.\n'}
                {'• Foodics — تكامل نقاط البيع لتنفيذ الطلب في المتجر.\n'}
                {'• المدار التقني (Corbit) — إرسال رسائل التحقق (OTP).\n'}
                {'• Resend — إرسال البريد الإلكتروني المعاملاتي.\n'}
                {'• Supabase — استضافة قاعدة البيانات (مراكز بيانات في أوروبا/آسيا).\n'}
                {'• Apple Push (APNs) و Firebase (FCM) — تسليم الإشعارات الفورية.\n'}
                {'• Sentry — تتبّع أخطاء التطبيق (بدون بيانات شخصية، مجهّلة).\n'}
                {'• Mapbox — تحويل العناوين إلى إحداثيات.\n'}
                {'• التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' — تفاصيل الطلب لتنفيذه.\n'}
                {'• الجهات الحكومية — عند الطلب القانوني وفقاً للأنظمة السعودية.\n\n'}
                {'قد يتم نقل بعض البيانات إلى خوادم خارج المملكة (الاتحاد الأوروبي، آسيا) ضمن الحدود المسموح بها بموجب نظام حماية البيانات الشخصية. نُلزم جميع المعالجين الفرعيين بضمانات تعاقدية مكافئة لمستوى الحماية المحلي.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٥. أمن البيانات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تشفير '}
                <Text className="font-bold text-slate-800">{'TLS 1.2+'}</Text>
                {' لجميع الاتصالات بين التطبيق وخوادمنا.\n'}
                {'• تُحفظ رموز الجلسة في '}
                <Text className="font-bold text-slate-800">{'iOS Keychain / Android Keystore'}</Text>
                {' — لا تُخزّن في الذاكرة العادية.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'لا نخزّن رقم البطاقة الكامل أبداً'}</Text>
                {' — جميع المدفوعات تُرمَّز بالكامل عبر Moyasar وفق معيار PCI-DSS.\n'}
                {'• ضوابط وصول صارمة على قاعدة البيانات (Row-Level Security) وتدقيق دوري للسجلات.\n'}
                {'• نسخ احتياطية تلقائية يومية مع إمكانية الاستعادة لـ ٧ أيام.\n'}
                {'• عند اكتشاف أي خرق للبيانات يؤثر عليك، نلتزم بإخطارك خلال '}
                <Text className="font-bold text-slate-800">{'٧٢ ساعة'}</Text>
                {' وفق متطلبات النظام.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٦. الاحتفاظ بالبيانات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• بيانات الحساب النشط: طوال فترة استخدامك للتطبيق.\n'}
                {'• السجلات المالية والطلبات: ٧ سنوات (متطلبات هيئة الزكاة والضريبة والبنك المركزي السعودي).\n'}
                {'• سجلات OTP: ٣٠ يوماً.\n'}
                {'• رموز الإشعارات الفورية: حتى إلغاء تثبيت التطبيق أو إيقاف الإشعارات.\n'}
                {'• عند حذف حسابك: تُحذف بياناتك الشخصية خلال ٣٠ يوماً، وتُجهَّل سجلات الطلبات (تبقى للأغراض المحاسبية بدون بيانات تعريفية).'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٧. حقوقك بموجب نظام حماية البيانات الشخصية'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحق لك بموجب PDPL ممارسة الحقوق التالية:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'حق الوصول:'}</Text>
                {' طلب نسخة من بياناتك المحفوظة.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'حق التصحيح:'}</Text>
                {' تعديل أي بيانات غير دقيقة.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'حق الحذف:'}</Text>
                {' طلب حذف بياناتك، باستثناء ما يلزم الاحتفاظ به قانونياً.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'حق الاعتراض:'}</Text>
                {' رفض المعالجة لأغراض التسويق المباشر.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'حق سحب الموافقة:'}</Text>
                {' في أي وقت.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'حق نقل البيانات:'}</Text>
                {' الحصول على نسخة بصيغة قابلة للقراءة الآلية.\n\n'}
                {'لممارسة أي من هذه الحقوق، تواصل مع: '}
                <Text className="font-bold text-slate-800">{email}</Text>
                {' — نلتزم بالرد خلال ٣٠ يوماً.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٨. القاصرون'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'الخدمة غير موجّهة للأشخاص دون سن ١٨ عاماً. إذا اكتشفنا جمع بيانات لقاصر دون موافقة وليّ الأمر، نحذفها فوراً. على وليّ الأمر الإشراف على استخدام أبنائه للتطبيق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٩. التحليلات والتتبّع'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'نستخدم تحليلات مجهّلة الهوية فقط (Sentry للأخطاء التقنية). لا نستخدم أي تتبّع للإعلانات المستهدفة، ولا نُشارك بياناتك مع شبكات إعلانية تابعة لأطراف ثالثة.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٠. محفظة التطبيق (رصيد متجر فقط)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'رصيد المحفظة داخل التطبيق هو '}
                <Text className="font-bold text-slate-800">{'رصيد متجر (Store Credit)'}</Text>
                {' لدى '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' فقط. ليس أداة دفع، ولا يخضع لتنظيم البنك المركزي السعودي (ساما)، ولا يُصرف نقداً، ولا يُحوَّل لحساب بنكي. يُجمَّد بعد ٢٤ شهراً من آخر نشاط.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١١. تحديثات السياسة'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحق لنا تحديث هذه السياسة في أي وقت. سنُخطرك بالتغييرات الجوهرية عبر البريد الإلكتروني وبانر داخل التطبيق قبل سريانها بفترة معقولة. استمرارك في استخدام التطبيق بعد التحديث يُعدّ موافقة على السياسة المعدّلة.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٢. التواصل والشكاوى'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'لأي استفسار أو شكوى متعلقة بالخصوصية:\n'}
                {'• البريد الإلكتروني للتاجر: '}
                <Text className="font-bold text-slate-800">{email}</Text>
                {'\n'}
                {'• كما يحق لك تقديم شكوى رسمية إلى '}
                <Text className="font-bold text-slate-800">{'الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا)'}</Text>
                {' عبر sdaia.gov.sa'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٣. القانون الواجب التطبيق'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'تخضع هذه السياسة لأنظمة المملكة العربية السعودية. عند التعارض بين النسخة العربية والإنجليزية، '}
                <Text className="font-bold text-slate-800">{'تسود النسخة العربية'}</Text>
                {'.'}
              </Text>
            </>
          ) : (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'Effective: 10 May 2026 · Version 2.0'}</Text>
                {'\n\n'}
                {'This notice explains how your personal data is processed when you use the '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' app, in accordance with the '}
                <Text className="font-bold text-slate-800">{'Saudi Personal Data Protection Law (PDPL)'}</Text>
                {' issued by Royal Decree No. M/19 dated 9/2/1443H, and its Implementing Regulations. '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' acts as the '}
                <Text className="font-bold text-slate-800">{'Data Controller'}</Text>
                {', while '}
                <Text className="font-bold text-slate-800">{'Nooks Information Technology Est.'}</Text>
                {' acts as the '}
                <Text className="font-bold text-slate-800">{'Data Processor'}</Text>
                {' running the technical infrastructure on the merchant\'s behalf under a standard data processing addendum.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'1. Data We Collect'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We collect the following categories when you use the app:\n\n'}
                {'• Mobile phone number (required for sign-up and OTP verification).\n'}
                {'• Name (to personalize your experience).\n'}
                {'• Email address (optional).\n'}
                {'• GPS coordinates to determine your delivery address and show nearby branches.\n'}
                {'• Device identifier for security and fraud prevention.\n'}
                {'• Order history, favorites, and saved delivery addresses.\n'}
                {'• Push notification tokens from Apple and Google.\n'}
                {'• Payment tokens issued by Moyasar and last 4 digits of card only — '}
                <Text className="font-bold text-slate-800">{'we never store the full card number (PAN)'}</Text>
                {'.\n'}
                {'• OTP request logs and timestamps (30 days) for fraud prevention.\n'}
                {'• Photos attached to complaints to substantiate the case.\n'}
                {'• Anonymized usage data to improve performance.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'2. How We Use Your Data'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We use your data only for the following legitimate purposes:\n\n'}
                {'• Fulfilling your orders and processing payments.\n'}
                {'• Verifying your identity via OTP codes delivered through Corbit.\n'}
                {'• Sending order status notifications (confirmed, preparing, out for delivery, delivered).\n'}
                {'• Operating the loyalty program (stamps, points, cashback).\n'}
                {'• Sending promotional offers '}
                <Text className="font-bold text-slate-800">{'with your prior opt-in consent only'}</Text>
                {' — withdraw at any time.\n'}
                {'• Complying with applicable Saudi laws (PDPL, E-Commerce Law, ZATCA requirements).\n'}
                {'• Protecting the platform and preventing fraud or abuse.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'3. Legal Basis for Processing'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• '}
                <Text className="font-bold text-slate-800">{'Contract performance:'}</Text>
                {' most processing is necessary to deliver the ordering service to you.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Consent:'}</Text>
                {' marketing notifications, precise location tracking, email campaigns.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Legitimate interest:'}</Text>
                {' fraud prevention, system security, service improvement.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Legal obligation:'}</Text>
                {' retaining transaction records as required by ZATCA and SAMA.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'4. Data Sharing (Sub-Processors)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'We do not sell your personal data. '}</Text>
                {'We share it only with technical partners necessary to operate the service:\n\n'}
                {'• Moyasar — payment processing (licensed by SAMA).\n'}
                {'• OTO and Foodics DMS — order delivery.\n'}
                {'• Foodics — POS integration for in-store fulfillment.\n'}
                {'• Corbit (المدار التقني) — SMS and OTP delivery.\n'}
                {'• Resend — transactional email.\n'}
                {'• Supabase — database hosting (data centers in Europe/Asia).\n'}
                {'• Apple Push (APNs) and Firebase (FCM) — push notification delivery.\n'}
                {'• Sentry — anonymized error tracking (no personal data).\n'}
                {'• Mapbox — geocoding addresses.\n'}
                {'• The merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' — order details for fulfillment.\n'}
                {'• Government authorities — upon valid legal request under Saudi law.\n\n'}
                {'Some data may be transferred to servers outside Saudi Arabia (EU, Asia) within PDPL-permitted bounds. We bind all sub-processors to contractual guarantees equivalent to local protection standards.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'5. Data Security'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• '}
                <Text className="font-bold text-slate-800">{'TLS 1.2+'}</Text>
                {' encryption for all communications between the app and our servers.\n'}
                {'• Session tokens are stored in '}
                <Text className="font-bold text-slate-800">{'iOS Keychain / Android Keystore'}</Text>
                {' — never in plain memory.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'We never store the full card PAN'}</Text>
                {' — all payments are tokenized end-to-end via Moyasar per PCI-DSS.\n'}
                {'• Strict database access controls (Row-Level Security) and regular log audits.\n'}
                {'• Daily automated backups with 7-day recovery window.\n'}
                {'• If a breach affecting your data is detected, we commit to notifying you within '}
                <Text className="font-bold text-slate-800">{'72 hours'}</Text>
                {' per PDPL requirements.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'6. Data Retention'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Active account data: for the duration of your use of the app.\n'}
                {'• Financial and order records: 7 years (ZATCA and SAMA requirements).\n'}
                {'• OTP logs: 30 days.\n'}
                {'• Push notification tokens: until app uninstall or notifications disabled.\n'}
                {'• On account deletion: personal data deleted within 30 days; order records anonymized (preserved for accounting purposes without identifying data).'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'7. Your Rights Under PDPL'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'You have the following rights under PDPL:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Right of access:'}</Text>
                {' request a copy of your data.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Right to rectification:'}</Text>
                {' correct any inaccurate data.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Right to erasure:'}</Text>
                {' request deletion, except where retention is legally required.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Right to object:'}</Text>
                {' opt out of direct marketing processing.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Right to withdraw consent:'}</Text>
                {' at any time.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Right to data portability:'}</Text>
                {' receive a machine-readable copy.\n\n'}
                {'To exercise any of these rights, contact: '}
                <Text className="font-bold text-slate-800">{email}</Text>
                {' — we will respond within 30 days.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'8. Minors'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'The service is not directed at individuals under 18. If we discover we have collected data on a minor without guardian consent, we will delete it immediately. Guardians are responsible for supervising their children\'s use of the app.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'9. Analytics & Tracking'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We use anonymized analytics only (Sentry for technical errors). We do not engage in any tracking for targeted advertising, and we do not share your data with third-party advertising networks.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'10. In-App Wallet (Store Credit Only)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'The wallet balance inside the app is '}
                <Text className="font-bold text-slate-800">{'store credit only'}</Text>
                {' at '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {'. It is not a payment instrument, not subject to SAMA regulation, not redeemable for cash, and not transferable to a bank account. Frozen after 24 months of inactivity.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'11. Policy Updates'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We reserve the right to update this notice at any time. We will notify you of material changes via email and an in-app banner before they take effect. Continued use after an update constitutes acceptance of the revised notice.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'12. Contact & Complaints'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'For any privacy inquiry or complaint:\n'}
                {'• Merchant email: '}
                <Text className="font-bold text-slate-800">{email}</Text>
                {'\n'}
                {'• You may also file a formal complaint with the '}
                <Text className="font-bold text-slate-800">{'Saudi Data & AI Authority (SDAIA)'}</Text>
                {' at sdaia.gov.sa'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'13. Governing Law'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'This Policy is governed by the laws of the Kingdom of Saudi Arabia. In case of any conflict between the Arabic and English versions, '}
                <Text className="font-bold text-slate-800">{'the Arabic version prevails'}</Text>
                {'.'}
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
