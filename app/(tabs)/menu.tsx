import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  Bike,
  ChevronDown,
  ChevronRight,
  Gift,
  Plus,
  Search,
  ShoppingBag,
  Store,
  X
} from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MerchantLogoImage } from '../../src/components/branding/MerchantLogoImage';
import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../../src/api/nooksBanners';
import { loyaltyApi, type LoyaltyBalance, type LoyaltyReward, type LoyaltyTransaction } from '../../src/api/loyalty';
import { readCache, writeCache } from '../../src/lib/persistentCache';
import { PriceWithSymbol } from '../../src/components/common/PriceWithSymbol';
import { useAuth } from '../../src/context/AuthContext';
import { useCart } from '../../src/context/CartContext';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useMenuContext } from '../../src/context/MenuContext';
import PolaroidMenuScreen from '../../src/layouts/polaroid/PolaroidMenuScreen';

type SliderItem = { id: string; image: string; title: string; subtitle: string };

/**
 * Slider banner image with a fade + settle animation on load.
 *
 * Layout: a brand-tinted placeholder paints immediately so the
 * container reserves its space — no layout jump when the image
 * arrives. The image itself sits on top, starts at opacity 0 and
 * scale 0.95, and on the native `onLoad` event animates to
 * opacity 1 and scale 1 over 320ms with an ease-out cubic curve.
 * Effect reads as the image "landing" — quick to feel responsive,
 * then gently decelerates as it locks into the final frame.
 *
 * The fade re-triggers on every mount because each banner is keyed
 * by id in the parent FlatList — swapping banners replays the
 * animation. Cached images still go through it, just compressed
 * into a few frames once onLoad fires almost immediately.
 */
function SliderBannerImage({
  uri,
  placeholderColor,
  borderRadius = 16,
}: {
  uri: string;
  placeholderColor: string;
  borderRadius?: number;
}) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.95);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const handleLoad = () => {
    const timing = { duration: 320, easing: Easing.out(Easing.cubic) };
    opacity.value = withTiming(1, timing);
    scale.value = withTiming(1, timing);
  };
  return (
    <>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: placeholderColor,
          opacity: 0.18,
          borderRadius,
        }}
      />
      <Animated.Image
        source={{ uri }}
        onLoad={handleLoad}
        resizeMode="cover"
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius,
          },
          animatedStyle,
        ]}
      />
    </>
  );
}

export default function MenuScreen() {
  // Layout switcher MUST come before any other hooks so the hook
  // order stays consistent across renders even when menuLayout
  // flips (e.g. 'classic' default → 'polaroid' after branding
  // fetch). Each branch mounts its own subtree and React tracks
  // hooks per-component, not per-parent.
  const { menuLayout } = useMerchantBranding();
  if (menuLayout === 'polaroid') {
    return <PolaroidMenuScreen />;
  }
  return <ClassicMenuScreen />;
}

function ClassicMenuScreen() {
  const { i18n } = useTranslation();
  const { totalItems, totalPrice, orderType, selectedBranch, deliveryAddress } = useCart();
  const { merchantId } = useMerchant();
  const { user } = useAuth();
  const customerId = user?.id ?? null;
  const { products, categories, loading, error } = useMenuContext();
  const { primaryColor, logoUrl, inAppLogoScale, backgroundColor, menuCardColor, textColor, tabTextColor } = useMerchantBranding();
  const router = useRouter();
  const headerBg = primaryColor;
  const accent = primaryColor;
  const isArabic = i18n.language === 'ar';
  const LOGO_SLOT = 54;
  const logoScaleFactor = Math.min(2, Math.max(0.2, (inAppLogoScale ?? 100) / 100));

  const [selectedCategory, setSelectedCategory] = useState('');
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [promoPopupVisible, setPromoPopupVisible] = useState(false);
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const [activePopup, setActivePopup] = useState<SliderItem | null>(null);
  const popupSessionConsumedRef = useRef(false);
  // Phase 3: embedded loyalty card. Loaded from the same cache the
  // rewards screen reads — preloaded on mount, then refreshed live.
  const [loyaltyBalance, setLoyaltyBalance] = useState<LoyaltyBalance | null>(null);

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

  // Phase 3: preload the loyalty balance for both the embedded card
  // here AND the rewards screen (offers.tsx/rewards.tsx share this
  // cache key/shape). Cached snapshot paints instantly on mount; the
  // network refresh runs in parallel and updates state when it lands.
  useEffect(() => {
    if (!merchantId || !customerId) return;
    const key = `@als_loyalty_${merchantId}_${customerId}`;
    type LoyaltyCache = {
      balance: LoyaltyBalance | null;
      transactions: LoyaltyTransaction[];
      rewards: LoyaltyReward[];
    };
    let cancelled = false;

    // Step 1 — cached snapshot for instant paint.
    readCache<LoyaltyCache>(key).then((cached) => {
      if (cancelled) return;
      if (cached?.balance) setLoyaltyBalance(cached.balance);
    });

    // Step 2 — network refresh.
    loyaltyApi
      .getBalance(customerId, merchantId)
      .then(async (balance) => {
        if (cancelled || !balance) return;
        setLoyaltyBalance(balance);
        const prev = await readCache<LoyaltyCache>(key);
        if (cancelled) return;
        await writeCache<LoyaltyCache>(key, {
          balance,
          transactions: prev?.transactions ?? [],
          rewards: prev?.rewards ?? [],
        });
      })
      .catch(() => {
        // best-effort preload, nothing to surface
      });
    return () => {
      cancelled = true;
    };
  }, [merchantId, customerId]);

  // Phase 3: compute the next affordable milestone for the progress
  // indicator on the embedded loyalty card. Smallest-cost unaffordable
  // milestone = the next reward the user is working toward. If all
  // milestones are affordable, we point to the most expensive one as
  // an "everything unlocked!" indicator.
  const loyaltyProgress = useMemo(() => {
    if (!loyaltyBalance || loyaltyBalance.loyaltyType !== 'points') return null;
    const milestones = (loyaltyBalance.stampMilestones ?? [])
      .map((m) => ({
        ...m,
        cost: m.points_threshold ?? m.stamp_number,
      }))
      .sort((a, b) => a.cost - b.cost);
    if (milestones.length === 0) return null;
    const points = loyaltyBalance.points ?? 0;
    const next = milestones.find((m) => m.cost > points);
    if (!next) {
      // Everything's affordable
      const highest = milestones[milestones.length - 1];
      return {
        nextName: highest.reward_name,
        nextCost: highest.cost,
        progress: 1,
        allUnlocked: true,
      };
    }
    return {
      nextName: next.reward_name,
      nextCost: next.cost,
      progress: Math.max(0, Math.min(1, points / next.cost)),
      allUnlocked: false,
    };
  }, [loyaltyBalance]);

  const sliderItems: SliderItem[] = useMemo(() => {
    const sliderBanners = nooksBanners.filter((b) => b.placement === 'slider');
    if (sliderBanners.length > 0) {
      return sliderBanners.map((b) => ({
        id: b.id,
        image: b.image_url,
        title: b.title ?? '',
        subtitle: b.subtitle ?? '' }));
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
          subtitle: b.subtitle ?? '' })),
    [nooksBanners]
  );

  // Popup queue behavior:
  // - show at most one popup per app session
  // - when multiple popup banners exist, show first unseen in upload order
  // - after user closes app and opens a new session, show next unseen popup
  //
  // Image-safety guarantee: by the time popupItems reaches this effect,
  // every banner has already been prefetched + validated by warmup.ts
  // (Image.prefetch with an 8s timeout). Banners that failed prefetch
  // are filtered out of the offers cache, so they never reach the
  // popup queue. The Modal therefore renders an already-cached image
  // with no decode-driven freeze.
  //
  // The "seen" id is persisted at DISPLAY time, not Close-press time.
  // A force-close of the app while the popup is visible still advances
  // to the next popup on the next cold launch.
  //
  // Seen-ids are scoped per (merchant, user) so two accounts on the
  // same device don't share popup-seen state — one customer closing
  // a popup must NOT close it for any other customer.
  useEffect(() => {
    if (!merchantId || !customerId || popupItems.length === 0 || popupSessionConsumedRef.current) return;
    let cancelled = false;
    const seenKey = `popup_seen_ids_${merchantId}_${customerId}`;
    AsyncStorage.getItem(seenKey).then((raw) => {
      if (cancelled) return;
      let seenIds: string[] = [];
      try {
        seenIds = raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        seenIds = [];
      }
      const nextPopup = popupItems.find((p) => !seenIds.includes(p.id));
      // Debug: emit everything the popup queue saw on this run so we
      // can verify seen_ids actually persists across cold starts.
      // Tagged [POPUP_QUEUE] on the server side. Fire-and-forget.
      const debugUrl = process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL?.replace(/\/$/, '');
      if (debugUrl) {
        fetch(`${debugUrl}/api/public/debug/banner-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchantId,
            url: '_popup_queue',
            customerId,
            seenIds,
            popupOrder: popupItems.map((p) => p.id),
            pickedId: nextPopup?.id ?? null,
            refConsumed: popupSessionConsumedRef.current,
            seenKey,
            ts: Date.now(),
          }),
        }).catch(() => {});
      }
      if (nextPopup) {
        setActivePopup(nextPopup);
        setPromoPopupVisible(true);
        popupSessionConsumedRef.current = true;
        if (!seenIds.includes(nextPopup.id)) {
          seenIds.push(nextPopup.id);
          AsyncStorage.setItem(seenKey, JSON.stringify(seenIds))
            .then(() => {
              if (debugUrl) {
                fetch(`${debugUrl}/api/public/debug/banner-check`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    merchantId,
                    url: '_popup_seen_persisted',
                    customerId,
                    persistedId: nextPopup.id,
                    seenIdsAfter: seenIds,
                    ts: Date.now(),
                  }),
                }).catch(() => {});
              }
            })
            .catch(() => {});
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [popupItems, merchantId, customerId]);

  const closePromoPopup = useCallback(() => {
    setPromoPopupVisible(false);
    setActivePopup(null);
  }, []);

  // Aspect ratio of the active popup image, so the modal can adapt
  // to portrait phone-screenshot popups (allowed via the popupBanner
  // normalize profile) as well as landscape promos. The card's
  // 75 vh maxHeight clamps tall portrait images.
  const [popupAspect, setPopupAspect] = useState<number | null>(null);
  useEffect(() => {
    if (!activePopup) {
      setPopupAspect(null);
      return;
    }
    let cancelled = false;
    Image.getSize(
      activePopup.image,
      (w, h) => {
        if (!cancelled && h > 0) setPopupAspect(w / h);
      },
      () => {
        if (!cancelled) setPopupAspect(null);
      },
    );
    return () => { cancelled = true; };
  }, [activePopup]);

  // Image-load safety net: if the popup banner image hasn't loaded
  // within 12 seconds, auto-dismiss the popup. The pre-flight HEAD
  // check above already rejects oversized / 404 images, so the
  // expected onLoad latency is ≤ 2s. 12s is a generous backstop for
  // legitimate slow networks (rural / spotty LTE in KSA) without
  // letting a stuck modal block the menu indefinitely. The
  // always-visible X button means users can dismiss manually before
  // this fires anyway.
  const popupLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!promoPopupVisible) {
      if (popupLoadTimerRef.current) {
        clearTimeout(popupLoadTimerRef.current);
        popupLoadTimerRef.current = null;
      }
      return;
    }
    popupLoadTimerRef.current = setTimeout(() => {
      console.warn('[Menu] Popup image load timeout — auto-dismissing');
      closePromoPopup();
    }, 12000);
    return () => {
      if (popupLoadTimerRef.current) {
        clearTimeout(popupLoadTimerRef.current);
        popupLoadTimerRef.current = null;
      }
    };
  }, [promoPopupVisible, closePromoPopup]);

  const screenWidth = Dimensions.get('window').width;
  const searchTranslateX = useSharedValue(0);

  const searchAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: searchTranslateX.value }] }));

  const closeSearch = useCallback(() => setIsSearchVisible(false), []);

  useEffect(() => {
    if (isSearchVisible) searchTranslateX.value = 0;
  }, [isSearchVisible, searchTranslateX]);

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
          y: sectionYRef.current[section.title] }))
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

  // Phase 3: compact loyalty card. Renders for signed-in customers in
  // points mode. Shows the live balance + a progress arc to the next
  // affordable milestone. Tap → opens /loyalty-modal (full card with
  // catalog). For cashback merchants we still surface the balance so
  // the embed isn't conditional on loyalty type alone.
  const loyaltyCard = useMemo(() => {
    if (!customerId || !loyaltyBalance) return null;
    const isCashback = loyaltyBalance.loyaltyType === 'cashback';
    const open = () => router.push('/loyalty-modal' as never);

    if (isCashback) {
      return (
        <TouchableOpacity
          onPress={open}
          activeOpacity={0.85}
          style={{
            marginHorizontal: 16,
            marginTop: 14,
            padding: 16,
            borderRadius: 22,
            backgroundColor: primaryColor,
            flexDirection: 'row',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.18,
            shadowRadius: 12,
            elevation: 6,
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: 'rgba(255,255,255,0.22)',
              alignItems: 'center',
              justifyContent: 'center',
              marginEnd: 12,
            }}
          >
            <Gift size={22} color="#ffffff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>
              {isArabic ? 'كاش باك' : 'CASHBACK'}
            </Text>
            <Text style={{ color: '#ffffff', fontSize: 20, fontWeight: '800', marginTop: 2 }}>
              {(loyaltyBalance.cashbackBalance ?? 0).toFixed(2)} {isArabic ? 'ر.س' : 'SAR'}
            </Text>
          </View>
          <ChevronRight
            size={18}
            color="#ffffff"
            style={{ transform: [{ scaleX: isArabic ? -1 : 1 }] }}
          />
        </TouchableOpacity>
      );
    }

    // Points mode
    const lifetime = loyaltyBalance.lifetimePoints ?? 0;
    const points = loyaltyBalance.points ?? 0;
    const progress = loyaltyProgress?.progress ?? 0;
    const nextName = loyaltyProgress?.nextName ?? null;
    const nextCost = loyaltyProgress?.nextCost ?? null;
    const allUnlocked = loyaltyProgress?.allUnlocked ?? false;

    return (
      <TouchableOpacity
        onPress={open}
        activeOpacity={0.85}
        style={{
          marginHorizontal: 16,
          marginTop: 14,
          padding: 16,
          borderRadius: 22,
          backgroundColor: primaryColor,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.18,
          shadowRadius: 12,
          elevation: 6,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: 'rgba(255,255,255,0.22)',
              alignItems: 'center',
              justifyContent: 'center',
              marginEnd: 12,
            }}
          >
            <Gift size={22} color="#ffffff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>
              {isArabic ? 'نقاطك' : 'YOUR POINTS'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 2 }}>
              <Text style={{ color: '#ffffff', fontSize: 24, fontWeight: '800' }}>
                {points}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600', marginStart: 6 }}>
                {isArabic ? 'نقطة' : 'pts'}
              </Text>
              {lifetime > points && (
                <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, marginStart: 8 }}>
                  {isArabic ? `· ${lifetime} مكتسبة` : `· ${lifetime} lifetime`}
                </Text>
              )}
            </View>
          </View>
          <ChevronRight
            size={18}
            color="#ffffff"
            style={{ transform: [{ scaleX: isArabic ? -1 : 1 }] }}
          />
        </View>

        {nextName && nextCost != null && (
          <View style={{ marginTop: 12 }}>
            <View
              style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: 'rgba(255,255,255,0.18)',
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${Math.round(progress * 100)}%`,
                  height: '100%',
                  borderRadius: 3,
                  backgroundColor: '#ffffff',
                }}
              />
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 11, marginTop: 6 }}>
              {allUnlocked
                ? isArabic
                  ? `كل المكافآت متاحة! استبدل ${nextName}`
                  : `Everything unlocked! Redeem ${nextName}`
                : isArabic
                  ? `${Math.max(0, nextCost - points)} نقطة حتى ${nextName}`
                  : `${Math.max(0, nextCost - points)} pts to ${nextName}`}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, [
    customerId,
    loyaltyBalance,
    loyaltyProgress,
    primaryColor,
    isArabic,
    router,
  ]);

  const listHeaderComponent = useMemo(() => {
    // Embedded loyalty card removed per user feedback — the dedicated
    // /loyalty-modal already surfaces points + the rewards catalog,
    // so the duplicate above the slider was just visual noise.
    const hasSlider = sliderItems.length > 0;
    if (!hasSlider) return null;
    return (
      <View style={{ backgroundColor }}>
        {hasSlider && (
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
                  {/* Container reserves layout immediately; image fades
                      in on load. Dark overlay + text sit on top so the
                      label is readable both before (against placeholder)
                      and after (against image) the fade-in. */}
                  <View className="h-40 justify-end p-4" style={{ position: 'relative' }}>
                    <SliderBannerImage uri={promo.image} placeholderColor={primaryColor} />
                    <View className="absolute inset-0 bg-black/40 rounded-2xl" />
                    <Text className="text-white font-bold text-2xl z-10">{promo.subtitle}</Text>
                    <Text className="text-gray-200 text-sm z-10">{promo.title}</Text>
                  </View>
                </TouchableOpacity>
              )}
            />
          </View>
        )}
      </View>
    );
  }, [promoWidth, promoItemWidth, sliderItems, backgroundColor, primaryColor, router]);

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
                width: e.nativeEvent.layout.width };
            }}
            style={
              selectedCategory === cat
                ? { backgroundColor: headerBg, borderColor: headerBg }
                : { backgroundColor: menuCardColor, borderColor: menuCardColor }
            }
            className="me-3 px-6 py-2.5 rounded-full border"
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
      <View
        className="pt-14 pb-6 px-5 shadow-md justify-between items-center rounded-b-[40px]"
        style={{ backgroundColor: headerBg, flexDirection: 'row' }}
      >
        <TouchableOpacity
          onPress={openOrderType}
          className="items-center flex-1 min-w-0"
          style={{ flexDirection: 'row', marginEnd: 8 }}
          accessibilityLabel={orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivering to') : (isArabic ? 'الاستلام من' : 'Picking up from')}
          accessibilityRole="button"
        >
          <View
            className="bg-white/20 p-2.5 rounded-2xl border border-white/30 shadow-sm shrink-0"
            style={{ marginEnd: 12 }}
          >
            {orderType === 'delivery' ? <Bike size={20} color={tabTextColor} /> : <Store size={20} color={tabTextColor} />}
          </View>
          <View className="flex-1 min-w-0">
            <View className="items-center" style={{ flexDirection: 'row' }}>
              <Text
                className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: tabTextColor, marginEnd: 4, writingDirection: isArabic ? 'rtl' : 'ltr' }}
              >
                {orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivering to') : (isArabic ? 'الاستلام من' : 'Picking up from')}
              </Text>
              <ChevronDown size={12} color={tabTextColor} />
            </View>
            {/* writingDirection forces the English branch name to
                align RTL inside the Arabic header so it doesn't ride
                into the search button on the far end. */}
            <Text
              className="font-bold text-lg"
              style={{ color: tabTextColor, writingDirection: isArabic ? 'rtl' : 'ltr' }}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {orderType === 'delivery'
                ? (deliveryAddress?.address || (isArabic ? 'أضف عنواناً' : 'Add address'))
                : (selectedBranch?.name || (isArabic ? 'اختر الفرع' : 'Select branch'))}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setIsSearchVisible(true)}
          className="bg-white/20 p-3 rounded-2xl border border-white/30 shadow-sm shrink-0"
          style={{ marginEnd: 8 }}
          accessibilityLabel={isArabic ? 'ابحث في المنيو' : 'Search menu'}
          accessibilityRole="button"
        >
          <Search size={22} color={tabTextColor} />
        </TouchableOpacity>
        <View
          className=""
          style={{ width: LOGO_SLOT, height: LOGO_SLOT, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
          accessibilityLabel={isArabic ? 'شعار المتجر' : 'Merchant logo'}
          accessibilityRole="image"
        >
          {logoUrl ? (
            <MerchantLogoImage
              uri={logoUrl}
              sizeDp={LOGO_SLOT}
              scaleFactor={logoScaleFactor}
            />
          ) : (
            <View style={{ width: LOGO_SLOT, height: LOGO_SLOT }} />
          )}
        </View>
      </View>

      {/* STICKY CATEGORY BAR */}
      {categoryBar}

      {/* Store status is evaluated at checkout against the customer's
          selected or nearest branch — not globally on the menu — so
          merchants with one branch closed and another open don't confuse
          browsing customers. */}

      {/* MAIN LIST */}
      {error && sections.length === 0 ? (
        <View className="px-5 py-8 flex-1 items-center" style={{ backgroundColor }}>
          <Text className="text-base text-center mb-3" style={{ color: textColor }}>
            {isArabic ? 'ما قدرنا نحمّل المنيو الحين.' : "We couldn't load the menu right now."}
          </Text>
          <Text className="text-xs text-center mb-4 opacity-60" style={{ color: textColor }}>
            {isArabic ? 'اسحب لتحديث، أو جرّب بعد ثواني.' : 'Pull to refresh, or try again in a moment.'}
          </Text>
        </View>
      ) : loading && sections.length === 0 ? (
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
              // 20% smaller card vs. the previous design: image
              // 127→102, radii 24→20 / 20→16, padding 3.5→2.5,
              // text-lg→text-base, icon sizes 18→14. Only the
              // customer-app menu card is touched — the merchant
              // PhoneSimulator in nooksweb uses its own hardcoded
              // styling and is unaffected.
              <TouchableOpacity
                key={product.id}
                onPress={() => openProduct(product)}
                activeOpacity={0.8}
                className="mx-5 mb-3 rounded-[20px] shadow-sm p-2.5"
                style={{ backgroundColor: menuCardColor, flexDirection: 'row' }}
              >
                <Image source={{ uri: product.image }} className="w-[102px] h-[102px] rounded-[16px] bg-slate-200" />
                <View
                  className="flex-1 justify-between py-0.5"
                  style={{ marginStart: 12 }}
                >
                  <View>
                    <Text className="text-base font-bold" style={{ color: textColor }}>{product.name}</Text>
                    <Text className="text-[11px] mt-0.5" style={{ color: textColor }} numberOfLines={1}>{product.description}</Text>
                  </View>
                  <View
                    className="justify-between items-center mt-1.5"
                    style={{ flexDirection: 'row' }}
                  >
                    <PriceWithSymbol amount={product.price} iconSize={14} iconColor={textColor} textStyle={{ color: textColor, fontWeight: '700', fontSize: 15 }} />
                    <View className="p-1 rounded-md" style={{ backgroundColor: accent }}><Plus size={14} color="white" /></View>
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
          <View className="items-center mb-6" style={{ flexDirection: 'row' }}>
            <TouchableOpacity
              onPress={() => setIsSearchVisible(false)}
              style={{ marginEnd: 16 }}
            >
              <ArrowLeft size={24} color={textColor} style={{ transform: [{ scaleX: isArabic ? -1 : 1 }] }} />
            </TouchableOpacity>
            <View className="flex-1 bg-slate-100 rounded-2xl flex-row items-center px-4 h-12">
              <Search size={20} color="#94a3b8" />
              <TextInput
                placeholder={isArabic ? 'ماذا ترغب اليوم؟' : 'What are you craving?'}
                className="flex-1 font-medium"
                style={{ color: textColor, marginStart: 8 }}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
            </View>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {products.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase())).map((item) => (
              <TouchableOpacity key={item.id} onPress={() => openProduct(item)} 
                className="mb-4 p-3 rounded-2xl items-center"
                style={{ backgroundColor: menuCardColor, flexDirection: 'row' }}
              >
                <Image source={{ uri: item.image }} className="w-16 h-16 rounded-xl bg-slate-200" />
                <View className="flex-1" style={{ marginStart: 16 }}>
                  <Text className="text-lg font-bold" style={{ color: textColor }}>{item.name}</Text>
                  <PriceWithSymbol amount={item.price} iconSize={16} iconColor={textColor} textStyle={{ color: textColor, fontWeight: '700' }} />
                </View>
                <Plus size={16} color={textColor} />
              </TouchableOpacity>
            ))}
          </ScrollView>
          </View>
        </KeyboardAvoidingView>
        </Animated.View>
        </GestureDetector>
      )}

      {/* Promo popup — implemented as an absolute-positioned View
          overlay instead of <Modal>. The native RN Modal on iOS keeps
          a UIWindow around even when visible toggles, and that window
          can intercept touches even when the Modal is technically
          "hidden" — that's the "menu unresponsive, tabs still work,
          slider still animates" symptom (the tab bar and the
          high-zIndex cart button are outside this screen's render
          tree so they escape the trap).
          With a plain View overlay there's no native window — when
          we want the popup gone, we don't render. The overlay is
          inside the menu screen's React tree, so it can't outlive
          the conditional render. */}
      {promoPopupVisible && activePopup ? (
        <View
          pointerEvents="auto"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
            elevation: 9999,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 24,
          }}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={closePromoPopup}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <View
            className="w-[92%] max-w-xl rounded-2xl overflow-hidden bg-white shadow-2xl"
            style={{ maxHeight: Dimensions.get('window').height * 0.75 }}
          >
            <View>
              <ImageBackground
                source={{ uri: activePopup.image }}
                style={{ width: '100%', aspectRatio: popupAspect ?? 16 / 9 }}
                resizeMode="cover"
                imageStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
                onLoad={() => {
                  if (popupLoadTimerRef.current) {
                    clearTimeout(popupLoadTimerRef.current);
                    popupLoadTimerRef.current = null;
                  }
                }}
                onError={() => {
                  console.warn('[Menu] Popup image failed to load — auto-dismissing');
                  closePromoPopup();
                }}
              >
                {(activePopup.subtitle || activePopup.title) && (
                  <View className="absolute inset-x-0 bottom-0 p-4">
                    <View className="absolute inset-0 bg-black/50 rounded-t-2xl" />
                    {activePopup.subtitle ? (
                      <Text className="text-white font-bold text-2xl z-10">{activePopup.subtitle}</Text>
                    ) : null}
                    {activePopup.title ? (
                      <Text className="text-gray-200 z-10">{activePopup.title}</Text>
                    ) : null}
                  </View>
                )}
              </ImageBackground>
              <TouchableOpacity
                onPress={closePromoPopup}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                className="absolute top-3 end-3 w-9 h-9 rounded-full items-center justify-center"
                style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
              >
                <X size={20} color="#ffffff" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={closePromoPopup} className="py-4 items-center border-t border-slate-100" style={{ backgroundColor: accent }}>
              <Text className="text-white font-bold">{isArabic ? 'إغلاق' : 'Close'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* FLOATING ACTION BUTTONS — Rewards bottom-left, Cart
          bottom-right. Both share the same iOS-app-icon-style
          rounded box (60x60, rounded-[18]) so they read as a
          matched pair at opposite corners.
          Rewards is gated on signed-in customers (rewards are
          user-scoped). Cart is gated on totalItems>0 — there's
          nothing to view when the cart is empty. Browsing isn't
          gated by branch status; checkout is where we validate
          the customer's selected/nearest branch. */}
      {customerId && (
        <TouchableOpacity
          onPress={() => router.push('/rewards' as never)}
          accessibilityLabel={isArabic ? 'مكافآت الأختام' : 'Stamp rewards'}
          accessibilityRole="button"
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            start: 20,
            bottom: Platform.OS === 'ios' ? 104 : 88,
            width: 60,
            height: 60,
            borderRadius: 18,
            backgroundColor: accent,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.25,
            shadowRadius: 12,
            elevation: 8,
            zIndex: 110,
          }}
        >
          <Gift size={28} color="#ffffff" />
        </TouchableOpacity>
      )}

      {!!totalItems && (
        <TouchableOpacity
          onPress={() => router.push('/cart')}
          accessibilityLabel={isArabic ? 'عرض السلة' : 'View cart'}
          accessibilityRole="button"
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            end: 20,
            bottom: Platform.OS === 'ios' ? 104 : 88,
            width: 60,
            height: 60,
            borderRadius: 18,
            backgroundColor: accent,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.25,
            shadowRadius: 12,
            elevation: 8,
            zIndex: 110,
          }}
        >
          <ShoppingBag size={26} color="#ffffff" />
          {/* Item-count badge sits in the top-end corner of the
              button — same pattern as iOS notification badges so
              the metric reads instantly without taking room from
              the central icon. */}
          <View
            style={{
              position: 'absolute',
              top: -6,
              end: -6,
              minWidth: 22,
              height: 22,
              borderRadius: 11,
              paddingHorizontal: 5,
              backgroundColor: '#ef4444',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 2,
              borderColor: backgroundColor,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{totalItems}</Text>
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
}
