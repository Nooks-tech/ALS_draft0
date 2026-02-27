import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Image, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../../src/api/nooksBanners';
import { fetchNooksPromos } from '../../src/api/nooksPromos';
import { OfferCard } from '../../src/components/common/OfferCard';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';

const DEFAULT_OFFERS = [
  { id: '1', title: '50% OFF Your First Order', description: 'Get half price on everything for your first order. Max discount 50 SAR.', code: 'WELCOME50', expiry: 'Valid until 30 Dec', image: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=600' },
  { id: '2', title: 'Free Croissant 🥐', description: 'Buy any large coffee and get a free butter croissant.', code: 'MORNING', expiry: 'Valid 6am - 11am', image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600' },
  { id: '3', title: 'Family Bundle Deal', description: '10 Coffees + 10 Cookies for only 199 SAR.', code: 'FAMILY', expiry: 'Weekends Only', image: 'https://images.unsplash.com/photo-1511920170033-f8396924c348?w=600' },
];

const PLACEHOLDER_PROMO_IMAGE = 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=600';

function formatExpiry(validUntil?: string): string {
  if (!validUntil) return 'Valid for limited time';
  try {
    const d = new Date(validUntil);
    return isNaN(d.getTime()) ? 'Valid for limited time' : `Valid until ${d.toLocaleDateString()}`;
  } catch {
    return 'Valid for limited time';
  }
}

export default function OffersScreen() {
  const router = useRouter();
  const { merchantId } = useMerchant();
  const { backgroundColor } = useMerchantBranding();
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const [nooksPromos, setNooksPromos] = useState<Array<{ id: string; code: string; name: string; description?: string; valid_until?: string }>>([]);

  useEffect(() => {
    if (!merchantId) return;
    fetchNooksBanners(merchantId).then(setNooksBanners);
    fetchNooksPromos(merchantId).then(setNooksPromos);
  }, [merchantId]);

  const offerList = useMemo(() => {
    const offerBanners = nooksBanners.filter((b) => b.placement === 'offers' || b.placement === 'slider' || !b.placement);
    if (nooksPromos.length > 0) {
      return nooksPromos.map((p) => ({
        id: p.id,
        title: p.name,
        description: p.description ?? `Use code ${p.code} at checkout`,
        code: p.code,
        expiry: formatExpiry(p.valid_until),
        image: offerBanners[0]?.image_url || PLACEHOLDER_PROMO_IMAGE,
      }));
    }
    return DEFAULT_OFFERS;
  }, [nooksPromos, nooksBanners]);

  return (
    <View className="flex-1" style={{ backgroundColor }}>
      <StatusBar barStyle="dark-content" />
      <View className="pt-14 pb-4 px-5 bg-white border-b border-slate-100 flex-row items-center">
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color="#334155" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-slate-800">Offers</Text>
      </View>
      <FlatList
        data={offerList}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          nooksBanners.length > 0 ? (
            <View className="mb-4">
              {nooksBanners
                .filter((b) => b.placement === 'offers' || b.placement === 'slider' || !b.placement)
                .map((b) => (
                <TouchableOpacity key={b.id} activeOpacity={1} className="mb-3 rounded-2xl overflow-hidden bg-white shadow-sm">
                  <Image source={{ uri: b.image_url }} className="w-full h-40 bg-slate-200" resizeMode="cover" />
                  {(b.title || b.subtitle) && (
                    <View className="p-3">
                      {b.subtitle ? <Text className="text-lg font-bold text-slate-800">{b.subtitle}</Text> : null}
                      {b.title ? <Text className="text-slate-600">{b.title}</Text> : null}
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => <OfferCard {...item} />}
        contentContainerStyle={{ padding: 16 }}
      />
    </View>
  );
}
