import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

type OrderStatus =
  | 'Placed'
  | 'Pending'
  | 'Accepted'
  | 'Preparing'
  | 'Ready'
  | 'Out for delivery'
  | 'Delivered'
  | 'Cancelled'
  | 'On Hold';

const DEFAULT_ACCENT = '#0D9488';

// Pickup: Placed → Preparing → Received (= Delivered)  — 3 steps
// Delivery: Placed → Preparing → Out for delivery → Delivered  — 4 steps
//
// "Accepted" collapsed into "Preparing" on 2026-04-21 after merchants
// reported that the brief lingering "Accepted" state between the cashier
// tap and delivery_status=1 felt like noise. "Ready" dropped from pickup
// for the same reason — customers hear "ready for pickup" from staff in
// person; showing an intermediate stepper state added confusion.
const PICKUP_STEPS: OrderStatus[] = ['Placed', 'Preparing', 'Delivered'];
const DELIVERY_STEPS: OrderStatus[] = [
  'Placed',
  'Preparing',
  'Out for delivery',
  'Delivered',
];

function labelFor(
  key: OrderStatus,
  orderType: 'delivery' | 'pickup',
  isArabic: boolean,
): string {
  switch (key) {
    case 'Placed':
      return isArabic ? 'تم الإرسال' : 'Placed';
    case 'Preparing':
      return isArabic ? 'قيد التحضير' : 'Preparing';
    case 'Out for delivery':
      return isArabic ? 'في الطريق' : 'On the way';
    case 'Delivered':
      return orderType === 'pickup'
        ? (isArabic ? 'تم الاستلام' : 'Received')
        : (isArabic ? 'تم التوصيل' : 'Delivered');
    // Legacy dead-states retained for backward-compat on older orders.
    case 'Accepted':
      return isArabic ? 'تم القبول' : 'Accepted';
    case 'Ready':
      return isArabic ? 'جاهز' : 'Ready';
    default:
      return String(key);
  }
}

function subLabelFor(
  status: OrderStatus,
  orderType: 'delivery' | 'pickup',
  isArabic: boolean,
): string | null {
  switch (status) {
    case 'Placed':
      return isArabic ? 'بانتظار قبول المتجر' : 'Waiting for the store to accept';
    case 'Preparing':
      return isArabic ? 'طلبك قيد التحضير' : 'Your order is being prepared';
    case 'Out for delivery':
      return isArabic ? 'السائق في الطريق' : 'Driver is on the way';
    case 'Delivered':
      return orderType === 'pickup'
        ? (isArabic ? 'استلمت طلبك' : 'Order received')
        : (isArabic ? 'تم توصيل الطلب' : 'Order delivered');
    default:
      return null;
  }
}

// Fold legacy + out-of-lifecycle statuses into the canonical stepper
// states. Anything the DB check-constraint allows but the 3-/4-step
// steppers don't explicitly render lands somewhere sensible instead of
// falling through to "unknown — first step".
function normalizeStatus(
  status: OrderStatus,
  orderType: 'delivery' | 'pickup',
): OrderStatus {
  if (status === 'Accepted') return 'Preparing';
  if (status === 'Ready' && orderType === 'pickup') return 'Delivered';
  if (status === 'Ready' && orderType === 'delivery') return 'Preparing';
  if (status === 'Pending') return 'Placed';
  if (status === 'On Hold') return 'Placed';
  return status;
}

export function OrderStatusStepper({
  status,
  orderType,
  accentColor = DEFAULT_ACCENT }: {
  status: OrderStatus;
  orderType: 'delivery' | 'pickup';
  accentColor?: string;
}) {
  const { i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';

  const steps = orderType === 'delivery' ? DELIVERY_STEPS : PICKUP_STEPS;
  const normalized = normalizeStatus(status, orderType);
  const currentIndex = steps.indexOf(normalized);
  const effectiveIndex = currentIndex < 0 ? 0 : currentIndex;

  return (
    <View className="mb-6">
      {steps.map((stepKey, index) => {
        const isCompleted = index <= effectiveIndex || normalized === 'Delivered';
        const isCurrent = stepKey === normalized;
        const isLast = index === steps.length - 1;
        const sub = isCurrent ? subLabelFor(normalized, orderType, isArabic) : null;

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
                {labelFor(stepKey, orderType, isArabic)}
              </Text>
              {sub && <Text className="text-slate-500 text-xs mt-0.5">{sub}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}
