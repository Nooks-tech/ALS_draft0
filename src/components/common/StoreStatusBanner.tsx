import { AlertTriangle, Clock, XCircle } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useOperations } from '../../context/OperationsContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

/**
 * Banner shown when the store is closed or busy.
 * - closed: red banner, ordering disabled
 * - busy: amber banner with prep time estimate
 */
export function StoreStatusBanner() {
  const { isClosed, isBusy, prepTimeMinutes, busySecondsLeft } = useOperations();
  const { primaryColor } = useMerchantBranding();
  const [localBusySeconds, setLocalBusySeconds] = useState(0);
  const busyStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isBusy) {
      busyStartRef.current = null;
      setLocalBusySeconds(0);
      return;
    }
    if (!busyStartRef.current) busyStartRef.current = Date.now();
    const tick = () => {
      const total = Math.max(0, prepTimeMinutes * 60);
      const elapsed = Math.floor((Date.now() - (busyStartRef.current ?? Date.now())) / 1000);
      setLocalBusySeconds(Math.max(0, total - elapsed));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [isBusy, prepTimeMinutes]);

  if (isClosed) {
    return (
      <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-red-50 border border-red-100 flex-row items-center">
        <XCircle size={22} color="#dc2626" />
        <View className="ml-3 flex-1">
          <Text className="font-bold text-red-700">Store is currently closed</Text>
          <Text className="text-red-500 text-xs mt-0.5">Ordering is unavailable right now. Please check back later.</Text>
        </View>
      </View>
    );
  }

  if (isBusy) {
    const effectiveSeconds = busySecondsLeft > 0 ? busySecondsLeft : localBusySeconds;
    const min = Math.floor(effectiveSeconds / 60);
    const sec = effectiveSeconds % 60;
    const busyTimer = `${min}:${sec.toString().padStart(2, '0')}`;
    return (
      <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-amber-50 border border-amber-100 flex-row items-center">
        <Clock size={22} color="#d97706" />
        <View className="ml-3 flex-1">
          <Text className="font-bold text-amber-700">Store is busy</Text>
          <Text className="text-amber-600 text-xs mt-0.5">
            {prepTimeMinutes > 0
              ? `Estimated prep time: ~${prepTimeMinutes} min${effectiveSeconds > 0 ? ` (remaining ${busyTimer})` : ''}`
              : 'Orders may take longer than usual'}
          </Text>
        </View>
      </View>
    );
  }

  return null;
}
