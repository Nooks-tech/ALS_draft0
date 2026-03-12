import { Clock } from 'lucide-react-native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface OrderProps {
  id: string;
  status: 'Preparing' | 'Ready' | 'Out for delivery' | 'Delivered' | 'Cancelled' | 'On Hold';
  price: number;
  date: string;
  items: string;
  refundStatus?: string | null;
  onPress?: () => void;
}

export const OrderCard = ({ id, status, price, date, items, refundStatus, onPress }: OrderProps) => {
  const { primaryColor, menuCardColor, textColor } = useMerchantBranding();

  const getStatusColor = () => {
    switch (status) {
      case 'Preparing': return 'bg-yellow-100 text-yellow-700';
      case 'Ready': return 'bg-green-100 text-green-700';
      case 'Out for delivery': return 'bg-blue-100 text-blue-700';
      case 'Delivered': return 'bg-gray-100 text-gray-600';
      case 'Cancelled': return 'bg-red-100 text-red-600';
      case 'On Hold': return 'bg-orange-100 text-orange-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const statusStyle = getStatusColor();
  const [bgClass, textClass] = statusStyle.split(' ');

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      className="p-4 mb-4 rounded-xl border border-gray-100 shadow-sm"
      style={{ backgroundColor: menuCardColor }}
    >
      <View className="flex-row justify-between items-center mb-3">
        <Text className="font-medium" style={{ color: textColor }}>Order #{id}</Text>
        <View className="flex-row gap-1.5">
          <View className={`px-3 py-1 rounded-full ${bgClass}`}>
            <Text className={`text-xs font-bold ${textClass}`}>{status}</Text>
          </View>
          {(refundStatus === 'refunded' || refundStatus === 'voided') && (
            <View className="px-2 py-1 rounded-full bg-green-100">
              <Text className="text-xs font-bold text-green-700">Refunded</Text>
            </View>
          )}
          {refundStatus === 'refund_failed' && (
            <View className="px-2 py-1 rounded-full bg-red-100">
              <Text className="text-xs font-bold text-red-600">Refund Failed</Text>
            </View>
          )}
          {refundStatus === 'pending_manual' && (
            <View className="px-2 py-1 rounded-full bg-amber-100">
              <Text className="text-xs font-bold text-amber-700">Refund Pending</Text>
            </View>
          )}
        </View>
      </View>

      <View className="flex-row items-center mb-3">
        <View className="p-3 rounded-lg mr-3" style={{ backgroundColor: `${primaryColor}10` }}>
          <Clock size={20} color={primaryColor} />
        </View>
        <View className="flex-1">
          <Text className="font-bold text-base" style={{ color: textColor }} numberOfLines={1}>{items}</Text>
          <Text className="text-xs mt-1" style={{ color: textColor }}>{date}</Text>
        </View>
      </View>

      <View className="flex-row justify-between items-center pt-3 border-t border-gray-50">
        <Text className="font-bold text-lg" style={{ color: textColor }}>{price} SAR</Text>
        <TouchableOpacity onPress={onPress}>
          <Text className="font-bold text-sm" style={{ color: primaryColor }}>View Details</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};