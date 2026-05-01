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
                <Text className="font-bold text-slate-800">{'آخر تحديث: أبريل ٢٠٢٦'}</Text>
                {'\n\n'}
                {'نظرًا لطبيعة المنتجات الغذائية والمشروبات القابلة للتلف، وضع '}
                <Text className="font-bold text-slate-800">{brandNameAr}</Text>
                {' سياسة واضحة وعادلة للإلغاء والاسترجاع تحمي حقوق المستخدمين والتجار، وذلك بما يتوافق مع نظام التجارة الإلكترونية ولوائح وزارة التجارة في المملكة العربية السعودية.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'١. إلغاء الطلبات'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تم الطلب — لم يقبله التاجر بعد: يمكن الإلغاء مع استرداد كامل.\n'}
                {'• قبِل التاجر الطلب — بدأ التحضير: لا يمكن الإلغاء (منتجات قابلة للتلف).\n'}
                {'• الطلب في الطريق (قيد التوصيل): لا يمكن الإلغاء.\n'}
                {'• تم التسليم: لا يمكن الإلغاء — راجع حالات الاسترداد أدناه.\n\n'}
                {'بمجرد قبول التاجر للطلب وبدء تحضير الأطعمة أو المشروبات، لا يمكن الإلغاء نظرًا لطبيعة المنتجات القابلة للتلف. هذا يتوافق مع استثناء السلع القابلة للتلف في نظام التجارة الإلكترونية السعودي.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٢. حالات الاستحقاق للاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'يحق لك طلب استرداد كامل أو جزئي في الحالات التالية:\n\n'}
                {'• منتج خاطئ: تم توصيل منتج مختلف عمّا تم طلبه — استرداد كامل للمنتج المتأثر.\n'}
                {'• عناصر ناقصة: عنصر أو أكثر مفقود من الطلب — استرداد جزئي بقيمة العناصر الناقصة.\n'}
                {'• الطلب لم يصل: تم تأكيد الطلب والدفع ولم يتم التوصيل — استرداد كامل.\n'}
                {'• منتج تالف أو غير صالح: وصل المنتج بحالة غير مقبولة — استرداد كامل أو جزئي حسب تقدير فريق الدعم.\n'}
                {'• خطأ في الدفع: تم خصم المبلغ أكثر من مرة أو بقيمة خاطئة — استرداد كامل للفرق.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٣. كيفية طلب الاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'١. تواصل مع فريق الدعم خلال ٢٤ ساعة من استلام الطلب (أو من الوقت المتوقع للتسليم في حال عدم الوصول).\n'}
                {'٢. وضّح المشكلة وأرفق صورًا إن أمكن.\n'}
                {'٣. سيقوم فريقنا بمراجعة الطلب والتواصل مع التاجر ومزوّد التوصيل.\n'}
                {'٤. ستتلقى ردًا خلال ٤٨ ساعة عمل من تاريخ تقديم الطلب.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٤. مدة الاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'في حال الموافقة، يتم إعادة المبلغ إلى وسيلة الدفع الأصلية:\n\n'}
                {'• بطاقة مدى: من ٣ إلى ٧ أيام عمل.\n'}
                {'• Visa / MasterCard: من ٧ إلى ١٤ يوم عمل.\n'}
                {'• Apple Pay: من ٣ إلى ٧ أيام عمل.\n\n'}
                {'المدة الفعلية تعتمد على البنك المصدر للبطاقة. يتم معالجة الاسترداد بواسطة بوابة مُيسَّر (Moyasar) المرخّصة من البنك المركزي السعودي.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٥. حالات لا يُقبل فيها الاسترداد'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• تغيّر رأي المستخدم بعد بدء التحضير.\n'}
                {'• تقديم عنوان توصيل خاطئ من قِبَل المستخدم.\n'}
                {'• عدم التواجد في عنوان التوصيل وقت الوصول وفشل التواصل.\n'}
                {'• مشاكل ذوقية شخصية لا تتعلق بجودة المنتج أو مطابقته للوصف.\n'}
                {'• مرور أكثر من ٢٤ ساعة على استلام الطلب دون تقديم شكوى.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'٦. الاتصال بنا'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'لتقديم طلب استرداد أو أي استفسار:\n'}
                {'البريد الإلكتروني: '}
                <Text className="font-bold text-slate-800">{email}</Text>
              </Text>
            </>
          ) : (
            <>
              <Text className="text-slate-600 leading-6 mb-4">
                <Text className="font-bold text-slate-800">{'Last updated: April 2026'}</Text>
                {'\n\n'}
                {'Due to the perishable nature of food and beverage products, '}
                <Text className="font-bold text-slate-800">{brandName}</Text>
                {' has established a clear and fair cancellation and refund policy that protects the rights of both users and merchants, in compliance with the Saudi E-Commerce Law and Ministry of Commerce regulations.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'1. Order Cancellation'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Placed — Not yet accepted by merchant: Cancellation allowed with full refund.\n'}
                {'• Accepted — Preparation started: Cancellation not allowed (perishable goods).\n'}
                {'• In transit (out for delivery): Cancellation not allowed.\n'}
                {'• Delivered: Cancellation not allowed — see refund eligibility below.\n\n'}
                {'Once the merchant accepts the order and begins preparing food or beverages, cancellation is not possible due to the perishable nature of the goods. This is consistent with the perishable goods exception under the Saudi E-Commerce Law.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'2. Refund Eligibility'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'You may request a full or partial refund in the following cases:\n\n'}
                {'• Wrong Item: A different product was delivered than what was ordered — full refund for the affected item.\n'}
                {'• Missing Items: One or more ordered items are missing — partial refund for the missing items.\n'}
                {'• Order Never Arrived: The order was confirmed and paid for but never delivered — full refund.\n'}
                {'• Damaged or Unfit Product: The product arrived in an unacceptable condition — full or partial refund at the discretion of the support team.\n'}
                {'• Payment Error: You were charged more than once or an incorrect amount — full refund of the difference.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'3. How to Request a Refund'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'1. Contact our support team within 24 hours of receiving the order (or from the expected delivery time if the order never arrived).\n'}
                {'2. Describe the issue and attach photos if possible.\n'}
                {'3. Our team will review the request and coordinate with the merchant and delivery provider.\n'}
                {'4. You will receive a response within 48 business hours.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'4. Refund Timeframe'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'Approved refunds will be processed back to the original payment method:\n\n'}
                {'• Mada: 3 to 7 business days.\n'}
                {'• Visa / MasterCard: 7 to 14 business days.\n'}
                {'• Apple Pay: 3 to 7 business days.\n\n'}
                {'Actual processing time depends on the issuing bank. Refunds are processed through Moyasar, licensed by the Saudi Central Bank (SAMA).'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'5. Cases Where Refunds Are Not Applicable'}</Text>
              <Text className="text-slate-600 leading-6 mb-4">
                {'• Change of mind after preparation has started.\n'}
                {'• Incorrect delivery address provided by the user.\n'}
                {'• User was not present at the delivery address and could not be reached.\n'}
                {'• Personal taste preferences unrelated to product quality or description.\n'}
                {'• More than 24 hours have passed since delivery without filing a complaint.'}
              </Text>

              <Text className="text-slate-800 font-bold mb-2">{'6. Contact Us'}</Text>
              <Text className="text-slate-600 leading-6 mb-8">
                {'To submit a refund request or inquire about this policy:\n'}
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
