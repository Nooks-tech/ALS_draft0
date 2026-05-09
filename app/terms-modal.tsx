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
        <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 24 }} showsVerticalScrollIndicator={false}>
          <View className="items-center mb-6">
            <View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <FileText size={32} color={primaryColor} />
            </View>
          </View>

          {isArabic ? (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'سارية من ١٠ مايو ٢٠٢٦ · النسخة ٢٫٠'}</Text>
                {'\n\n'}
                {'مرحباً بك في تطبيق '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {'. باستخدامك للتطبيق فإنك توافق على هذه الشروط بالكامل. اقرأها بعناية — فهي تحدد بوضوح أن العقد التجاري قائم بينك وبين التاجر، وأن '}
                <Text className="font-bold text-slate-800">{'مؤسسة نُوكس لتقنية المعلومات'}</Text>
                {' هي مزوّد البرمجيات فقط، كما تتضمن سقفاً لمسؤولية نُوكس وقائمة موسّعة بما لا تتحمّله من مسؤولية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١. طبيعة الخدمة (مهم)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• التعاقد التجاري على شراء الطعام/المشروبات قائم بينك وبين التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' — هو البائع الفعلي، وهو المسؤول عن جودة المنتج وسلامته الغذائية والتزامه الديني والنظامي.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'نُوكس ليست مطعماً ولا مقهى ولا شركة توصيل ولا بنكاً'}</Text>
                {' — نُوكس هي '}
                <Text className="font-bold text-slate-800">{'منصة برمجية فقط'}</Text>
                {' تُشغّل التطبيق نيابةً عن التاجر.\n'}
                {'• نُوكس لا تحضّر طعاماً ولا توصّله ولا تلمسه ولا تحتفظ بمخزون.\n'}
                {'• نُوكس '}
                <Text className="font-bold text-slate-800">{'لا تحتفظ بأموالك'}</Text>
                {' — مدفوعاتك تذهب مباشرة من Moyasar إلى الحساب البنكي الخاص بالتاجر.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٢. الحساب والتسجيل'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• يجب ألا يقل عمرك عن '}
                <Text className="font-bold text-slate-800">{'١٨ عاماً'}</Text>
                {'، أو أن تستخدم التطبيق تحت إشراف ولي أمر.\n'}
                {'• يجب استخدام رقم جوال حقيقي تملكه شخصياً للتحقق عبر OTP.\n'}
                {'• حساب واحد لكل شخص — يُحظر إنشاء حسابات متعددة لنفس الشخص.\n'}
                {'• أنت مسؤول عن سرية بيانات الدخول الخاصة بحسابك. أي نشاط يصدر من حسابك مسؤوليتك.\n'}
                {'• يجب تقديم بيانات صحيحة ودقيقة عند التسجيل والمحافظة على تحديثها.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٣. الطلبات والأسعار'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• الأسعار يحدّدها التاجر وقد تتغيّر في أي وقت قبل تأكيد الطلب.\n'}
                {'• تُعرض الأسعار بالريال السعودي وتشمل ضريبة القيمة المضافة (١٥٪) ما لم يُذكر خلاف ذلك.\n'}
                {'• يحق للتاجر '}
                <Text className="font-bold text-slate-800">{'قبول أو رفض'}</Text>
                {' أي طلب لأي سبب (نفاد المخزون، إغلاق الفرع، خطأ في السعر، إلخ).\n'}
                {'• الطلب يُعدّ مؤكَّداً فقط بعد قبول التاجر له ومعالجة الدفع بنجاح.\n'}
                {'• قد تُطبَّق رسوم توصيل تُعرَض بوضوح قبل الدفع.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٤. المدفوعات (نموذج BYOG)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تتم معالجة المدفوعات عبر '}
                <Text className="font-bold text-slate-800">{'حساب Moyasar الخاص بالتاجر'}</Text>
                {' — Moyasar مرخّصة من البنك المركزي السعودي (ساما).\n'}
                {'• Moyasar تُرمِّز بطاقتك (Tokenization) في تطبيق العميل مباشرة وفق معيار PCI-DSS.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'نُوكس لا ترى رقم بطاقتك الكامل ولا تخزّنه أبداً'}</Text>
                {'.\n'}
                {'• وسائل الدفع المقبولة: مدى، Visa، MasterCard، Apple Pay.\n'}
                {'• أي '}
                <Text className="font-bold text-slate-800">{'نزاع رد مبالغ (Chargeback)'}</Text>
                {' بينك وبين البنك المُصدِر للبطاقة — '}
                <Text className="font-bold text-slate-800">{'نُوكس ليست طرفاً'}</Text>
                {' في هذا النزاع.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٥. محفظة التطبيق (رصيد متجر فقط)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• المحفظة هي '}
                <Text className="font-bold text-slate-800">{'رصيد متجر'}</Text>
                {' لدى التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' فقط — قابلة للاستخدام في طلبات لاحقة لدى نفس التاجر.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'ليست أداة دفع'}</Text>
                {' ولا تخضع لتنظيم البنك المركزي السعودي (ساما).\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'لا تُصرف نقداً'}</Text>
                {' ولا تُحوَّل إلى حساب بنكي ولا تُنقل لتاجر آخر.\n'}
                {'• تُجمَّد بعد ٢٤ شهراً من آخر نشاط ما لم يحدد التاجر سياسة مختلفة.\n'}
                {'• المبالغ المستردة من الطلبات تُصرف افتراضياً '}
                <Text className="font-bold text-slate-800">{'إلى المحفظة'}</Text>
                {'.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٦. برنامج الولاء'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• الطوابع/النقاط/الاسترداد النقدي تخضع لإعدادات التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {'.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'غير قابلة للبيع أو التحويل'}</Text>
                {' لشخص آخر، وغير قابلة للاستبدال نقداً.\n'}
                {'• تُفقد عند حذف الحساب.\n'}
                {'• يحق للتاجر تعديل برنامج الولاء بإخطار مسبق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٧. التوصيل'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• يتم التوصيل عبر '}
                <Text className="font-bold text-slate-800">{'Foodics DMS أو سائقي طرف ثالث (مثل OTO)'}</Text>
                {'.\n'}
                {'• تُقرّ بأن '}
                <Text className="font-bold text-slate-800">{'جودة التوصيل وتوقيته'}</Text>
                {' مسؤولية شركة التوصيل والتاجر — نُوكس ليست شركة توصيل.\n'}
                {'• أوقات التوصيل المعروضة تقديرية وقد تختلف بحسب الظروف.\n'}
                {'• نُوكس غير مسؤولة عن سلوك السائق أو فقدان الطلب أو تلف العبوة أثناء النقل.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٨. الاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'تخضع جميع طلبات الاسترداد لـ'}
                <Text className="font-bold text-slate-800">{'سياسة الاسترداد'}</Text>
                {' داخل التطبيق. '}
                <Text className="font-bold text-slate-800">{'جميع المبالغ المستردة المعتمَدة تُصرف إلى محفظتك في التطبيق'}</Text>
                {' — لا إلى البطاقة، ولا نقداً.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٩. الاستخدام المقبول'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يُحظر عليك:\n\n'}
                {'• الاحتيال أو محاولة الدفع ببطاقة لا تملكها.\n'}
                {'• محاولات OTP الوهمية أو إساءة استخدام نظام الرسائل النصية.\n'}
                {'• استخراج البيانات (Scraping) أو الهندسة العكسية للتطبيق.\n'}
                {'• تقديم شكاوى وهمية أو مبالغ فيها.\n'}
                {'• إصدار نزاعات بنكية (Chargebacks) دون سبب حقيقي.\n'}
                {'• استخدام التطبيق لأي غرض غير قانوني.\n\n'}
                <Text className="font-bold text-slate-800">{'العقوبة:'}</Text>
                {' تعليق فوري للحساب أو إنهاء دائم.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٠. ما لا تتحمّله نُوكس مسؤوليته (مهم جداً)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'تُقرّ صراحةً بأن '}
                <Text className="font-bold text-slate-800">{'نُوكس لا تتحمّل أي مسؤولية'}</Text>
                {' عن أي مما يلي:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'سلامة الطعام والتسمم الغذائي'}</Text>
                {' — مسؤولية التاجر وحده.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'الحساسية الغذائية'}</Text>
                {' وردود الفعل التحسسية.\n'}
                {'• المكونات، الصلاحية، شروط الحفظ، الالتزامات الحلال.\n'}
                {'• دقة الطلب، نقص العناصر، الخطأ في التحضير، تأخّر المطبخ.\n'}
                {'• تأخّر التوصيل، فقدان الطلب، تلف العبوة، سلوك السائق.\n'}
                {'• انقطاعات أطراف ثالثة: '}
                <Text className="font-bold text-slate-800">{'Moyasar، Foodics، OTO، Apple، Google'}</Text>
                {'، شركات الاتصالات، انقطاعات الإنترنت أو الكهرباء.\n'}
                {'• ادعاءات التسويق التي يصدرها التاجر ("الأطيب"، "الأفضل"، إلخ).\n'}
                {'• سلوك موظفي التاجر والنزاعات العمالية.\n'}
                {'• فقدان نقاط/طوابع الولاء بسبب تغييرات التاجر أو حذف الحساب.\n'}
                {'• مشاكل عرض البطاقة في Apple/Google Wallet على جهازك.\n'}
                {'• القوة القاهرة (جائحة، حرب، حظر تنظيمي، كوارث طبيعية).\n'}
                {'• الأضرار '}
                <Text className="font-bold text-slate-800">{'غير المباشرة، التبعية، العقابية، الردعية'}</Text>
                {'.\n'}
                {'• فقدان الفرص أو الأرباح أو السمعة.\n'}
                {'• تكاليف بديل مأكولات لم تستلمها أو تأخرت.\n'}
                {'• أي خلل في تطبيقات أو خدمات خارجية مرتبطة بالنظام.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١١. التزاماتك أنت'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تقديم رقم جوال صحيح وعنوان توصيل دقيق.\n'}
                {'• استلام الطلب في وقت التسليم والتواجد في العنوان.\n'}
                {'• عدم الاحتيال أو إساءة استخدام النظام.\n'}
                {'• عدم إساءة استخدام نظام OTP/الرسائل النصية.\n'}
                {'• احترام التاجر وموظفيه ومزوّد التوصيل.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٢. سقف المسؤولية'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'إلى الحد الأقصى الذي يسمح به النظام السعودي:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'مسؤولية نُوكس الإجمالية تجاهك عن أي طلب واحد لا تتجاوز قيمة ذلك الطلب'}</Text>
                {' — ولا تزيد بأي حال.\n'}
                {'• تستثنى من هذا السقف: الإصابة الجسدية الناتجة عن '}
                <Text className="font-bold text-slate-800">{'إهمال جسيم'}</Text>
                {' أو سوء سلوك متعمد.\n'}
                {'• تُستبعد كلياً المطالبات عن: فقدان فرص، أضرار غير مباشرة أو تبعية أو عقابية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٣. التعويض'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'تلتزم بتعويض التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' ومنصة نُوكس وحمايتهم من أي مطالبات أو خسائر ناتجة عن:\n\n'}
                {'• الطلبات الاحتيالية أو الدفع ببطاقة لا تملكها.\n'}
                {'• نزاعات بنكية (Chargebacks) دون سبب حقيقي.\n'}
                {'• إساءة استخدام الحساب أو خرق هذه الشروط.\n'}
                {'• ادعاءاتك الكاذبة أو شكاويك المختلقة.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٤. الإنهاء'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• يحق لك حذف حسابك في أي وقت من إعدادات التطبيق.\n'}
                {'• يحق لنا إنهاء حسابك أو تعليقه فوراً عند: الاحتيال، الإساءة المتكررة، خرق هذه الشروط، أو طلب رسمي من جهة حكومية.\n'}
                {'• عند الإنهاء: تُحذف بياناتك الشخصية وفق سياسة الخصوصية، ويُفقد رصيد المحفظة ونقاط الولاء.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٥. تعديل الشروط'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحق لنا تعديل هذه الشروط في أي وقت. سيتم إخطارك بالتغييرات الجوهرية مُسبقاً عبر البريد الإلكتروني وبانر داخل التطبيق. استمرارك في استخدام التطبيق بعد التعديل يُعدّ موافقةً على الشروط المحدّثة.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٦. القانون والاختصاص'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تخضع هذه الشروط لـ'}
                <Text className="font-bold text-slate-800">{'أنظمة المملكة العربية السعودية'}</Text>
                {'.\n'}
                {'• المحاكم المختصة في الرياض هي صاحبة الاختصاص الحصري.\n'}
                {'• عند التعارض بين النسخة العربية والإنجليزية، '}
                <Text className="font-bold text-slate-800">{'تسود النسخة العربية'}</Text>
                {'.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١٧. التواصل'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'لأي استفسار أو شكوى تتعلق بهذه الشروط:\n'}
                {'البريد الإلكتروني: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>
            </>
          ) : (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'Effective: 10 May 2026 · Version 2.0'}</Text>
                {'\n\n'}
                {'Welcome to the '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' app. By using the app you agree to these Terms in their entirety. Read them carefully — they make clear that the commercial contract is between you and the merchant, that '}
                <Text className="font-bold text-slate-800">{'Nooks Information Technology Est.'}</Text>
                {' is the software vendor only, and they include a liability cap and an extensive list of items Nooks is not responsible for.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'1. Nature of the Service (Important)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Your commercial contract for food/beverage purchases is between you and the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' — they are the actual seller, responsible for product quality, food safety, and religious and regulatory compliance.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Nooks is not a restaurant, not a cafe, not a delivery company, and not a bank'}</Text>
                {' — Nooks is a '}
                <Text className="font-bold text-slate-800">{'software platform only'}</Text>
                {' running the app on the merchant\'s behalf.\n'}
                {'• Nooks does not prepare food, deliver food, touch food, or hold inventory.\n'}
                {'• Nooks '}
                <Text className="font-bold text-slate-800">{'does not hold your money'}</Text>
                {' — your payments flow directly from Moyasar to the merchant\'s own bank account.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'2. Account & Registration'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• You must be at least '}
                <Text className="font-bold text-slate-800">{'18 years old'}</Text>
                {', or use the app under the supervision of a legal guardian.\n'}
                {'• You must use a real phone number that you personally own for OTP verification.\n'}
                {'• One account per person — multiple accounts for the same individual are prohibited.\n'}
                {'• You are responsible for keeping your login credentials confidential. Any activity from your account is your responsibility.\n'}
                {'• You must provide accurate information at registration and keep it updated.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'3. Orders & Pricing'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Prices are set by the merchant and may change at any time before order confirmation.\n'}
                {'• Prices are displayed in Saudi Riyals and include VAT (15%) unless otherwise stated.\n'}
                {'• The merchant has the right to '}
                <Text className="font-bold text-slate-800">{'accept or refuse'}</Text>
                {' any order for any reason (out of stock, branch closed, pricing error, etc.).\n'}
                {'• An order is deemed confirmed only after the merchant has accepted it and payment has been processed successfully.\n'}
                {'• Delivery fees may apply and will be displayed clearly before payment.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'4. Payments (BYOG Model)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Payments are processed via the '}
                <Text className="font-bold text-slate-800">{'merchant\'s own Moyasar account'}</Text>
                {' — Moyasar is licensed by the Saudi Central Bank (SAMA).\n'}
                {'• Moyasar tokenizes your card directly within the customer app per PCI-DSS.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Nooks never sees or stores the full card number (PAN)'}</Text>
                {'.\n'}
                {'• Accepted payment methods: mada, Visa, MasterCard, Apple Pay.\n'}
                {'• Any '}
                <Text className="font-bold text-slate-800">{'chargeback dispute'}</Text>
                {' is between you and your card-issuing bank — '}
                <Text className="font-bold text-slate-800">{'Nooks is not a party'}</Text>
                {' to such disputes.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'5. In-App Wallet (Store Credit Only)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• The wallet is '}
                <Text className="font-bold text-slate-800">{'store credit'}</Text>
                {' at the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' only — usable on future orders with the same merchant.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'It is not a payment instrument'}</Text>
                {' and is not subject to Saudi Central Bank (SAMA) regulation.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Not redeemable for cash'}</Text>
                {', not transferable to a bank account, and not transferable to another merchant.\n'}
                {'• Frozen after 24 months of inactivity unless the merchant configures a different policy.\n'}
                {'• Approved order refunds are issued '}
                <Text className="font-bold text-slate-800">{'to the wallet by default'}</Text>
                {'.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'6. Loyalty Program'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Stamps/points/cashback are configured by the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {'.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Cannot be sold or transferred'}</Text>
                {' to another person, and cannot be redeemed for cash.\n'}
                {'• Forfeited on account deletion.\n'}
                {'• The merchant may modify the loyalty program with prior notice.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'7. Delivery'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Delivery is handled by '}
                <Text className="font-bold text-slate-800">{'Foodics DMS or third-party drivers (e.g. OTO)'}</Text>
                {'.\n'}
                {'• You acknowledge that '}
                <Text className="font-bold text-slate-800">{'delivery quality and timing'}</Text>
                {' are the responsibility of the carrier and the merchant — Nooks is not the carrier.\n'}
                {'• Displayed delivery times are estimates and may vary by conditions.\n'}
                {'• Nooks is not responsible for driver behavior, lost orders, or damaged packaging during transit.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'8. Refunds'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'All refund requests are governed by the in-app '}
                <Text className="font-bold text-slate-800">{'Refund Policy'}</Text>
                {'. '}
                <Text className="font-bold text-slate-800">{'All approved refunds are issued to your in-app wallet'}</Text>
                {' — not to your card, not in cash.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'9. Acceptable Use'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'You may not:\n\n'}
                {'• Commit fraud or attempt to pay with a card you do not own.\n'}
                {'• Submit fake OTP attempts or abuse the SMS system.\n'}
                {'• Scrape data or reverse-engineer the app.\n'}
                {'• File frivolous or exaggerated complaints.\n'}
                {'• Initiate chargebacks without genuine cause.\n'}
                {'• Use the app for any unlawful purpose.\n\n'}
                <Text className="font-bold text-slate-800">{'Penalty:'}</Text>
                {' immediate account suspension or permanent termination.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'10. What Nooks Is NOT Responsible For (Critical)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'You expressly acknowledge that '}
                <Text className="font-bold text-slate-800">{'Nooks bears no responsibility'}</Text>
                {' for any of the following:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Food safety and food poisoning'}</Text>
                {' — solely the merchant\'s responsibility.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Food allergies'}</Text>
                {' and allergic reactions.\n'}
                {'• Ingredients, freshness, storage conditions, halal compliance.\n'}
                {'• Order accuracy, missing items, wrong preparation, slow kitchen.\n'}
                {'• Late delivery, lost orders, damaged packaging, driver behavior.\n'}
                {'• Third-party outages: '}
                <Text className="font-bold text-slate-800">{'Moyasar, Foodics, OTO, Apple, Google'}</Text>
                {', telecom carriers, internet or power outages.\n'}
                {'• Marketing claims made by the merchant ("best", "premium", etc.).\n'}
                {'• Merchant employee conduct and labor disputes.\n'}
                {'• Loss of loyalty points/stamps due to merchant changes or account deletion.\n'}
                {'• Apple/Google Wallet pass display issues on your device.\n'}
                {'• Force majeure (pandemic, war, regulatory ban, natural disaster).\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Indirect, consequential, punitive, or exemplary'}</Text>
                {' damages.\n'}
                {'• Loss of opportunity, profits, or reputation.\n'}
                {'• Cost of replacement food you did not receive or that was delayed.\n'}
                {'• Failures in linked external apps or services.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'11. Your Obligations'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Provide a correct phone number and accurate delivery address.\n'}
                {'• Receive your order at delivery time and be present at the address.\n'}
                {'• Not commit fraud or abuse the system.\n'}
                {'• Not abuse the OTP/SMS system.\n'}
                {'• Treat the merchant, employees, and delivery providers with respect.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'12. Liability Cap'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'To the maximum extent permitted by Saudi law:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Nooks\' total liability to you for any single order shall not exceed the value of that order'}</Text>
                {' — never more, in any case.\n'}
                {'• Excluded from this cap: personal injury caused by '}
                <Text className="font-bold text-slate-800">{'gross negligence'}</Text>
                {' or willful misconduct.\n'}
                {'• Wholly excluded: claims for lost opportunity, indirect, consequential, or punitive damages.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'13. Indemnification'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'You agree to indemnify and hold harmless the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' and the Nooks platform from any claims or losses arising from:\n\n'}
                {'• Fraudulent orders or payment with a card you do not own.\n'}
                {'• Chargebacks initiated without genuine cause.\n'}
                {'• Account abuse or any breach of these Terms.\n'}
                {'• False statements or fabricated complaints by you.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'14. Termination'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• You may delete your account at any time from the app settings.\n'}
                {'• We may terminate or suspend your account immediately for: fraud, repeated abuse, breach of these Terms, or upon official government request.\n'}
                {'• On termination: personal data is deleted per the Privacy Policy, and wallet balance and loyalty points are forfeited.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'15. Amendments'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'We reserve the right to amend these Terms at any time. You will be notified of material changes in advance via email and an in-app banner. Continued use of the app after a change constitutes acceptance of the updated Terms.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'16. Governing Law & Jurisdiction'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• These Terms are governed by '}
                <Text className="font-bold text-slate-800">{'the laws of the Kingdom of Saudi Arabia'}</Text>
                {'.\n'}
                {'• The competent courts in Riyadh have exclusive jurisdiction.\n'}
                {'• In case of any conflict between the Arabic and English versions, '}
                <Text className="font-bold text-slate-800">{'the Arabic version prevails'}</Text>
                {'.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'17. Contact'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'For any inquiry or complaint regarding these Terms:\n'}
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
