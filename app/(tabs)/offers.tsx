import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Image, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../../src/api/nooksBanners';
import { fetchNooksPromos } from '../../src/api/nooksPromos';
import { OfferCard } from '../../src/components/common/OfferCard';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';

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
  const { backgroundColor, menuCardColor, textColor } = useMerchantBranding();
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const [nooksPromos, setNooksPromos] = useState<Array<{ id: string; code: string; name: string; description?: string; valid_until?: string; image_url?: string | null }>>([]);

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
        image: p.image_url || offerBanners[0]?.image_url || PLACEHOLDER_PROMO_IMAGE,
      }));
    }
    return [];
  }, [nooksPromos, nooksBanners]);

  return (
    <View className="flex-1" style={{ backgroundColor }}>
      <StatusBar barStyle="dark-content" />
      <View
        className="pt-14 pb-4 px-5 flex-row items-center"
        style={{ backgroundColor, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}
      >
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color={textColor} />
        </TouchableOpacity>
        <Text className="text-xl font-bold" style={{ color: textColor }}>Offers</Text>
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
                <TouchableOpacity key={b.id} activeOpacity={1} className="mb-3 rounded-2xl overflow-hidden shadow-sm" style={{ backgroundColor: menuCardColor }}>
                  <Image source={{ uri: b.image_url }} className="w-full h-40 bg-slate-200" resizeMode="cover" />
                  {(b.title || b.subtitle) && (
                    <View className="p-3">
                      {b.subtitle ? <Text className="text-lg font-bold" style={{ color: textColor }}>{b.subtitle}</Text> : null}
                      {b.title ? <Text style={{ color: textColor }}>{b.title}</Text> : null}
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
