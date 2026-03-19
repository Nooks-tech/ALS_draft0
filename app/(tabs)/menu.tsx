import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  Bike,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Store
} from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { PriceWithSymbol } from '../../src/components/common/PriceWithSymbol';
import { StoreStatusBanner } from '../../src/components/common/StoreStatusBanner';
import { useCart } from '../../src/context/CartContext';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useMenuContext } from '../../src/context/MenuContext';
import { useOperations } from '../../src/context/OperationsContext';

type SliderItem = { id: string; image: string; title: string; subtitle: string };

export default function MenuScreen() {
  const { i18n } = useTranslation();
  const { totalItems, totalPrice, orderType, selectedBranch, deliveryAddress } = useCart();
  const { merchantId } = useMerchant();
  const { products, categories, loading } = useMenuContext();
  const { primaryColor, logoUrl, backgroundColor, menuCardColor, textColor, tabTextColor } = useMerchantBranding();
  const { isClosed, isBusy, isPickupOnly } = useOperations();
  const router = useRouter();
  const headerBg = primaryColor;
  const accent = primaryColor;
  const isArabic = i18n.language === 'ar';

  const [selectedCategory, setSelectedCategory] = useState('');
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [promoPopupVisible, setPromoPopupVisible] = useState(false);
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const [activePopup, setActivePopup] = useState<SliderItem | null>(null);
  const popupSessionConsumedRef = useRef(false);

  const displayCategories = useMemo(() => categories.filter((c) => c !== 'All'), [categories]);
  const sections = useMemo(() =>
    displayCategories
      .map((cat) => ({ title: cat, data: products.filter((p) => p.category === cat) }))
      .filter((s) => s.data.length > 0),
  [products, displayCategories]);

  const menuScrollRef = useRef<ScrollView>(null);
  const categoryScrollRef = useRef<ScrollView>(null);
  const categoryScrollXRef = useRef(0);
  const sectionYRef = useRef<Record<string, number>>({});
  const categoryLayoutRef = useRef<Record<string, { x: number; width: number }>>({});
  const pendingCategoryScrollRef = useRef<{ title: string; targetY: number } | null>(null);

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

  const popupItems = useMemo(
    () =>
      nooksBanners
        .filter((b) => b.placement === 'popup')
        .map((b) => ({
          id: b.id,
          image: b.image_url,
          title: b.title ?? '',
          subtitle: b.subtitle ?? '',
        })),
    [nooksBanners]
  );

  // Popup queue behavior:
  // - show at most one popup per app session
  // - when multiple popup banners exist, show first unseen in upload order
  // - after user closes app and opens a new session, show next unseen popup
  useEffect(() => {
    if (!merchantId || popupItems.length === 0 || popupSessionConsumedRef.current) return;
    let cancelled = false;
    const seenKey = `popup_seen_ids_${merchantId}`;
    AsyncStorage.getItem(seenKey).then((raw) => {
      if (cancelled) return;
      let seenIds: string[] = [];
      try {
        seenIds = raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        seenIds = [];
      }
      const nextPopup = popupItems.find((p) => !seenIds.includes(p.id));
      if (nextPopup) {
        setActivePopup(nextPopup);
        setPromoPopupVisible(true);
        popupSessionConsumedRef.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [popupItems, merchantId]);

  const closePromoPopup = useCallback(() => {
    setPromoPopupVisible(false);
    if (merchantId && activePopup) {
      const seenKey = `popup_seen_ids_${merchantId}`;
      AsyncStorage.getItem(seenKey).then((raw) => {
        let seenIds: string[] = [];
        try {
          seenIds = raw ? (JSON.parse(raw) as string[]) : [];
        } catch {
          seenIds = [];
        }
        if (!seenIds.includes(activePopup.id)) {
          seenIds.push(activePopup.id);
          AsyncStorage.setItem(seenKey, JSON.stringify(seenIds));
        }
      });
    }
    setActivePopup(null);
  }, [merchantId, activePopup]);

  const screenWidth = Dimensions.get('window').width;
  const searchTranslateX = useSharedValue(0);

  const searchAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: searchTranslateX.value }],
  }));

  const closeSearch = useCallback(() => setIsSearchVisible(false), []);

  useEffect(() => {
    if (isSearchVisible) searchTranslateX.value = 0;
  }, [isSearchVisible]);

  const centerCategoryTab = useCallback((category: string, animated = true, force = false) => {
    const layout = categoryLayoutRef.current[category];
    if (!layout || !categoryScrollRef.current) return;

    const visibleStart = categoryScrollXRef.current;
    const visibleEnd = visibleStart + screenWidth - 40;
    const tabStart = layout.x;
    const tabEnd = layout.x + layout.width;

    if (!force && tabStart >= visibleStart + 12 && tabEnd <= visibleEnd - 12) {
      return;
    }

    const x = Math.max(0, layout.x + layout.width / 2 - screenWidth / 2);
    categoryScrollRef.current.scrollTo({ x, animated });
  }, [screenWidth]);

  useEffect(() => {
    if (!selectedCategory) return;
    centerCategoryTab(selectedCategory);
  }, [selectedCategory, centerCategoryTab]);

  const onScrollMenu = useCallback(
    (e: {
      nativeEvent: {
        contentOffset: { y: number };
      };
    }) => {
      const scrollY = e.nativeEvent.contentOffset.y;
      const pendingScroll = pendingCategoryScrollRef.current;
      if (pendingScroll) {
        if (Math.abs(scrollY - pendingScroll.targetY) <= 24) {
          pendingCategoryScrollRef.current = null;
        } else {
          return;
        }
      }

      const measuredSections = sections
        .map((section) => ({
          title: section.title,
          y: sectionYRef.current[section.title],
        }))
        .filter((section): section is { title: string; y: number } => typeof section.y === 'number');

      if (measuredSections.length === 0) return;

      const activationY = scrollY + 80;
      let activeTitle = measuredSections[0].title;

      for (const section of measuredSections) {
        if (section.y <= activationY) {
          activeTitle = section.title;
        } else {
          break;
        }
      }

      if (activeTitle !== selectedCategory) {
        setSelectedCategory(activeTitle);
      }
    },
    [sections, selectedCategory],
  );

  const scrollEventThrottle = 50;

  const scrollToCategory = useCallback((cat: string) => {
    setSelectedCategory(cat);
    centerCategoryTab(cat, true, true);

    const y = sectionYRef.current[cat];
    if (typeof y === 'number' && menuScrollRef.current) {
      pendingCategoryScrollRef.current = { title: cat, targetY: y };
      menuScrollRef.current.scrollTo({ y, animated: true });
    }
  }, [centerCategoryTab]);

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
      <ScrollView
        ref={categoryScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={(e) => {
          categoryScrollXRef.current = e.nativeEvent.contentOffset.x;
        }}
        scrollEventThrottle={16}
      >
        {displayCategories.map((cat) => (
          <TouchableOpacity
            key={cat}
            onPress={() => scrollToCategory(cat)}
            onLayout={(e) => {
              categoryLayoutRef.current[cat] = {
                x: e.nativeEvent.layout.x,
                width: e.nativeEvent.layout.width,
              };
            }}
            style={
              selectedCategory === cat
                ? { backgroundColor: headerBg, borderColor: headerBg }
                : { backgroundColor: menuCardColor, borderColor: menuCardColor }
            }
            className="mr-3 px-6 py-2.5 rounded-full border"
          >
            <Text className="font-bold" style={{ color: textColor }}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  ), [selectedCategory, displayCategories, scrollToCategory, backgroundColor, headerBg, textColor, menuCardColor]);

  return (
    <View className="flex-1 relative" style={{ backgroundColor }}> 
      <StatusBar barStyle="light-content" />

      {/* HEADER (L→R): Pickup/branch | Search icon | Merchant logo (right-most) */}
      <View className="pt-14 pb-6 px-5 shadow-md flex-row justify-between items-center rounded-b-[40px]" style={{ backgroundColor: headerBg }}>
        <TouchableOpacity onPress={openOrderType} className="flex-row items-center flex-1 min-w-0 mr-2" accessibilityLabel={orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivering to') : (isArabic ? 'الاستلام من' : 'Picking up from')} accessibilityRole="button">
          <View className="bg-white/20 p-2.5 rounded-2xl mr-3 border border-white/30 shadow-sm shrink-0">
            {orderType === 'delivery' ? <Bike size={20} color={tabTextColor} /> : <Store size={20} color={tabTextColor} />}
          </View>
          <View className="flex-1 min-w-0">
            <View className="flex-row items-center">
              <Text className="text-[10px] font-bold uppercase tracking-widest mr-1" style={{ color: tabTextColor }}>
                {orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivering to') : (isArabic ? 'الاستلام من' : 'Picking up from')}
              </Text>
              <ChevronDown size={12} color={tabTextColor} />
            </View>
            <Text className="font-bold text-lg" style={{ color: tabTextColor }} numberOfLines={1} ellipsizeMode="tail">
              {orderType === 'delivery'
                ? (deliveryAddress?.address || (isArabic ? 'أضف عنواناً' : 'Add address'))
                : (selectedBranch?.name || (isArabic ? 'اختر الفرع' : 'Select branch'))}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setIsSearchVisible(true)} className="bg-white/20 p-3 rounded-2xl border border-white/30 shadow-sm shrink-0 mr-2" accessibilityLabel={isArabic ? 'ابحث في المنيو' : 'Search menu'} accessibilityRole="button">
          <Search size={22} color={tabTextColor} />
        </TouchableOpacity>
        <View className="ml-1" style={{ width: 54, height: 54 }} accessibilityLabel={isArabic ? 'شعار المتجر' : 'Merchant logo'} accessibilityRole="image">
          {logoUrl ? (
            <Image source={{ uri: logoUrl }} style={{ width: 54, height: 54 }} resizeMode="contain" />
          ) : (
            <View style={{ width: 54, height: 54 }} />
          )}
        </View>
      </View>

      {/* STICKY CATEGORY BAR */}
      {categoryBar}

      {/* STORE STATUS BANNER */}
      <StoreStatusBanner />

      {/* MAIN LIST */}
      {loading && sections.length === 0 ? (
        <View className="px-5 py-4 flex-1" style={{ backgroundColor }}><Text style={{ color: textColor }}>{isArabic ? 'جار تحميل المنيو...' : 'Loading menu...'}</Text></View>
      ) : (
      <ScrollView
        ref={menuScrollRef}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 150 }}
        onScroll={onScrollMenu}
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
                className="mx-5 mb-4 rounded-[24px] shadow-sm p-3.5 flex-row"
                style={{ backgroundColor: menuCardColor }}
              >
                <Image source={{ uri: product.image }} className="w-[127px] h-[127px] rounded-[20px] bg-slate-200" />
                <View className="flex-1 ml-4 justify-between py-1">
                  <View>
                    <Text className="text-lg font-bold" style={{ color: textColor }}>{product.name}</Text>
                    <Text className="text-xs mt-1" style={{ color: textColor }} numberOfLines={1}>{product.description}</Text>
                  </View>
                  <View className="flex-row justify-between items-center mt-2">
                    <PriceWithSymbol amount={product.price} iconSize={18} iconColor={textColor} textStyle={{ color: textColor, fontWeight: '700', fontSize: 18 }} />
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
              <TextInput placeholder={isArabic ? 'ماذا ترغب اليوم؟' : 'What are you craving?'} className="flex-1 ml-2 font-medium" style={{ color: textColor }} value={searchQuery} onChangeText={setSearchQuery} />
            </View>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {products.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase())).map((item) => (
              <TouchableOpacity key={item.id} onPress={() => openProduct(item)} 
                className="mb-4 p-3 rounded-2xl flex-row items-center"
                style={{ backgroundColor: menuCardColor }}
              >
                <Image source={{ uri: item.image }} className="w-16 h-16 rounded-xl bg-slate-200" />
                <View className="ml-4 flex-1"><Text className="text-lg font-bold" style={{ color: textColor }}>{item.name}</Text><PriceWithSymbol amount={item.price} iconSize={16} iconColor={textColor} textStyle={{ color: textColor, fontWeight: '700' }} /></View>
                <Plus size={16} color={textColor} />
              </TouchableOpacity>
            ))}
          </ScrollView>
          </View>
        </KeyboardAvoidingView>
        </Animated.View>
        </GestureDetector>
      )}

      {/* Promo popup: once per uploaded popup banner version */}
      {activePopup && (
        <Modal visible={promoPopupVisible} transparent animationType="fade">
          <TouchableOpacity activeOpacity={1} onPress={closePromoPopup} className="flex-1 bg-black/60 justify-center items-center px-6">
            <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} className="w-[92%] max-w-xl rounded-2xl overflow-hidden bg-white shadow-2xl">
              <ImageBackground source={{ uri: activePopup.image }} className="h-[420px] justify-end p-4" imageStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
                <View className="absolute inset-0 bg-black/50 rounded-t-2xl" />
                <Text className="text-white font-bold text-2xl z-10">{activePopup.subtitle}</Text>
                <Text className="text-gray-200 z-10">{activePopup.title}</Text>
              </ImageBackground>
              <TouchableOpacity onPress={closePromoPopup} className="py-4 items-center border-t border-slate-100" style={{ backgroundColor: accent }}>
                <Text className="text-white font-bold">{isArabic ? 'إغلاق' : 'Close'}</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}

      {/* FLOATING CART – always visible when items exist; blocked on closed/busy with message */}
      {!!totalItems && (
        <View
          className="absolute left-5 right-5 z-[120]"
          style={{ bottom: Platform.OS === 'ios' ? 104 : 88 }}
        >
          <TouchableOpacity
            onPress={() => {
              if (isClosed || isBusy) {
                Alert.alert(
                  isArabic ? 'الطلب غير متاح' : 'Ordering Unavailable',
                  isClosed
                    ? (isArabic ? 'المتجر مغلق حالياً.' : 'Store is currently closed.')
                    : (isArabic ? 'المتجر مشغول حالياً ولا يستقبل طلبات جديدة.' : 'Store is currently busy and not accepting new orders.')
                );
                return;
              }
              router.push('/cart');
            }}
            className="p-5 rounded-[28px] flex-row items-center shadow-2xl"
            style={{ backgroundColor: (isClosed || isBusy) ? '#94a3b8' : accent }}
            activeOpacity={0.8}
          >
            <View className="flex-row items-center flex-1">
              <View className="bg-white/20 px-3 py-1.5 rounded-xl mr-3"><Text className="text-white font-bold">{totalItems}</Text></View>
              <Text className="text-white font-bold text-lg">{isArabic ? 'عرض السلة' : 'View Cart'}</Text>
              <View className="ml-auto mr-3"><PriceWithSymbol amount={totalPrice} iconSize={18} iconColor="#fff" textStyle={{ color: '#fff', fontWeight: '700', fontSize: 18 }} /></View>
              <ChevronRight size={24} color="white" />
            </View>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
