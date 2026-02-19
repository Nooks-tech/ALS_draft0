import { Dimensions, FlatList, Image, View } from 'react-native';

const { width } = Dimensions.get('window');

// Dummy Promo Data
const PROMOS = [
  { id: '1', image: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800' }, // Food spread
  { id: '2', image: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800' }, // Coffee shop vibe
  { id: '3', image: 'https://images.unsplash.com/photo-1511920170033-f8396924c348?w=800' }, // Coffee cup
];

export const PromoSlider = () => {
  return (
    <View className="py-4">
      <FlatList
        data={PROMOS}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        snapToInterval={width * 0.8 + 16} // Snap effect
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: 16 }}
        renderItem={({ item }) => (
          <View 
            style={{ width: width * 0.8 }} 
            className="h-40 mr-4 rounded-2xl overflow-hidden shadow-sm bg-gray-200"
          >
            <Image 
              source={{ uri: item.image }} 
              className="w-full h-full"
              resizeMode="cover"
            />
          </View>
        )}
      />
    </View>
  );
};