import { Plus } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Animated, Image, Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface Product {
  id: string;
  name: string;
  price: number;
  image: string;
  description: string;
  category: string;
}

interface ProductCardProps {
  product: Product;
  onAdd: () => void;
  index?: number; 
}

export const ProductCard = ({ product, onAdd, index = 0 }: ProductCardProps) => {
  const { primaryColor } = useMerchantBranding();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        delay: index * 100, 
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        friction: 6,
        tension: 40,
        delay: index * 100,
        useNativeDriver: true,
      })
    ]).start();
  }, []);

  return (
    <Animated.View 
      style={{ 
        opacity: fadeAnim, 
        transform: [{ translateY: slideAnim }] 
      }}
    >
      <View className="flex-row bg-white rounded-3xl p-3 mb-4 mx-4 shadow-sm border border-gray-100 items-center">
        <Image 
          source={{ uri: product.image }} 
          className="w-24 h-24 rounded-2xl bg-gray-200"
        />
        <View className="flex-1 ml-4 justify-center py-2">
          <Text className="text-lg font-bold text-gray-900 font-[Poppins-Bold]">{product.name}</Text>
          <Text className="text-gray-500 text-xs mt-1 font-[Poppins-Regular]" numberOfLines={2}>
            {product.description}
          </Text>
          <Text className="font-bold mt-2 text-base font-[Poppins-Bold]" style={{ color: primaryColor }}>
            {product.price} SAR
          </Text>
        </View>
        <TouchableOpacity
          onPress={onAdd}
          className="w-12 h-12 rounded-full justify-center items-center shadow-sm"
          style={{ backgroundColor: `${primaryColor}18` }}
        >
          <Plus size={24} color={primaryColor} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
};