import { Clock } from 'lucide-react-native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface OrderProps {
  id: string;
  status: 'Preparing' | 'Ready' | 'Out for delivery' | 'Delivered' | 'Cancelled';
  price: number;
  date: string;
  items: string;
  onPress?: () => void;
}

export const OrderCard = ({ id, status, price, date, items, onPress }: OrderProps) => {
  const { primaryColor } = useMerchantBranding();

  const getStatusColor = () => {
    switch (status) {
      case 'Preparing': return 'bg-yellow-100 text-yellow-700';
      case 'Ready': return 'bg-green-100 text-green-700';
      case 'Out for delivery': return 'bg-blue-100 text-blue-700';
      case 'Delivered': return 'bg-gray-100 text-gray-600';
      case 'Cancelled': return 'bg-red-100 text-red-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const statusStyle = getStatusColor();
  const [bgClass, textClass] = statusStyle.split(' ');

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} className="bg-white p-4 mb-4 rounded-xl border border-gray-100 shadow-sm">
      <View className="flex-row justify-between items-center mb-3">
        <Text className="text-gray-500 font-medium">Order #{id}</Text>
        <View className={`px-3 py-1 rounded-full ${bgClass}`}>
          <Text className={`text-xs font-bold ${textClass}`}>{status}</Text>
        </View>
      </View>

      <View className="flex-row items-center mb-3">
        <View className="p-3 rounded-lg mr-3" style={{ backgroundColor: `${primaryColor}10` }}>
          <Clock size={20} color={primaryColor} />
        </View>
        <View className="flex-1">
          <Text className="font-bold text-gray-900 text-base" numberOfLines={1}>{items}</Text>
          <Text className="text-gray-400 text-xs mt-1">{date}</Text>
        </View>
      </View>

      <View className="flex-row justify-between items-center pt-3 border-t border-gray-50">
        <Text className="font-bold text-lg text-gray-900">{price} SAR</Text>
        <TouchableOpacity onPress={onPress}>
          <Text className="font-bold text-sm" style={{ color: primaryColor }}>View Details</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};