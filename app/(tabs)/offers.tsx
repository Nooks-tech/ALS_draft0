import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { FlatList, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import { OfferCard } from '../../src/components/common/OfferCard';

const OFFERS = [
  { id: '1', title: '50% OFF Your First Order', description: 'Get half price on everything for your first order. Max discount 50 SAR.', code: 'WELCOME50', expiry: 'Valid until 30 Dec', image: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=600' },
  { id: '2', title: 'Free Croissant 🥐', description: 'Buy any large coffee and get a free butter croissant.', code: 'MORNING', expiry: 'Valid 6am - 11am', image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600' },
  { id: '3', title: 'Family Bundle Deal', description: '10 Coffees + 10 Cookies for only 199 SAR.', code: 'FAMILY', expiry: 'Weekends Only', image: 'https://images.unsplash.com/photo-1511920170033-f8396924c348?w=600' },
];

export default function OffersScreen() {
  const router = useRouter();

  return (
    <View className="flex-1 bg-slate-50">
      <StatusBar barStyle="dark-content" />
      <View className="pt-14 pb-4 px-5 bg-white border-b border-slate-100 flex-row items-center">
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color="#334155" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-slate-800">Offers</Text>
      </View>
      <FlatList
        data={OFFERS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <OfferCard {...item} />}
        contentContainerStyle={{ padding: 16 }}
      />
    </View>
  );
}
