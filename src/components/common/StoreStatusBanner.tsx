import { Clock, XCircle } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOperations } from '../../context/OperationsContext';

function formatMmSs(totalSeconds: number): string {
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function formatClockTime(iso: string, isArabic: boolean): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString(isArabic ? 'ar-SA' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Banner shown whenever the branch is EFFECTIVELY closed — manual
 * close, busy timer (with live countdown), outside scheduled hours
 * (with the opening time), or billing closure. Mounted on the menu
 * and cart screens so customers learn before they reach checkout;
 * checkout and the server gate independently.
 */
export function StoreStatusBanner() {
  const { i18n } = useTranslation();
  const { effectivelyClosed, closedReason, reopensAt, reopenSecondsLeft } = useOperations();
  const isArabic = i18n.language === 'ar';

  if (!effectivelyClosed) return null;

  if (closedReason === 'busy') {
    const showTimer = reopenSecondsLeft > 0;
    return (
      <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-amber-50 border border-amber-100 flex-row items-center">
        <Clock size={22} color="#d97706" />
        <View className="ms-3 flex-1">
          <Text className="font-bold text-amber-700">
            {isArabic ? 'المتجر مغلق مؤقتاً' : 'Temporarily closed'}
          </Text>
          {showTimer ? (
            <Text className="text-amber-900 text-base font-extrabold mt-1">
              {isArabic ? `يفتح بعد ${formatMmSs(reopenSecondsLeft)}` : `Reopens in ${formatMmSs(reopenSecondsLeft)}`}
            </Text>
          ) : null}
          <Text className="text-amber-700 text-xs mt-0.5">
            {isArabic
              ? 'يمكنك تصفح القائمة، والطلب يفتح تلقائياً عند انتهاء المؤقت.'
              : 'You can browse the menu — ordering reopens automatically when the timer ends.'}
          </Text>
        </View>
      </View>
    );
  }

  const opensAt = closedReason === 'outside_hours' && reopensAt ? formatClockTime(reopensAt, isArabic) : null;
  return (
    <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-red-50 border border-red-100 flex-row items-center">
      <XCircle size={22} color="#dc2626" />
      <View className="ms-3 flex-1">
        <Text className="font-bold text-red-700">
          {isArabic ? 'المتجر مغلق حالياً' : 'Store is currently closed'}
        </Text>
        <Text className="text-red-500 text-xs mt-0.5">
          {opensAt
            ? isArabic
              ? `خارج ساعات العمل — يفتح الساعة ${opensAt}.`
              : `Outside working hours — opens at ${opensAt}.`
            : isArabic
              ? 'الطلب غير متاح حالياً. يرجى المحاولة لاحقاً.'
              : 'Ordering is unavailable right now. Please check back later.'}
        </Text>
      </View>
    </View>
  );
}
