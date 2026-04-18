import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Heart, Minus, Plus } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { useCart } from '../src/context/CartContext';
import { useFavorites } from '../src/context/FavoritesContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useMenuContext } from '../src/context/MenuContext';

export default function ProductScreen() {
  const { id, uniqueId } = useLocalSearchParams<{ id: string; uniqueId?: string }>();
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { addToCart, updateQuantity, cartItems } = useCart();
  const { isFavorite, toggleFavorite } = useFavorites();
  const isEditMode = !!uniqueId;
  const isArabic = i18n.language === 'ar';
  const rowDirection = isArabic ? 'row-reverse' : 'row';

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
        // No auto-selected modifiers on a fresh product — the customer picks
        // only what they want. Tapping an option selects it; tapping it again
        // deselects it. Prevents the old bug where modifiers were mandatory
        // and silently added to the price.
        setSelectedOptions({});
      }
    }
  }, [product?.id, product?.modifierGroups, isEditMode, cartItem?.uniqueId, cartItem?.customizations]);

  useEffect(() => {
    if (isEditMode && cartItem) {
      setQuantity(cartItem.quantity);
    } else {
      setQuantity(1);
    }
  }, [isEditMode, cartItem]);

  const currentPrice = useMemo(() => {
    if (!product) return 0;
    let total = product.price;
    Object.values(selectedOptions).forEach((opt: any) => { total += (opt.price || 0); });
    return total;
  }, [product, selectedOptions]);

  // No forced defaults anymore — an empty selection means "no modifiers".
  const initialOptions = useMemo<{[key: string]: any}>(() => ({}), []);

  if (!product) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-slate-500" style={{ textAlign: isArabic ? 'right' : 'left' }}>{isArabic ? 'المنتج غير موجود' : 'Product not found'}</Text>
        <TouchableOpacity onPress={() => router.back()} className="mt-4">
          <Text className="font-bold" style={{ color: primaryColor }}>{isArabic ? 'العودة' : 'Go back'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const toggleOption = (groupTitle: string, optionObj: any) => {
    setSelectedOptions(prev => {
      const current = prev[groupTitle];
      // Tapping the same option a second time clears it so optional modifiers
      // aren't stuck on once touched.
      if (current && current.name === optionObj.name) {
        const next = { ...prev };
        delete next[groupTitle];
        return next;
      }
      return { ...prev, [groupTitle]: optionObj };
    });
  };

  const handleSave = () => {
    // `price` is the display unit price (base + chosen modifier surcharges).
    // `basePrice` is the product-only price — it's what we relay to Foodics
    // as `unit_price`, with modifiers sent separately in `options[]`.
    // Keeping the two fields distinct is how we avoid Foodics double-counting
    // modifier surcharges.
    const optsToUse = selectedOptions;
    const itemPayload = {
      ...product,
      basePrice: product.price,
      price: currentPrice,
      customizations: optsToUse,
    };
    if (isEditMode && uniqueId && cartItem) {
      updateQuantity(uniqueId, -cartItem.quantity);
      addToCart(itemPayload, quantity);
    } else {
      addToCart(itemPayload, quantity);
    }
    router.back();
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="px-5 py-4 items-center justify-between border-b border-slate-100" style={{ flexDirection: rowDirection }}>
        <TouchableOpacity onPress={() => router.back()} className="bg-slate-100 p-2 rounded-full">
          <ArrowLeft size={22} color="#334155" style={{ transform: [{ scaleX: isArabic ? -1 : 1 }] }} />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-slate-800">{isArabic ? 'المنتج' : 'Product'}</Text>
        <TouchableOpacity onPress={() => product && toggleFavorite(product.id)} className="bg-slate-100 p-2 rounded-full">
          <Heart size={22} color={primaryColor} fill={product && isFavorite(product.id) ? primaryColor : 'transparent'} />
        </TouchableOpacity>
      </View>
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="p-6">
        <View className="mb-6 rounded-[30px] overflow-hidden h-64 bg-slate-100 shadow-sm">
          <Image source={{ uri: product.image }} className="w-full h-full" resizeMode="cover" />
        </View>
        <View className="justify-between items-start mb-4" style={{ flexDirection: rowDirection }}>
          <View className="w-[70%]">
            <Text className="text-2xl font-bold text-slate-900" style={{ textAlign: isArabic ? 'right' : 'left' }}>{product.name}</Text>
            <Text className="text-slate-400 text-sm mt-1" style={{ textAlign: isArabic ? 'right' : 'left' }}>{product.description}</Text>
          </View>
          <PriceWithSymbol amount={currentPrice} iconSize={20} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700', fontSize: 20 }} />
        </View>
        <View className="mb-8">
          {product.modifierGroups?.map((group: any) => (
            <View key={group.title} className="mb-8">
              <View className="mb-4" style={{ flexDirection: rowDirection, alignItems: 'center' }}>
                <Text className="text-lg font-bold text-slate-800" style={{ textAlign: isArabic ? 'right' : 'left' }}>{group.title}</Text>
                <Text
                  className="text-xs font-semibold text-slate-400 uppercase tracking-widest"
                  style={{ marginLeft: isArabic ? 0 : 8, marginRight: isArabic ? 8 : 0 }}
                >
                  {isArabic ? 'اختياري' : 'Optional'}
                </Text>
              </View>
              <View className="flex-row flex-wrap" style={{ flexDirection: rowDirection }}>
                {group.options.map((opt: any) => {
                  const selected = selectedOptions[group.title];
                  const isSelected = selected?.name === opt.name;
                  const hasExtraPrice = (opt.price ?? 0) > 0;
                  return (
                    <TouchableOpacity
                      key={opt.name}
                      onPress={() => toggleOption(group.title, opt)}
                      className={`mb-3 px-5 py-3 rounded-2xl border items-center ${isSelected ? '' : 'bg-slate-50 border-slate-100'}`}
                      style={[isSelected ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined, { flexDirection: rowDirection, marginRight: isArabic ? 0 : 12, marginLeft: isArabic ? 12 : 0 }]}
                    >
                      <Text className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-slate-600'}`}>{opt.name}</Text>
                      {hasExtraPrice && (
                        <PriceWithSymbol amount={opt.price} prefix="+" iconSize={12} iconColor={isSelected ? 'rgba(255,255,255,0.9)' : primaryColor} textStyle={{ fontSize: 12, fontWeight: '700', color: isSelected ? 'rgba(255,255,255,0.9)' : primaryColor }} className={isArabic ? 'mr-2' : 'ml-2'} />
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
        <View className="p-4 rounded-[28px] items-center shadow-2xl" style={{ backgroundColor: primaryColor, flexDirection: rowDirection }}>
          <TouchableOpacity onPress={handleSave} className="flex-1" style={{ marginRight: isArabic ? 0 : 12, marginLeft: isArabic ? 12 : 0 }} activeOpacity={0.8}>
            <Text className="text-white font-bold text-xl" numberOfLines={1}>{isEditMode ? (isArabic ? 'حفظ التغييرات' : 'Save changes') : (isArabic ? 'أضف إلى السلة' : 'Add to Cart')}</Text>
          </TouchableOpacity>
          <View className="items-center bg-white/20 rounded-lg py-1 px-1" style={{ flexDirection: rowDirection }}>
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
