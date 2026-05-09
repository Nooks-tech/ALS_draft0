import { useRouter } from 'expo-router';
import { RotateCcw, X } from 'lucide-react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function RefundModal() {
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
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'سياسة الاسترجاع والإلغاء' : 'Refund & Cancellation'}</Text>
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
              <RotateCcw size={32} color={primaryColor} />
            </View>
          </View>

          {isArabic ? (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'سارية من ١٠ مايو ٢٠٢٦ · النسخة ٢٫٠'}</Text>
                {'\n\n'}
                {'تنطبق هذه السياسة على طلبات الطعام والمشروبات التي تتمّها عبر تطبيق '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {'. التاجر هو من يتخذ القرار النهائي في كل طلب استرداد، بينما '}
                <Text className="font-bold text-slate-800">{'مؤسسة نُوكس لتقنية المعلومات'}</Text>
                {' هي مزوّد البرمجيات فقط ولا تحتفظ بأموال التاجر (نموذج BYOG: المدفوعات تذهب من Moyasar مباشرة إلى حساب التاجر البنكي).'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١. سياسة المحفظة فقط'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'جميع المبالغ المستردة المعتمَدة تُصرف إلى محفظتك داخل التطبيق'}</Text>
                {' لدى التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' — '}
                <Text className="font-bold text-slate-800">{'لا إلى البطاقة، ولا نقداً'}</Text>
                {'.\n\n'}
                {'لماذا المحفظة؟\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'فورية'}</Text>
                {' — يصلك الرصيد مباشرة بعد الموافقة، بينما يستغرق الاسترداد للبطاقة من ٥ إلى ١٠ أيام عمل.\n'}
                {'• رصيد المحفظة هو '}
                <Text className="font-bold text-slate-800">{'رصيد متجر'}</Text>
                {' لدى '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' فقط، قابل للاستخدام في طلباتك القادمة.\n'}
                {'• ليس أداة دفع، ولا يخضع لتنظيم البنك المركزي السعودي (ساما)، ولا يُصرف نقداً.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٢. إلغاء الطلب'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• قبل قبول التاجر للطلب: يمكنك إلغاء الطلب بنفسك مع استرداد كامل إلى محفظتك.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'بعد قبول التاجر للطلب'}</Text>
                {' (بدء التحضير): '}
                <Text className="font-bold text-slate-800">{'لا يمكنك الإلغاء'}</Text>
                {' لأن المنتجات قابلة للتلف. يحقّ للتاجر وحده إلغاء الطلب بعد هذه النقطة.\n'}
                {'• الطلب في الطريق: لا يمكنك الإلغاء.\n'}
                {'• تم التسليم: لا يمكن الإلغاء — راجع حالات الاسترداد أدناه.\n\n'}
                {'هذا متوافق مع استثناء السلع القابلة للتلف في نظام التجارة الإلكترونية السعودي.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٣. متى يحقّ لك الاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحقّ لك طلب استرداد كامل أو جزئي '}
                <Text className="font-bold text-slate-800">{'إلى المحفظة'}</Text>
                {' في الحالات التالية:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'منتج خاطئ:'}</Text>
                {' وصلك منتج مختلف عمّا طلبته — استرداد كامل لقيمة العنصر المتأثر.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'عناصر ناقصة:'}</Text>
                {' عنصر أو أكثر لم يصل ضمن الطلب — استرداد جزئي بقيمة العناصر الناقصة.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'الطلب لم يصل:'}</Text>
                {' تم تأكيد الطلب والدفع ولم يتم التسليم — استرداد كامل.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'منتج تالف أو فاسد:'}</Text>
                {' وصل المنتج بحالة غير مقبولة — استرداد كامل أو جزئي بحسب الحالة.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'خطأ في الفاتورة:'}</Text>
                {' خصم مزدوج أو بقيمة غير صحيحة — استرداد للفرق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٤. كيف تُقدِّم شكوى'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'١. ادخل على الطلب من شاشة الطلبات في التطبيق.\n'}
                {'٢. اضغط على "تقديم شكوى" '}
                <Text className="font-bold text-slate-800">{'خلال ٢٤ ساعة من تسليم الطلب'}</Text>
                {' (أو من الوقت المتوقع للتسليم في حال عدم الوصول).\n'}
                {'٣. وضّح المشكلة بدقة وأرفق '}
                <Text className="font-bold text-slate-800">{'صوراً'}</Text>
                {' كلما أمكن (مهمة لإثبات الحالة).\n'}
                {'٤. يقوم التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' بمراجعة الشكوى واتخاذ القرار النهائي '}
                <Text className="font-bold text-slate-800">{'خلال ٤٨ ساعة'}</Text>
                {'.\n'}
                {'٥. ستصلك إشعارات بحالة الشكوى وقرارها.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٥. التصعيد إلى نُوكس'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• إذا لم يردّ التاجر على شكواك خلال '}
                <Text className="font-bold text-slate-800">{'٢٤ ساعة'}</Text>
                {'، تُصعَّد الشكوى تلقائياً إلى فريق عمليات نُوكس للمراجعة.\n'}
                {'• فريق نُوكس يعمل كوسيط '}
                <Text className="font-bold text-slate-800">{'حسن النية'}</Text>
                {' بين العميل والتاجر، لكن '}
                <Text className="font-bold text-slate-800">{'القرار النهائي يبقى للتاجر'}</Text>
                {' لأنه صاحب المتجر وصاحب الأموال (نموذج BYOG).\n'}
                {'• يمكنك أيضاً التواصل مباشرة مع التاجر عبر: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٦. حالات لا يحقّ فيها الاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• '}
                <Text className="font-bold text-slate-800">{'تغيُّر الرأي'}</Text>
                {' بعد قبول التاجر للطلب وبدء التحضير.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'مشاكل ذوقية شخصية'}</Text>
                {' لا تتعلق بمطابقة المنتج لوصفه — إذا كان الطعام مطابقاً للمنيو فلا استرداد.\n'}
                {'• الخصومات والعروض الترويجية المستخدَمة بالفعل.\n'}
                {'• تقديم عنوان توصيل خاطئ أو عدم التواجد عند الاستلام دون تنسيق.\n'}
                {'• مرور أكثر من '}
                <Text className="font-bold text-slate-800">{'٢٤ ساعة'}</Text>
                {' على تسليم الطلب دون تقديم شكوى.\n'}
                {'• شحنات محفظة OTP الخاصة بالتاجر — هذه تخصّ التاجر وليست ميزة للعميل.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٧. تجميد المحفظة بعد عدم الاستخدام'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يُجمَّد رصيد محفظتك بعد '}
                <Text className="font-bold text-slate-800">{'٢٤ شهراً'}</Text>
                {' من آخر نشاط لك في التطبيق ما لم يحدد التاجر سياسة مختلفة. يمكنك التواصل مع التاجر لإعادة تنشيطه. الرصيد المجمَّد لا يُصرف نقداً ولا يُحوَّل لحساب بنكي — هذه طبيعة رصيد المتجر.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٨. النزاعات البنكية (Chargebacks)'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• توافق على '}
                <Text className="font-bold text-slate-800">{'استخدام مسار الشكاوى داخل التطبيق أولاً'}</Text>
                {' قبل التوجّه إلى البنك المُصدِر للبطاقة.\n'}
                {'• مدفوعاتك تتم على حساب التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' في Moyasar — أي نزاع بنكي يكون '}
                <Text className="font-bold text-slate-800">{'بينك وبين التاجر والبنك'}</Text>
                {'، ولا تكون نُوكس طرفاً.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'النزاعات الكيدية أو دون سبب حقيقي قد تؤدي إلى تعليق الحساب أو إنهائه'}</Text>
                {'، إضافة إلى احتمال تحميلك رسوم النزاع البنكي.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٩. التواصل'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'لتقديم شكوى أو الاستفسار عن طلب استرداد:\n'}
                {'• مسار الشكاوى داخل التطبيق هو القناة المعتمدة.\n'}
                {'• البريد الإلكتروني للتاجر: '}
                <Text className="font-bold text-slate-800">{email}</Text>
                {'\n\n'}
                {'تذكير: نُوكس لا تتخذ قرارات الاسترداد الفردية ولا تحتفظ بأموال التاجر — هذه مسؤولية التاجر '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' وحده. نُوكس تُتيح فقط البنية البرمجية ومسار الشكاوى.'}
              </Text>
            </>
          ) : (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'Effective: 10 May 2026 · Version 2.0'}</Text>
                {'\n\n'}
                {'This policy applies to food and beverage orders placed through the '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' app. The merchant makes the final decision on each refund request, while '}
                <Text className="font-bold text-slate-800">{'Nooks Information Technology Est.'}</Text>
                {' is the software vendor only and does not hold the merchant\'s funds (BYOG model: payments flow from Moyasar directly to the merchant\'s own bank account).'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'1. Wallet-Only Policy'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'All approved refunds are issued to your in-app wallet'}</Text>
                {' at the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' — '}
                <Text className="font-bold text-slate-800">{'not to your card, not in cash'}</Text>
                {'.\n\n'}
                {'Why wallet?\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Instant'}</Text>
                {' — credit lands in your wallet immediately upon approval, while card refunds take 5–10 business days.\n'}
                {'• Wallet balance is '}
                <Text className="font-bold text-slate-800">{'store credit'}</Text>
                {' at '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' only, usable on your future orders.\n'}
                {'• It is not a payment instrument, not subject to SAMA regulation, and not redeemable for cash.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'2. Order Cancellation'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Before the merchant accepts the order: you may cancel yourself with a full refund to your wallet.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'After the merchant accepts the order'}</Text>
                {' (preparation has begun): '}
                <Text className="font-bold text-slate-800">{'you cannot cancel'}</Text>
                {' because the goods are perishable. Only the merchant may cancel from this point.\n'}
                {'• In transit: cancellation not allowed.\n'}
                {'• Delivered: cancellation not allowed — see refund eligibility below.\n\n'}
                {'This is consistent with the perishable goods exception under the Saudi E-Commerce Law.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'3. When You Are Entitled to a Refund'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'You may request a full or partial refund '}
                <Text className="font-bold text-slate-800">{'to your wallet'}</Text>
                {' in the following cases:\n\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Wrong item:'}</Text>
                {' a different product was delivered than what you ordered — full refund for the affected item.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Missing items:'}</Text>
                {' one or more items did not arrive — partial refund for the missing items.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Order never arrived:'}</Text>
                {' the order was confirmed and paid for but never delivered — full refund.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Damaged or spoiled food:'}</Text>
                {' the product arrived in unacceptable condition — full or partial refund depending on the case.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Incorrect charge:'}</Text>
                {' duplicate charge or wrong amount — refund of the difference.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'4. How to File a Complaint'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'1. Open the order from the Orders screen in the app.\n'}
                {'2. Tap "File a complaint" '}
                <Text className="font-bold text-slate-800">{'within 24 hours of delivery'}</Text>
                {' (or from the expected delivery time if the order never arrived).\n'}
                {'3. Describe the issue precisely and attach '}
                <Text className="font-bold text-slate-800">{'photos'}</Text>
                {' whenever possible (important for substantiation).\n'}
                {'4. The merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' reviews the complaint and makes the final decision '}
                <Text className="font-bold text-slate-800">{'within 48 hours'}</Text>
                {'.\n'}
                {'5. You will receive notifications about the complaint status and decision.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'5. Escalation to Nooks'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• If the merchant does not respond to your complaint within '}
                <Text className="font-bold text-slate-800">{'24 hours'}</Text>
                {', the complaint is automatically escalated to the Nooks operations team for review.\n'}
                {'• The Nooks team acts as a '}
                <Text className="font-bold text-slate-800">{'good-faith intermediary'}</Text>
                {' between customer and merchant, but '}
                <Text className="font-bold text-slate-800">{'the final decision rests with the merchant'}</Text>
                {' as the seller and fund-holder (BYOG model).\n'}
                {'• You may also contact the merchant directly at: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'6. Cases Where Refunds Are Not Applicable'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• '}
                <Text className="font-bold text-slate-800">{'Change of mind'}</Text>
                {' after the merchant accepted the order and preparation has started.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Personal taste preferences'}</Text>
                {' unrelated to product description — if the food matches the menu, no refund.\n'}
                {'• Promo discounts already redeemed.\n'}
                {'• Incorrect delivery address provided or absence at handoff without coordination.\n'}
                {'• More than '}
                <Text className="font-bold text-slate-800">{'24 hours'}</Text>
                {' have passed since delivery without filing a complaint.\n'}
                {'• Merchant OTP wallet top-ups — these belong to the merchant and are not a customer-facing feature.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'7. Wallet Inactivity Freeze'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'Your wallet balance is frozen after '}
                <Text className="font-bold text-slate-800">{'24 months'}</Text>
                {' of inactivity in the app unless the merchant configures a different policy. You may contact the merchant to reactivate it. A frozen balance is not redeemable for cash and not transferable to a bank account — that is the nature of store credit.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'8. Bank Chargebacks'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• You agree to '}
                <Text className="font-bold text-slate-800">{'use the in-app complaint flow first'}</Text>
                {' before initiating a chargeback with your card-issuing bank.\n'}
                {'• Your payments are processed on the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {'\'s Moyasar account — any chargeback is '}
                <Text className="font-bold text-slate-800">{'between you, the merchant, and the bank'}</Text>
                {'; Nooks is not a party.\n'}
                {'• '}
                <Text className="font-bold text-slate-800">{'Frivolous chargebacks or those without genuine cause may result in account suspension or termination'}</Text>
                {', and you may be charged the chargeback dispute fees.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'9. Contact'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'To file a complaint or inquire about a refund:\n'}
                {'• The in-app complaint flow is the primary channel.\n'}
                {'• Merchant email: '}
                <Text className="font-bold text-slate-800">{email}</Text>
                {'\n\n'}
                {'Reminder: Nooks does not decide individual refunds and does not hold merchant funds — that is solely the responsibility of the merchant '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {'. Nooks only provides the software platform and the complaint pipeline.'}
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
