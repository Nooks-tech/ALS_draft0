import { useRouter } from 'expo-router';
import { Bell, MapPin, Search } from 'lucide-react-native';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { useCart } from '../../context/CartContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface MainHeaderProps {
  onSearchPress?: () => void;
}

export const MainHeader = ({ onSearchPress }: MainHeaderProps) => {
  const router = useRouter();
  const { orderType, selectedBranch, deliveryAddress } = useCart();
  const { primaryColor } = useMerchantBranding();

  const locationLabel = orderType === 'pickup'
    ? (selectedBranch?.name || 'Select branch')
    : (deliveryAddress?.address || 'Add address');

  return (
    <View className="pt-14 pb-4 px-4 bg-white border-b border-slate-100 flex-row justify-between items-center">
      <TouchableOpacity
        onPress={() => router.push('/order-type')}
        className="flex-row items-center flex-1 mr-2"
      >
        <View className="p-2 rounded-full mr-3" style={{ backgroundColor: `${primaryColor}18` }}>
          <MapPin size={20} color={primaryColor} />
        </View>
        <View className="flex-1">
          <Text className="text-xs text-slate-400 font-bold uppercase tracking-wider">
            {orderType === 'pickup' ? 'Pickup From' : 'Delivering To'}
          </Text>
          <Text className="text-slate-800 font-bold text-base" numberOfLines={1}>
            {locationLabel}
          </Text>
        </View>
      </TouchableOpacity>

      <View className="flex-row items-center space-x-3">
        <TouchableOpacity 
          onPress={onSearchPress}
          className="bg-slate-50 p-2.5 rounded-full border border-slate-100"
        >
          <Search size={20} color="#334155" />
        </TouchableOpacity>
        
        <TouchableOpacity
          onPress={() => Linking.openSettings()}
          className="bg-slate-50 p-2.5 rounded-full border border-slate-100 ml-2"
        >
          <Bell size={20} color="#334155" />
        </TouchableOpacity>
      </View>
    </View>
  );
};