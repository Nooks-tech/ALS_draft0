import { Bell, MapPin, Search } from 'lucide-react-native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useCart } from '../../context/CartContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface MainHeaderProps {
  onSearchPress?: () => void;
}

export const MainHeader = ({ onSearchPress }: MainHeaderProps) => {
  const { orderType, setOrderType } = useCart();
  const { primaryColor } = useMerchantBranding();

  return (
    <View className="pt-14 pb-4 px-4 bg-white border-b border-slate-100 flex-row justify-between items-center">
      <TouchableOpacity
        onPress={() => setOrderType(orderType === 'delivery' ? 'pickup' : 'delivery')}
        className="flex-row items-center"
      >
        <View className="p-2 rounded-full mr-3" style={{ backgroundColor: `${primaryColor}18` }}>
          <MapPin size={20} color={primaryColor} />
        </View>
        <View>
          <Text className="text-xs text-slate-400 font-bold uppercase tracking-wider">
            {orderType === 'pickup' ? 'Pickup From' : 'Delivering To'}
          </Text>
          <Text className="text-slate-800 font-bold text-base">
            {orderType === 'pickup' ? 'Dammam Branch' : 'Current Location'}
          </Text>
        </View>
      </TouchableOpacity>

      {/* RIGHT: Actions */}
      <View className="flex-row items-center space-x-3">
        <TouchableOpacity 
          onPress={onSearchPress}
          className="bg-slate-50 p-2.5 rounded-full border border-slate-100"
        >
          <Search size={20} color="#334155" />
        </TouchableOpacity>
        
        <TouchableOpacity className="bg-slate-50 p-2.5 rounded-full border border-slate-100 ml-2">
          <Bell size={20} color="#334155" />
        </TouchableOpacity>
      </View>
    </View>
  );
};