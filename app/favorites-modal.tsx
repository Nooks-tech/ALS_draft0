import { useRouter } from 'expo-router';
import { Heart, X } from 'lucide-react-native';
import { useMemo } from 'react';
import { Dimensions, Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFavorites } from '../src/context/FavoritesContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useMenuContext } from '../src/context/MenuContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

export default function FavoritesModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { products } = useMenuContext();
  const { favoriteIds, toggleFavorite } = useFavorites();
  const favorites = useMemo(() => products.filter((p) => favoriteIds.has(p.id)), [products, favoriteIds]);
  const modalHeight = Dimensions.get('window').height * 0.85;

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <SwipeableBottomSheet
        onDismiss={() => router.back()}
        height={modalHeight}
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'white', borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden', maxHeight: '85%' }}
      >
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Favorites</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {favorites.length === 0 ? (
            <View className="items-center py-12">
              <View className="w-20 h-20 rounded-full bg-slate-100 justify-center items-center mb-4">
                <Heart size={40} color="#94a3b8" />
              </View>
              <Text className="text-slate-500 text-center">No favorites yet. Tap the heart on menu items to add them here!</Text>
            </View>
          ) : (
            favorites.map((item) => (
              <View key={item.id} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl">
                <TouchableOpacity
                  onPress={() => router.push({ pathname: '/product', params: { id: item.id } })}
                  className="flex-row items-center flex-1"
                  activeOpacity={0.8}
                >
                  <Image source={{ uri: item.image }} className="w-16 h-16 rounded-xl" />
                  <View className="flex-1 ml-4">
                    <Text className="font-bold text-slate-800">{item.name}</Text>
                    <Text className="font-bold" style={{ color: primaryColor }}>{item.price} SAR</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => toggleFavorite(item.id)}
                  className="p-2 -mr-2"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Heart size={22} color={primaryColor} fill={primaryColor} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      </SwipeableBottomSheet>
    </View>
  );
}
