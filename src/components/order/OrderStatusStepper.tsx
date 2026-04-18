import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

type OrderStatus =
  | 'Placed'
  | 'Accepted'
  | 'Preparing'
  | 'Ready'
  | 'Out for delivery'
  | 'Delivered'
  | 'Cancelled';

// Full lifecycle in canonical order. The stepper renders a subset depending
// on orderType: pickup skips "Out for delivery" and terminates at Ready,
// delivery skips Ready and terminates at Delivered.
const STATUS_ORDER: OrderStatus[] = [
  'Placed',
  'Accepted',
  'Preparing',
  'Ready',
  'Out for delivery',
  'Delivered',
];

const DEFAULT_ACCENT = '#0D9488';

function labelFor(key: OrderStatus, isArabic: boolean): string {
  switch (key) {
    case 'Placed':
      return isArabic ? 'تم الإرسال' : 'Placed';
    case 'Accepted':
      return isArabic ? 'تم القبول' : 'Accepted';
    case 'Preparing':
      return isArabic ? 'قيد التحضير' : 'Preparing';
    case 'Ready':
      return isArabic ? 'جاهز' : 'Ready';
    case 'Out for delivery':
      return isArabic ? 'في الطريق' : 'On the way';
    case 'Delivered':
      return isArabic ? 'تم التوصيل' : 'Delivered';
    default:
      return String(key);
  }
}

function subLabelFor(
  status: OrderStatus,
  orderType: 'delivery' | 'pickup',
  isArabic: boolean
): string | null {
  switch (status) {
    case 'Placed':
      return isArabic ? 'بانتظار قبول المتجر' : 'Waiting for the store to accept';
    case 'Accepted':
      return isArabic ? 'قبل المتجر طلبك' : 'The store accepted your order';
    case 'Preparing':
      return isArabic ? 'طلبك قيد التحضير' : 'Your order is being prepared';
    case 'Ready':
      return orderType === 'pickup'
        ? (isArabic ? 'جاهز للاستلام!' : 'Ready for pickup!')
        : (isArabic ? 'استلمه السائق' : 'Picked up by driver');
    case 'Out for delivery':
      return isArabic ? 'السائق في الطريق' : 'Driver is on the way';
    case 'Delivered':
      return isArabic ? 'تم توصيل الطلب' : 'Order delivered';
    default:
      return null;
  }
}

export function OrderStatusStepper({
  status,
  orderType,
  accentColor = DEFAULT_ACCENT,
}: {
  status: OrderStatus;
  orderType: 'delivery' | 'pickup';
  accentColor?: string;
}) {
  const { i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';

  // Pickup: Placed → Accepted → Preparing → Ready  (4 steps)
  // Delivery: Placed → Accepted → Preparing → Out for delivery → Delivered  (5 steps)
  const steps: OrderStatus[] =
    orderType === 'delivery'
      ? ['Placed', 'Accepted', 'Preparing', 'Out for delivery', 'Delivered']
      : ['Placed', 'Accepted', 'Preparing', 'Ready'];

  const currentIndex = STATUS_ORDER.indexOf(status);
  const effectiveIndex = currentIndex < 0 ? 0 : currentIndex;

  return (
    <View className="mb-6">
      {steps.map((stepKey, index) => {
        const stepIndex = STATUS_ORDER.indexOf(stepKey);
        const isCompleted = stepIndex <= effectiveIndex || status === 'Delivered';
        const isCurrent = stepKey === status;
        const isLast = index === steps.length - 1;
        const sub = isCurrent ? subLabelFor(status, orderType, isArabic) : null;

        return (
          <View key={stepKey} className="flex-row">
            <View className="items-center" style={{ width: 32 }}>
              <View
                style={isCompleted ? { backgroundColor: accentColor } : undefined}
                className={`w-8 h-8 rounded-full items-center justify-center ${isCompleted ? '' : 'bg-slate-200'}`}
              >
                {isCompleted ? (
                  <Text className="text-white font-bold text-sm">✓</Text>
                ) : (
                  <Text
                    style={isCurrent ? { color: accentColor } : undefined}
                    className={`font-bold text-sm ${isCurrent ? '' : 'text-slate-400'}`}
                  >
                    {index + 1}
                  </Text>
                )}
              </View>
              {!isLast && (
                <View
                  className={`flex-1 mt-1 ${isCompleted ? '' : 'bg-slate-200'}`}
                  style={{ width: 2, minHeight: 28, ...(isCompleted ? { backgroundColor: accentColor } : {}) }}
                />
              )}
            </View>
            <View className="ml-3 flex-1 mb-1">
              <Text
                className={`font-bold ${
                  isCurrent ? 'text-slate-900' : isCompleted ? 'text-slate-600' : 'text-slate-400'
                }`}
              >
                {labelFor(stepKey, isArabic)}
              </Text>
              {sub && <Text className="text-slate-500 text-xs mt-0.5">{sub}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}
