import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Heart, Minus, Plus } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCart } from '../src/context/CartContext';
import { useFavorites } from '../src/context/FavoritesContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useMenuContext } from '../src/context/MenuContext';

export default function ProductScreen() {
  const { id, uniqueId } = useLocalSearchParams<{ id: string; uniqueId?: string }>();
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { addToCart, updateQuantity, cartItems } = useCart();
  const { isFavorite, toggleFavorite } = useFavorites();
  const isEditMode = !!uniqueId;

  const { products } = useMenuContext();
  const product = useMemo(() => products.find((p) => p.id === id), [products, id]);
  const cartItem = useMemo(() => cartItems.find(i => i.uniqueId === uniqueId), [cartItems, uniqueId]);
  const [selectedOptions, setSelectedOptions] = useState<{[key: string]: any}>({});
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (product?.modifierGroups) {
      if (isEditMode && cartItem?.customizations && Object.keys(cartItem.customizations).length > 0) {
        setSelectedOptions(cartItem.customizations);
      } else {
        const initial: {[key: string]: any} = {};
        product.modifierGroups.forEach((group: any) => {
          if (group.options?.length > 0) {
            initial[group.title] = group.options[0];
          }
        });
        setSelectedOptions(initial);
      }
    }
  }, [product?.id, isEditMode, cartItem?.uniqueId]);

  useEffect(() => {
    if (isEditMode && cartItem) {
      setQuantity(cartItem.quantity);
    } else {
      setQuantity(1);
    }
  }, [isEditMode, cartItem?.quantity]);

  const currentPrice = useMemo(() => {
    if (!product) return 0;
    let total = product.price;
    Object.values(selectedOptions).forEach((opt: any) => { total += (opt.price || 0); });
    return total;
  }, [product, selectedOptions]);

  if (!product) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-slate-500">Product not found</Text>
        <TouchableOpacity onPress={() => router.back()} className="mt-4">
          <Text className="font-bold" style={{ color: primaryColor }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const initialOptions = useMemo(() => {
    const initial: {[key: string]: any} = {};
    product.modifierGroups?.forEach((group: any) => {
      if (group.options?.length > 0) {
        initial[group.title] = group.options[0];
      }
    });
    return initial;
  }, [product.id]);

  const toggleOption = (groupTitle: string, optionObj: any) => {
    setSelectedOptions(prev => ({ ...prev, [groupTitle]: optionObj }));
  };

  const handleSave = () => {
    const optsToUse = Object.keys(selectedOptions).length > 0 ? selectedOptions : initialOptions;
    if (isEditMode && uniqueId && cartItem) {
      updateQuantity(uniqueId, -cartItem.quantity);
      addToCart({ ...product, price: currentPrice, customizations: optsToUse }, quantity);
    } else {
      addToCart({ ...product, price: currentPrice, customizations: optsToUse }, quantity);
    }
    router.back();
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="px-5 py-4 flex-row items-center justify-between border-b border-slate-100">
        <TouchableOpacity onPress={() => router.back()} className="bg-slate-100 p-2 rounded-full">
          <ArrowLeft size={22} color="#334155" />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-slate-800">Product</Text>
        <TouchableOpacity onPress={() => product && toggleFavorite(product.id)} className="bg-slate-100 p-2 rounded-full">
          <Heart size={22} color={primaryColor} fill={product && isFavorite(product.id) ? primaryColor : 'transparent'} />
        </TouchableOpacity>
      </View>
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="p-6">
        <View className="mb-6 rounded-[30px] overflow-hidden h-64 bg-slate-100 shadow-sm">
          <Image source={{ uri: product.image }} className="w-full h-full" resizeMode="cover" />
        </View>
        <View className="flex-row justify-between items-start mb-4">
          <View className="w-[70%]">
            <Text className="text-2xl font-bold text-slate-900">{product.name}</Text>
            <Text className="text-slate-400 text-sm mt-1">{product.description}</Text>
          </View>
          <Text className="text-xl font-bold" style={{ color: primaryColor }}>{currentPrice} SAR</Text>
        </View>
        <View className="mb-8">
          {product.modifierGroups?.map((group: any) => (
            <View key={group.title} className="mb-8">
              <Text className="text-lg font-bold text-slate-800 mb-4">{group.title}</Text>
              <View className="flex-row flex-wrap">
                {group.options.map((opt: any) => {
                  const selected = selectedOptions[group.title] || initialOptions[group.title];
                  const isSelected = selected?.name === opt.name;
                  const hasExtraPrice = (opt.price ?? 0) > 0;
                  return (
                    <TouchableOpacity
                      key={opt.name}
                      onPress={() => toggleOption(group.title, opt)}
                      style={isSelected ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined}
                      className={`mr-3 mb-3 px-5 py-3 rounded-2xl border flex-row items-center ${isSelected ? '' : 'bg-slate-50 border-slate-100'}`}
                    >
                      <Text className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-slate-600'}`}>{opt.name}</Text>
                      {hasExtraPrice && (
                        <Text className={`text-xs font-bold ml-2 ${isSelected ? 'text-white/90' : ''}`} style={!isSelected ? { color: primaryColor } : undefined}>+{opt.price} SAR</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
        </View>
      </ScrollView>
      <View className="p-6 pt-4 pb-8 bg-white border-t border-slate-100">
        <View className="p-4 rounded-[28px] flex-row items-center shadow-2xl" style={{ backgroundColor: primaryColor }}>
          <TouchableOpacity onPress={handleSave} className="flex-1">
            <Text className="text-white font-bold text-xl" numberOfLines={1}>{isEditMode ? 'Save Changes' : 'Add to Basket'}</Text>
          </TouchableOpacity>
          <Text className="text-white font-bold text-base mr-3">{(currentPrice * quantity).toFixed(1)} SAR</Text>
          <View className="flex-row items-center bg-white/20 rounded-lg py-1 px-1">
            <TouchableOpacity
              onPress={() => setQuantity((q) => Math.max(1, q - 1))}
              className="p-1.5"
            >
              <Minus size={16} color="white" />
            </TouchableOpacity>
            <Text className="text-white font-bold text-sm min-w-[20px] text-center">{quantity}</Text>
            <TouchableOpacity
              onPress={() => setQuantity((q) => q + 1)}
              className="p-1.5"
            >
              <Plus size={16} color="white" />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
