import { Clock, XCircle } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOperations } from '../../context/OperationsContext';

/**
 * Banner shown when the store is closed or busy.
 * - closed: red banner, ordering disabled
 * - busy: amber banner with prep time estimate
 */
export function StoreStatusBanner() {
  const { i18n } = useTranslation();
  const { isClosed, isBusy, prepTimeMinutes, busySecondsLeft } = useOperations();
  const isArabic = i18n.language === 'ar';

  if (isClosed) {
    return (
      <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-red-50 border border-red-100 flex-row items-center">
        <XCircle size={22} color="#dc2626" />
        <View className="ml-3 flex-1">
          <Text className="font-bold text-red-700">{isArabic ? 'المتجر مغلق حالياً' : 'Store is currently closed'}</Text>
          <Text className="text-red-500 text-xs mt-0.5">{isArabic ? 'الطلب غير متاح حالياً. يرجى المحاولة لاحقاً.' : 'Ordering is unavailable right now. Please check back later.'}</Text>
        </View>
      </View>
    );
  }

  if (isBusy) {
    const totalBusySeconds = Math.max(0, prepTimeMinutes * 60);
    const effectiveSeconds = Math.max(0, busySecondsLeft);
    const elapsed = Math.max(0, totalBusySeconds - effectiveSeconds);
    const progress = totalBusySeconds > 0 ? Math.min(1, elapsed / totalBusySeconds) : 0;
    const min = Math.floor(effectiveSeconds / 60);
    const sec = effectiveSeconds % 60;
    const busyTimer = `${min}:${sec.toString().padStart(2, '0')}`;
    return (
      <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-amber-50 border border-amber-100">
        <View className="flex-row items-center">
        <Clock size={22} color="#d97706" />
        <View className="ml-3 flex-1">
          <Text className="font-bold text-amber-700">{isArabic ? 'المتجر مشغول حالياً' : 'Store is busy'}</Text>
            <Text className="text-amber-900 text-base font-extrabold mt-1">
              {isArabic ? `المتبقي ${busyTimer}` : `${busyTimer} remaining`}
            </Text>
            <Text className="text-amber-700 text-xs mt-0.5">
              {prepTimeMinutes > 0
                ? (isArabic ? `الوقت المتوقع للتحضير: حوالي ${prepTimeMinutes} دقيقة` : `Estimated prep time: ~${prepTimeMinutes} min`)
                : (isArabic ? 'قد تستغرق الطلبات وقتاً أطول من المعتاد' : 'Orders may take longer than usual')}
            </Text>
          </View>
        </View>
        {totalBusySeconds > 0 && (
          <View className="mt-3 h-2 rounded-full bg-amber-100 overflow-hidden">
            <View className="h-full rounded-full bg-amber-500" style={{ width: `${progress * 100}%` }} />
          </View>
        )}
        </View>
    );
  }

  return null;
}
