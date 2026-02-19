import { Text, View } from 'react-native';

type OrderStatus = 'Preparing' | 'Ready' | 'Out for delivery' | 'Delivered' | 'Cancelled';

const STATUS_STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'Preparing', label: 'Preparing' },
  { key: 'Ready', label: 'Ready' },
  { key: 'Out for delivery', label: 'On the way' },
  { key: 'Delivered', label: 'Delivered' },
];

const STATUS_ORDER: OrderStatus[] = ['Preparing', 'Ready', 'Out for delivery', 'Delivered'];

const DEFAULT_ACCENT = '#0D9488';

export function OrderStatusStepper({
  status,
  orderType,
  accentColor = DEFAULT_ACCENT,
}: {
  status: OrderStatus;
  orderType: 'delivery' | 'pickup';
  accentColor?: string;
}) {
  const steps = orderType === 'delivery'
    ? STATUS_STEPS
    : STATUS_STEPS.filter((s) => s.key !== 'Out for delivery');

  const currentIndex = STATUS_ORDER.indexOf(status);
  const effectiveIndex = currentIndex < 0 ? 0 : currentIndex;

  return (
    <View className="mb-6">
      {steps.map((step, index) => {
        const stepIndex = STATUS_ORDER.indexOf(step.key);
        const isCompleted = stepIndex <= effectiveIndex || status === 'Delivered';
        const isCurrent = step.key === status;
        const isLast = index === steps.length - 1;

        return (
          <View key={step.key} className="flex-row">
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
                {step.label}
              </Text>
              {isCurrent && (
                <Text className="text-slate-500 text-xs mt-0.5">
                  {status === 'Preparing' && 'Your order is being prepared'}
                  {status === 'Ready' && (orderType === 'pickup' ? 'Ready for pickup!' : 'Picked up by driver')}
                  {status === 'Out for delivery' && 'Driver is on the way'}
                  {status === 'Delivered' && 'Order delivered'}
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
