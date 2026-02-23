import { AlertTriangle, Clock, XCircle } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useOperations } from '../../context/OperationsContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

/**
 * Banner shown when the store is closed or busy.
 * - closed: red banner, ordering disabled
 * - busy: amber banner with prep time estimate
 */
export function StoreStatusBanner() {
  const { isClosed, isBusy, prepTimeMinutes } = useOperations();
  const { primaryColor } = useMerchantBranding();

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
    return (
      <View className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-amber-50 border border-amber-100 flex-row items-center">
        <Clock size={22} color="#d97706" />
        <View className="ml-3 flex-1">
          <Text className="font-bold text-amber-700">Store is busy</Text>
          <Text className="text-amber-600 text-xs mt-0.5">
            {prepTimeMinutes > 0
              ? `Estimated prep time: ~${prepTimeMinutes} min`
              : 'Orders may take longer than usual'}
          </Text>
        </View>
      </View>
    );
  }

  return null;
}
