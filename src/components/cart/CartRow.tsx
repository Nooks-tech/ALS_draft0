import { Minus, Plus } from 'lucide-react-native';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import { CartItem } from '../../context/CartContext';

interface CartRowProps {
  item: CartItem;
  onIncrease: () => void;
  onDecrease: () => void;
  onRemove: () => void;
}

export const CartRow = ({ item, onIncrease, onDecrease, onRemove }: CartRowProps) => {
  return (
    <View className="flex-row items-center bg-white p-4 mb-3 rounded-xl shadow-sm border border-gray-100">
      {/* 1. Image */}
      <Image 
        source={{ uri: item.image }} 
        className="w-16 h-16 rounded-lg bg-gray-200"
      />

      {/* 2. Info */}
      <View className="flex-1 ml-3">
        <Text className="font-bold text-gray-800 text-base">{item.name}</Text>
        <Text className="text-[#FF5A5F] font-bold mt-1">{item.price * item.quantity} SAR</Text>
      </View>

      {/* 3. Controls */}
      <View className="flex-row items-center bg-gray-50 rounded-lg p-1">
        <TouchableOpacity onPress={onDecrease} className="p-2 bg-white rounded-md shadow-sm">
          <Minus size={16} color="#374151" />
        </TouchableOpacity>
        
        <Text className="mx-3 font-bold text-lg">{item.quantity}</Text>
        
        <TouchableOpacity onPress={onIncrease} className="p-2 bg-white rounded-md shadow-sm">
          <Plus size={16} color="#FF5A5F" />
        </TouchableOpacity>
      </View>

      {/* 4. Delete (Optional: If you prefer a trash icon) */}
      {/* <TouchableOpacity onPress={onRemove} className="ml-3">
        <Trash2 size={20} color="#EF4444" />
      </TouchableOpacity> */}
    </View>
  );
};