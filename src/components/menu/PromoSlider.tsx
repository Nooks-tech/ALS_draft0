import { useEffect, useRef, useState } from 'react';
import { Dimensions, FlatList, Image, ImageBackground, Text, View } from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../../api/nooksBanners';
import { useMerchant } from '../../context/MerchantContext';

const { width } = Dimensions.get('window');
const ITEM_WIDTH = width * 0.8;
const SNAP_INTERVAL = ITEM_WIDTH + 16;

type SliderBanner = { id: string; image: string; title: string; subtitle: string };

interface PromoSliderProps {
  banners?: NooksBanner[];
}

export const PromoSlider = ({ banners: externalBanners }: PromoSliderProps) => {
  const { merchantId } = useMerchant();
  const [banners, setBanners] = useState<SliderBanner[]>([]);
  const listRef = useRef<FlatList>(null);
  const indexRef = useRef(0);

  useEffect(() => {
    if (externalBanners && externalBanners.length > 0) {
      setBanners(
        externalBanners
          .filter((b) => b.placement === 'slider' || !b.placement)
          .map((b) => ({ id: b.id, image: b.image_url, title: b.title ?? '', subtitle: b.subtitle ?? '' }))
      );
      return;
    }
    if (!merchantId) return;
    fetchNooksBanners(merchantId).then((data) => {
      const slider = data.filter((b) => b.placement === 'slider' || !b.placement);
      setBanners(slider.map((b) => ({ id: b.id, image: b.image_url, title: b.title ?? '', subtitle: b.subtitle ?? '' })));
    });
  }, [merchantId, externalBanners]);

  useEffect(() => {
    if (banners.length <= 1) return;
    const interval = setInterval(() => {
      const next = (indexRef.current + 1) % banners.length;
      indexRef.current = next;
      listRef.current?.scrollToOffset({ offset: next * SNAP_INTERVAL, animated: true });
    }, 4000);
    return () => clearInterval(interval);
  }, [banners.length]);

  if (banners.length === 0) return null;

  return (
    <View className="py-4">
      <FlatList
        ref={listRef}
        data={banners}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        snapToInterval={SNAP_INTERVAL}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: 16 }}
        onMomentumScrollEnd={(e) => { indexRef.current = Math.round(e.nativeEvent.contentOffset.x / SNAP_INTERVAL); }}
        renderItem={({ item }) => (
          <View style={{ width: ITEM_WIDTH }} className="h-40 mr-4 rounded-2xl overflow-hidden shadow-sm bg-gray-200">
            <ImageBackground source={{ uri: item.image }} className="w-full h-full justify-end p-4" resizeMode="cover">
              {(item.title || item.subtitle) && (
                <>
                  <View className="absolute inset-0 bg-black/30" />
                  {item.subtitle ? <Text className="text-white font-bold text-xl z-10">{item.subtitle}</Text> : null}
                  {item.title ? <Text className="text-gray-200 text-sm z-10">{item.title}</Text> : null}
                </>
              )}
            </ImageBackground>
          </View>
        )}
      />
    </View>
  );
};