import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  Bike,
  ChevronDown,
  Plus,
  Search,
  Store
} from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../../src/api/nooksBanners';
import { StoreStatusBanner } from '../../src/components/common/StoreStatusBanner';
import { useCart } from '../../src/context/CartContext';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useMenuContext } from '../../src/context/MenuContext';
import { useOperations } from '../../src/context/OperationsContext';

type SliderItem = { id: string; image: string; title: string; subtitle: string };

export default function MenuScreen() {
  const { totalItems, totalPrice, orderType, selectedBranch, deliveryAddress } = useCart();
  const { merchantId } = useMerchant();
  const { products, categories, loading } = useMenuContext();
  const { primaryColor, logoUrl, backgroundColor, menuCardColor, textColor } = useMerchantBranding();
  const { isClosed, isBusy, isPickupOnly } = useOperations();
  const router = useRouter();
  const headerBg = primaryColor;
  const accent = primaryColor;

  const [selectedCategory, setSelectedCategory] = useState('');
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [promoPopupVisible, setPromoPopupVisible] = useState(false);
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const shownPopupVersionRef = useRef<string | null>(null);

  const displayCategories = useMemo(() => categories.filter((c) => c !== 'All'), [categories]);
  const sections = useMemo(() =>
    displayCategories
      .map((cat) => ({ title: cat, data: products.filter((p) => p.category === cat) }))
      .filter((s) => s.data.length > 0),
  [products, displayCategories]);

  const menuScrollRef = useRef<ScrollView>(null);
  const categoryScrollRef = useRef<ScrollView>(null);
  const sectionYRef = useRef<Record<string, number>>({});
  const CATEGORY_PILL_WIDTH = 100;

  useEffect(() => {
    if (sections.length > 0 && !selectedCategory) setSelectedCategory(sections[0].title);
  }, [sections, selectedCategory]);

  // Banners from nooksweb: GET …/merchants/{merchantId}/banners (slider + popup)
  useEffect(() => {
    if (!merchantId) return;
    fetchNooksBanners(merchantId).then(setNooksBanners);
  }, [merchantId]);

  const sliderItems: SliderItem[] = useMemo(() => {
    const sliderBanners = nooksBanners.filter((b) => b.placement === 'slider');
    if (sliderBanners.length > 0) {
      return sliderBanners.map((b) => ({
        id: b.id,
        image: b.image_url,
        title: b.title ?? '',
        subtitle: b.subtitle ?? '',
      }));
    }
    return [];
  }, [nooksBanners]);

  const popupBanner = useMemo(() => {
    const popupCandidates = nooksBanners.filter((b) => b.placement === 'popup');
    const popup = popupCandidates.length > 0 ? popupCandidates[popupCandidates.length - 1] : null;
    if (popup) return { id: popup.id, image: popup.image_url, title: popup.title ?? '', subtitle: popup.subtitle ?? '' };
    return null;
  }, [nooksBanners]);

  // Popup: show once per uploaded popup version per device.
  useEffect(() => {
    if (!popupBanner || !merchantId) return;
    const popupVersion = `${popupBanner.id}:${popupBanner.image}`;
    if (shownPopupVersionRef.current === popupVersion) return;
    const key = `popup_last_version_${merchantId}`;
    AsyncStorage.getItem(key).then((lastVersion) => {
      if (lastVersion !== popupVersion) {
        setPromoPopupVisible(true);
      }
    });
  }, [popupBanner, merchantId]);
  const closePromoPopup = useCallback(() => {
    setPromoPopupVisible(false);
    if (popupBanner) {
      shownPopupVersionRef.current = `${popupBanner.id}:${popupBanner.image}`;
    }
    if (merchantId && popupBanner) {
      AsyncStorage.setItem(`popup_last_version_${merchantId}`, `${popupBanner.id}:${popupBanner.image}`);
    }
  }, [merchantId, popupBanner]);

  const screenWidth = Dimensions.get('window').width;
  const searchTranslateX = useSharedValue(0);

  const searchAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: searchTranslateX.value }],
  }));

  const closeSearch = useCallback(() => setIsSearchVisible(false), []);

  useEffect(() => {
    if (isSearchVisible) searchTranslateX.value = 0;
  }, [isSearchVisible]);

  useEffect(() => {
    if (!selectedCategory) return;
    const idx = displayCategories.indexOf(selectedCategory);
    if (idx >= 0 && categoryScrollRef.current) {
      const x = Math.max(0, idx * (CATEGORY_PILL_WIDTH + 12) - screenWidth / 2 + CATEGORY_PILL_WIDTH / 2);
      categoryScrollRef.current.scrollTo({ x, animated: true });
    }
  }, [selectedCategory, displayCategories, screenWidth]);

  // Match actual layout: promo (py-4 + h-40), section header (py-4 + text), product card (p-3 + h-24 + mb-4)
  const LIST_HEADER_HEIGHT = sliderItems.length > 0 ? 192 : 0;   // 32 + 160
  const SECTION_HEADER_HEIGHT = 56; // py-4 + text-xl
  const PRODUCT_ROW_HEIGHT = 136;   // card height + mb-4

  const sectionBoundaries = useMemo(() => {
    let offset = LIST_HEADER_HEIGHT;
    const bounds: { title: string; start: number; end: number }[] = [];
    for (const s of sections) {
      bounds.push({ title: s.title, start: offset, end: offset + SECTION_HEADER_HEIGHT + s.data.length * PRODUCT_ROW_HEIGHT });
      offset = bounds[bounds.length - 1].end;
    }
    return { bounds, estimatedTotal: offset };
  }, [sections, LIST_HEADER_HEIGHT]);

  const onScrollMenu = useCallback(
    (e: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      contentHeightRef.current = contentSize.height;
      const scrollY = contentOffset.y;
      const viewportHeight = layoutMeasurement.height;
      const viewportTop = scrollY;
      const viewportBottom = scrollY + viewportHeight;

      const scale = contentSize.height > 0 && sectionBoundaries.estimatedTotal > 0
        ? contentSize.height / sectionBoundaries.estimatedTotal
        : 1;

      const bounds = sectionBoundaries.bounds;

      let bestSection = bounds[0];
      let bestOverlap = 0;

      for (const s of bounds) {
        const start = s.start * scale;
        const end = s.end * scale;
        const overlap = Math.max(0, Math.min(end, viewportBottom) - Math.max(start, viewportTop));
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSection = s;
        }
      }

      if (bestOverlap === 0 && bounds.length > 0) {
        const viewportCenter = scrollY + viewportHeight / 2;
        const lastEnd = bounds[bounds.length - 1].end * scale;
        const firstStart = bounds[0].start * scale;
        if (viewportCenter >= lastEnd) {
          bestSection = bounds[bounds.length - 1];
        } else if (viewportCenter < firstStart) {
          bestSection = bounds[0];
        }
      }

      if (bestSection?.title) setSelectedCategory(bestSection.title);
    },
    [sectionBoundaries],
  );

  const scrollEventThrottle = 50;

  const contentHeightRef = useRef<number>(0);
  const onContentSizeChange = useCallback((_w: number, h: number) => {
    contentHeightRef.current = h;
  }, []);

  const scrollToCategory = useCallback((cat: string) => {
    setSelectedCategory(cat);
    let y = sectionYRef.current[cat];
    if (typeof y !== 'number') {
      const idx = sections.findIndex((s) => s.title === cat);
      if (idx >= 0 && sectionBoundaries.bounds[idx]) y = sectionBoundaries.bounds[idx].start;
    }
    if (typeof y === 'number' && menuScrollRef.current) {
      menuScrollRef.current.scrollTo({ y, animated: true });
    }
  }, [sections, sectionBoundaries]);

  const openProduct = useCallback((item: (typeof products)[0]) => {
    router.push({ pathname: '/product', params: { id: item.id } });
  }, [router]);

  const openOrderType = useCallback(() => {
    router.push('/order-type');
  }, [router]);

  const captureSectionY = useCallback((title: string) => (e: { nativeEvent: { layout: { y: number } } }) => {
    sectionYRef.current[title] = e.nativeEvent.layout.y;
  }, []);

  const promoWidth = screenWidth - 32;
  const promoItemWidth = promoWidth + 16;
  const promoRef = useRef<FlatList>(null);
  const promoIndexRef = useRef(0);

  useEffect(() => {
    if (sliderItems.length === 0) return;
    const interval = setInterval(() => {
      const next = (promoIndexRef.current + 1) % sliderItems.length;
      promoIndexRef.current = next;
      promoRef.current?.scrollToOffset({ offset: next * promoItemWidth, animated: true });
    }, 4000);
    return () => clearInterval(interval);
  }, [promoItemWidth, sliderItems.length]);

  const listHeaderComponent = useMemo(() => {
    if (sliderItems.length === 0) return null;
    return (
      <View style={{ backgroundColor }}>
        <View className="py-4">
          <FlatList
            ref={promoRef}
            data={sliderItems}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            snapToInterval={promoItemWidth}
            snapToAlignment="start"
            decelerationRate="fast"
            contentContainerStyle={{ paddingHorizontal: 16 }}
            onMomentumScrollEnd={(e) => { promoIndexRef.current = Math.round(e.nativeEvent.contentOffset.x / promoItemWidth); }}
            renderItem={({ item: promo }) => (
              <TouchableOpacity
                onPress={() => router.replace('/(tabs)/offers')}
                activeOpacity={1}
                style={{ width: promoWidth, marginRight: 16 }}
                className="rounded-2xl overflow-hidden shadow-md bg-white"
              >
                <ImageBackground
                  source={{ uri: promo.image }}
                  className="h-40 justify-end p-4"
                  imageStyle={{ borderRadius: 16 }}
                >
                  <View className="absolute inset-0 bg-black/40 rounded-2xl" />
                  <Text className="text-white font-bold text-2xl z-10">{promo.subtitle}</Text>
                  <Text className="text-gray-200 text-sm z-10">{promo.title}</Text>
                </ImageBackground>
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    );
  }, [promoWidth, promoItemWidth, sliderItems, backgroundColor, router]);

  const categoryBar = useMemo(() => (
    <View className="px-5 pb-3 pt-1" style={{ backgroundColor }}>
      <ScrollView ref={categoryScrollRef} horizontal showsHorizontalScrollIndicator={false}>
        {displayCategories.map((cat) => (
          <TouchableOpacity
            key={cat}
            onPress={() => scrollToCategory(cat)}
            style={selectedCategory === cat ? { backgroundColor: accent, borderColor: accent } : undefined}
            className={`mr-3 px-6 py-2.5 rounded-full border ${selectedCategory === cat ? '' : 'bg-white border-slate-200'}`}
          >
            <Text className={`font-bold ${selectedCategory === cat ? 'text-white' : 'text-slate-500'}`}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  ), [selectedCategory, displayCategories, scrollToCategory, backgroundColor, accent]);

  return (
    <View className="flex-1 relative" style={{ backgroundColor }}> 
      <StatusBar barStyle="light-content" />
      
      {/* HEADER (L→R): Pickup/branch | Search icon | Merchant logo (right-most) */}
      <View className="pt-14 pb-6 px-5 shadow-md flex-row justify-between items-center rounded-b-[40px]" style={{ backgroundColor: headerBg }}>
        <TouchableOpacity onPress={openOrderType} className="flex-row items-center flex-1 min-w-0 mr-2" accessibilityLabel={orderType === 'delivery' ? 'Delivering to' : 'Pickup from'} accessibilityRole="button">
          <View className="bg-white/20 p-2.5 rounded-2xl mr-3 border border-white/30 shadow-sm shrink-0">
            {orderType === 'delivery' ? <Bike size={20} color="white" /> : <Store size={20} color="white" />}
          </View>
          <View className="flex-1 min-w-0">
            <View className="flex-row items-center">
              <Text className="text-white/80 text-[10px] font-bold uppercase tracking-widest mr-1">
                {orderType === 'delivery' ? 'Delivering To' : 'Pickup From'}
              </Text>
              <ChevronDown size={12} color="white" />
            </View>
            <Text className="text-white font-bold text-lg" numberOfLines={1} ellipsizeMode="tail">
              {orderType === 'delivery' ? (deliveryAddress?.address || 'Add address') : selectedBranch?.name || 'Select branch'}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setIsSearchVisible(true)} className="bg-white/20 p-3 rounded-2xl border border-white/30 shadow-sm shrink-0 mr-2" accessibilityLabel="Search menu" accessibilityRole="button">
          <Search size={22} color="white" />
        </TouchableOpacity>
        <View className="ml-1" style={{ width: 40, height: 40 }} accessibilityLabel="Merchant logo" accessibilityRole="image">
          {logoUrl ? (
            <Image source={{ uri: logoUrl }} style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }} resizeMode="contain" />
          ) : (
            <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }} />
          )}
        </View>
      </View>

      {/* STICKY CATEGORY BAR */}
      {categoryBar}

      {/* STORE STATUS BANNER */}
      <StoreStatusBanner />

      {/* MAIN LIST */}
      {loading && sections.length === 0 ? (
        <View className="px-5 py-4 flex-1" style={{ backgroundColor }}><Text style={{ color: textColor }}>Loading menu...</Text></View>
      ) : (
      <ScrollView
        ref={menuScrollRef}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 150 }}
        onScroll={onScrollMenu}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={scrollEventThrottle}
      >
        <View>
          {listHeaderComponent}
          {sections.flatMap((section) => [
            <View
              key={`header-${section.title}`}
              onLayout={captureSectionY(section.title)}
              collapsable={false}
              className="px-5 py-4"
              style={{ backgroundColor }}
            >
              <Text className="text-xl font-bold" style={{ color: textColor }}>{section.title}</Text>
            </View>,
            ...section.data.map((product) => (
              <TouchableOpacity
                key={product.id}
                onPress={() => openProduct(product)}
                activeOpacity={0.8}
                className="mx-5 mb-4 rounded-[24px] shadow-sm p-3 flex-row border border-slate-100"
                style={{ backgroundColor: menuCardColor }}
              >
                <Image source={{ uri: product.image }} className="w-24 h-24 rounded-[20px] bg-slate-200" />
                <View className="flex-1 ml-4 justify-between py-1">
                  <View>
                    <Text className="text-lg font-bold" style={{ color: textColor }}>{product.name}</Text>
                    <Text className="text-xs mt-1" style={{ color: textColor }} numberOfLines={1}>{product.description}</Text>
                  </View>
                  <View className="flex-row justify-between items-center mt-2">
                    <Text className="font-bold text-lg" style={{ color: accent }}>{product.price} SAR</Text>
                    <View className="p-1.5 rounded-lg" style={{ backgroundColor: accent }}><Plus size={18} color="white" /></View>
                  </View>
                </View>
              </TouchableOpacity>
            )),
          ])}
        </View>
      </ScrollView>
      )}

      {/* SEARCH OVERLAY - stays on menu, product opens as modal on top */}
      {isSearchVisible && (
        <GestureDetector
          gesture={Gesture.Pan()
            .activeOffsetX(10)
            .failOffsetX(-20)
            .onUpdate((e) => {
              if (e.translationX > 0) searchTranslateX.value = e.translationX;
            })
            .onEnd((e) => {
              if (e.translationX > 80 || e.velocityX > 300) {
                searchTranslateX.value = withTiming(screenWidth, { duration: 200 }, (finished) => {
                  if (finished) runOnJS(closeSearch)();
                });
              } else {
                searchTranslateX.value = withSpring(0, { damping: 20, stiffness: 300 });
              }
            })}
        >
          <Animated.View style={[{ flex: 1, position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 110, backgroundColor }, searchAnimatedStyle]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
          >
          <View className="p-5 pt-14">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity onPress={() => setIsSearchVisible(false)} className="mr-4"><ArrowLeft size={24} color={textColor} /></TouchableOpacity>
            <View className="flex-1 bg-slate-100 rounded-2xl flex-row items-center px-4 h-12">
              <Search size={20} color="#94a3b8" />
              <TextInput placeholder="What are you craving?" className="flex-1 ml-2 font-medium" style={{ color: textColor }} value={searchQuery} onChangeText={setSearchQuery} />
            </View>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {products.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase())).map((item) => (
              <TouchableOpacity key={item.id} onPress={() => openProduct(item)} 
                className="mb-4 p-3 rounded-2xl flex-row items-center border border-slate-100"
                style={{ backgroundColor: menuCardColor }}
              >
                <Image source={{ uri: item.image }} className="w-16 h-16 rounded-xl bg-slate-200" />
                <View className="ml-4 flex-1"><Text className="text-lg font-bold" style={{ color: textColor }}>{item.name}</Text><Text className="font-bold" style={{ color: accent }}>{item.price} SAR</Text></View>
                <Plus size={16} color={accent} />
              </TouchableOpacity>
            ))}
          </ScrollView>
          </View>
        </KeyboardAvoidingView>
        </Animated.View>
        </GestureDetector>
      )}

      {/* Promo popup: once per uploaded popup banner version */}
      {popupBanner && (
        <Modal visible={promoPopupVisible} transparent animationType="fade">
          <TouchableOpacity activeOpacity={1} onPress={closePromoPopup} className="flex-1 bg-black/60 justify-center items-center px-6">
            <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl overflow-hidden bg-white shadow-2xl">
              <ImageBackground source={{ uri: popupBanner.image }} className="aspect-[4/3] justify-end p-4" imageStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
                <View className="absolute inset-0 bg-black/50 rounded-t-2xl" />
                <Text className="text-white font-bold text-2xl z-10">{popupBanner.subtitle}</Text>
                <Text className="text-gray-200 z-10">{popupBanner.title}</Text>
              </ImageBackground>
              <TouchableOpacity onPress={closePromoPopup} className="py-4 items-center border-t border-slate-100" style={{ backgroundColor: accent }}>
                <Text className="text-white font-bold">Close</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}

      {/* FLOATING CART – always visible when items exist; blocked on closed/busy with message */}
      {!!totalItems && (
        <View className="absolute bottom-10 left-5 right-5 z-[120]">
          <TouchableOpacity
            onPress={() => {
              if (isClosed || isBusy) {
                Alert.alert(
                  'Ordering Unavailable',
                  isClosed
                    ? 'Store is currently closed.'
                    : 'Store is currently busy and not accepting new orders.'
                );
                return;
              }
              router.push('/cart');
            }}
            className="p-5 rounded-[28px] flex-row justify-between items-center shadow-2xl"
            style={{ backgroundColor: (isClosed || isBusy) ? '#94a3b8' : accent }}
          >
              <View className="flex-row items-center">
                <View className="bg-white/20 px-3 py-1.5 rounded-xl mr-3"><Text className="text-white font-bold">{totalItems}</Text></View>
                <Text className="text-white font-bold text-lg">Checkout Now</Text>
              </View>
              <Text className="text-white font-bold text-lg">{totalPrice} SAR</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
