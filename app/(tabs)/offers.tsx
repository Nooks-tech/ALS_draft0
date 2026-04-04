import { LinearGradient } from 'expo-linear-gradient';

type ExpoWalletBridge = {
  addPass?: (base64: string) => Promise<unknown>;
  isAvailable?: () => Promise<boolean>;
};

let ExpoWallet: ExpoWalletBridge | null = null;
let expoWalletAddPass: ((base64: string) => Promise<unknown>) | null = null;
let expoWalletIsAvailable: (() => Promise<boolean>) | null = null;
try {
  const walletModule = require('@giulio987/expo-wallet');
  const candidate = walletModule?.default ?? walletModule;
  ExpoWallet = candidate && typeof candidate === 'object' ? candidate as ExpoWalletBridge : null;
  expoWalletAddPass = typeof walletModule?.addPass === 'function' ? walletModule.addPass : null;
  expoWalletIsAvailable = typeof walletModule?.isAvailable === 'function' ? walletModule.isAvailable : null;
} catch {
  // Native module not available in Expo Go — only works in device builds
}
import { useRouter } from 'expo-router';
import { ArrowLeft, ChevronDown, Gift, Star, TrendingUp } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../../src/api/config';
import { getAuthToken } from '../../src/api/client';
import { fetchNooksBanners, type NooksBanner } from '../../src/api/nooksBanners';
import { fetchNooksPromos } from '../../src/api/nooksPromos';
import {
  loyaltyApi,
  type LoyaltyBalance,
  type LoyaltyReward,
  type LoyaltyTransaction,
} from '../../src/api/loyalty';
import { OfferCard } from '../../src/components/common/OfferCard';
import { useMerchant } from '../../src/context/MerchantContext';
import { PriceWithSymbol } from '../../src/components/common/PriceWithSymbol';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useAuth } from '../../src/context/AuthContext';
import { AppleWalletAddPassButton } from '../../src/components/apple-wallet/AppleWalletAddPassButton';

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function darkenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.max(0, Math.round(rgb.r * (1 - amount)));
  const g = Math.max(0, Math.round(rgb.g * (1 - amount)));
  const b = Math.max(0, Math.round(rgb.b * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 > 160;
}

function formatExpiry(validUntil?: string): string {
  if (!validUntil) return 'Valid for limited time';
  try {
    const d = new Date(validUntil);
    return isNaN(d.getTime()) ? 'Valid for limited time' : `Valid until ${d.toLocaleDateString()}`;
  } catch {
    return 'Valid for limited time';
  }
}

function canAddPassToAppleWallet(): boolean {
  return typeof expoWalletAddPass === 'function' || typeof ExpoWallet?.addPass === 'function';
}

async function isAppleWalletBridgeAvailable(): Promise<boolean> {
  try {
    if (typeof expoWalletIsAvailable === 'function') {
      return !!(await expoWalletIsAvailable());
    }
    if (typeof ExpoWallet?.isAvailable === 'function') {
      return !!(await ExpoWallet.isAvailable());
    }
  } catch {
    // Fall back to checking the linked native method below.
  }

  return canAddPassToAppleWallet();
}

async function addPassToAppleWallet(base64: string): Promise<unknown> {
  if (typeof expoWalletAddPass === 'function') {
    return expoWalletAddPass(base64);
  }
  if (typeof ExpoWallet?.addPass === 'function') {
    return ExpoWallet.addPass(base64);
  }
  throw new Error('Apple Wallet is not available on this device.');
}

export default function OffersScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { merchantId } = useMerchant();
  const { backgroundColor, menuCardColor, textColor, primaryColor } = useMerchantBranding();
  const { user } = useAuth();
  const [tab, setTab] = useState<'offers' | 'points'>('offers');

  // Offers data
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const [nooksPromos, setNooksPromos] = useState<Array<{
    id: string; code: string; name: string; description?: string;
    valid_until?: string; image_url?: string | null; imageUrl?: string | null;
  }>>([]);
  /** False until both Nooks fetches finish and optional minimum display time elapses. */
  const [offersFetchDone, setOffersFetchDone] = useState(() => !merchantId);

  // Loyalty data
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [appleWalletAvailable, setAppleWalletAvailable] = useState(false);
  const [googleWalletAvailable, setGoogleWalletAvailable] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const isArabic = i18n.language === 'ar';

  const offersPulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (tab !== 'offers' || offersFetchDone) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(offersPulse, { toValue: 1, duration: 550, useNativeDriver: true }),
        Animated.timing(offersPulse, { toValue: 0.4, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [tab, offersFetchDone, offersPulse]);

  useEffect(() => {
    if (!merchantId) {
      setOffersFetchDone(true);
      setNooksBanners([]);
      setNooksPromos([]);
      return;
    }
    setOffersFetchDone(false);
    let cancelled = false;
    const MIN_MS = 650;
    const started = Date.now();

    (async () => {
      try {
        const [banners, promos] = await Promise.all([
          fetchNooksBanners(merchantId),
          fetchNooksPromos(merchantId),
        ]);
        if (cancelled) return;
        setNooksBanners(banners);
        setNooksPromos(promos);
      } catch {
        if (!cancelled) {
          setNooksBanners([]);
          setNooksPromos([]);
        }
      } finally {
        if (cancelled) return;
        const elapsed = Date.now() - started;
        const rest = Math.max(0, MIN_MS - elapsed);
        setTimeout(() => {
          if (!cancelled) setOffersFetchDone(true);
        }, rest);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [merchantId]);

  const loadLoyalty = useCallback(async () => {
    if (!user?.id || !merchantId) return;
    setLoyaltyLoading(true);
    try {
      const [bal, hist, rw] = await Promise.all([
        loyaltyApi.getBalance(user.id, merchantId).catch(() => null),
        loyaltyApi.getHistory(user.id, merchantId).catch(() => ({ transactions: [] as LoyaltyTransaction[] })),
        loyaltyApi.getRewards(merchantId).catch(() => ({ rewards: [] as LoyaltyReward[] })),
      ]);
      if (bal) setBalance(bal);
      if (hist) setTransactions(hist.transactions);
      if (rw) setRewards(rw.rewards);
    } catch { /* best-effort */ }
    setLoyaltyLoading(false);

    const checks = await Promise.all([
      fetch(`${API_URL}/api/loyalty/wallet-pass/check`).then(r => r.ok).catch(() => false),
      fetch(`${API_URL}/api/loyalty/google-wallet/check`).then(r => r.ok && r.json().then((d: any) => d.available)).catch(() => false),
    ]);
    const nativeAppleWalletAvailable =
      Platform.OS === 'ios' && checks[0] ? await isAppleWalletBridgeAvailable().catch(() => false) : false;
    setAppleWalletAvailable(nativeAppleWalletAvailable);
    setGoogleWalletAvailable(Platform.OS === 'android' && checks[1]);
  }, [user?.id, merchantId]);

  useEffect(() => {
    if (tab === 'points') loadLoyalty();
  }, [tab, loadLoyalty]);

  const handleAddToAppleWallet = useCallback(async () => {
    if (!user?.id || !merchantId) return;
    setWalletLoading(true);
    try {
      const authToken = await getAuthToken();
      if (!authToken) {
        Alert.alert('Error', 'Please sign in again to add this pass.');
        return;
      }

      const passUrl = `${API_URL}/api/loyalty/wallet-pass?customerId=${encodeURIComponent(user.id)}&merchantId=${encodeURIComponent(merchantId)}&format=base64`;
      const res = await fetch(passUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        let msg = `Server returned ${res.status}`;
        try {
          const data = await res.json();
          if (data.error) msg = data.error;
        } catch { /* not JSON */ }
        Alert.alert('Error', msg);
        return;
      }
      const data = await res.json();
      if (data.error) {
        Alert.alert('Error', data.error);
        return;
      }
      const base64: string = data.base64;
      if (!base64 || base64.length === 0) {
        Alert.alert('Error', 'Empty pass data from server.');
        return;
      }
      console.log('[AppleWallet] pass size:', data.size, 'base64 length:', base64.length);
      await addPassToAppleWallet(base64);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      const msg = e?.message || String(err);
      const code = e?.code || '';
      console.log('[AppleWallet] error code:', code, 'message:', msg);
      if (msg.includes('E_PASS_LIBRARY_CANNOT_ADD')) {
        Alert.alert('Not Added', 'Pass was not added to Wallet.');
      } else if (msg.includes('E_PASS_LIBRARY_INVALID_DATA')) {
        Alert.alert('Error', 'Invalid pass data received from server.');
      } else if (msg.includes('E_PASS_LIBRARY_UNAVAILABLE')) {
        Alert.alert('Error', 'Apple Wallet is not available on this device.');
      } else {
        Alert.alert('Error', msg || 'Could not add wallet pass.');
      }
    } finally {
      setWalletLoading(false);
    }
  }, [user?.id, merchantId]);

  const handleRedeemReward = async (reward: LoyaltyReward) => {
    if (!user?.id || !merchantId) return;
    if ((balance?.points ?? 0) < reward.points_cost) {
      Alert.alert('النقاط غير كافية', `تحتاج إلى ${reward.points_cost} نقطة لكن لديك فقط ${balance?.points ?? 0}.`);
      return;
    }
    Alert.alert('استبدال المكافأة', `هل تريد صرف ${reward.points_cost} نقطة مقابل "${reward.name}"؟`, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'استبدال',
        onPress: async () => {
          setRedeemingId(reward.id);
          try {
            const result = await loyaltyApi.redeemReward(user.id, reward.id, merchantId);
            Alert.alert('تم الاستبدال!', `لقد استبدلت "${result.reward}". اعرض هذا للموظف.`);
            loadLoyalty();
          } catch {
            Alert.alert('خطأ', 'تعذر استبدال المكافأة.');
          }
          setRedeemingId(null);
        },
      },
    ]);
  };

  const offerList = useMemo(() => {
    if (nooksPromos.length > 0) {
      return nooksPromos.map((p) => ({
        id: p.id,
        title: p.name,
        description: p.description ?? `Use code ${p.code} at checkout`,
        code: p.code,
        expiry: formatExpiry(p.valid_until),
        image: typeof p.image_url === 'string' ? p.image_url.trim()
          : (typeof p.imageUrl === 'string' ? p.imageUrl.trim() : undefined),
      }));
    }
    return [];
  }, [nooksPromos]);

  const visibleBannerCards = useMemo(
    () => nooksBanners.filter((b) => b.placement === 'offers' || b.placement === 'slider'),
    [nooksBanners],
  );

  const loyaltyType = balance?.loyaltyType ?? 'points';
  const loyaltyTabLabel = loyaltyType === 'stamps'
    ? (isArabic ? 'بطاقة الأختام' : 'Stamps')
    : loyaltyType === 'cashback'
      ? (isArabic ? 'كاش باك' : 'Cashback')
      : (isArabic ? 'النقاط' : 'Points');
  const cardTitle = balance?.walletCardLabel
    || (loyaltyType === 'stamps' ? (isArabic ? 'بطاقة الأختام' : 'Stamp Card')
       : loyaltyType === 'cashback' ? (isArabic ? 'كاش باك' : 'Cashback')
       : (isArabic ? 'نقاطك' : 'Your Points'));
  const cardLogoUrl = balance?.walletCardLogoUrl || null;
  const cardBgColor = balance?.walletCardBgColor || primaryColor;
  const cardTxtColor = balance?.walletCardTextColor || null;
  const stampBoxColor = balance?.walletStampBoxColor || 'rgba(255,255,255,0.15)';
  const stampIconColor = balance?.walletStampIconColor || '#FFFFFF';
  const stampIconUrl = balance?.walletStampIconUrl || null;
  const bannerUrl = balance?.walletCardBannerUrl || null;

  return (
    <View className="flex-1" style={{ backgroundColor }}>
      <StatusBar barStyle="dark-content" />
      {/* Header */}
      <View
        className="pt-14 pb-3 px-5 flex-row items-center"
        style={{ backgroundColor, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}
      >
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color={textColor} />
        </TouchableOpacity>
        <Text className="text-xl font-bold flex-1" style={{ color: textColor }}>
          {tab === 'offers' ? (isArabic ? 'العروض' : 'Offers') : loyaltyTabLabel}
        </Text>
      </View>

      {/* Toggle */}
      <View className="flex-row mx-5 mt-3 rounded-xl overflow-hidden" style={{ backgroundColor: menuCardColor, borderWidth: 1, borderColor: '#e2e8f0' }}>
        <TouchableOpacity
          onPress={() => setTab('offers')}
          className="flex-1 py-2.5 items-center"
          style={tab === 'offers' ? { backgroundColor: primaryColor } : {}}
        >
          <Text className="text-sm font-semibold" style={{ color: tab === 'offers' ? '#fff' : textColor }}>{isArabic ? 'العروض' : 'Offers'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('points')}
          className="flex-1 py-2.5 items-center"
          style={tab === 'points' ? { backgroundColor: primaryColor } : {}}
        >
          <Text className="text-sm font-semibold" style={{ color: tab === 'points' ? '#fff' : textColor }}>{loyaltyTabLabel}</Text>
        </TouchableOpacity>
      </View>

      {/* Offers Tab */}
      {tab === 'offers' && (
        <View style={styles.offersTabWrap}>
          <FlatList
            data={offerList}
            keyExtractor={(item) => item.id}
            ListHeaderComponent={
              offerList.length === 0 && visibleBannerCards.length > 0 ? (
                <View className="mb-4">
                  {visibleBannerCards.map((b) => (
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
            ListEmptyComponent={
              visibleBannerCards.length === 0 ? (
                <View className="items-center justify-center py-20">
                  <Gift size={48} color="#94a3b8" />
                  <Text className="text-slate-400 mt-3 text-center">{isArabic ? 'لا توجد عروض متاحة حالياً.' : 'No offers available right now.'}</Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => <OfferCard {...item} />}
            contentContainerStyle={{ padding: 16 }}
          />
          {!offersFetchDone && (
            <View style={[StyleSheet.absoluteFillObject, { backgroundColor }]} pointerEvents="auto">
              <View style={styles.offersLoadingInner}>
                <Animated.View style={{ opacity: offersPulse }}>
                  <ActivityIndicator size="large" color={primaryColor} />
                </Animated.View>
                <Text style={[styles.offersLoadingHint, { color: textColor }]}>
                  {isArabic ? 'جاري تحميل العروض…' : 'Loading offers…'}
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* Points Tab */}
      {tab === 'points' && (
        loyaltyLoading && !balance ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={primaryColor} />
          </View>
        ) : (
          <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {/* ── Main Loyalty Card — render ONLY the card matching loyaltyType ── */}
            {(() => {
              const cardLight = isLightColor(cardBgColor);
              const gradientEnd = darkenColor(cardBgColor, 0.35);
              const cardTextColor = cardTxtColor || (cardLight ? '#1f2937' : '#ffffff');
              const cardSubTextColor = cardLight ? 'rgba(31,41,55,0.6)' : 'rgba(255,255,255,0.7)';

              /* ── STAMPS ── */
              if (loyaltyType === 'stamps') {
                return (
                  <View
                    style={{
                      borderRadius: 24, overflow: 'hidden',
                      shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                      shadowOpacity: 0.2, shadowRadius: 16, elevation: 10,
                    }}
                  >
                    <LinearGradient
                      colors={[cardBgColor, gradientEnd]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={{ padding: 24, position: 'relative' }}
                    >
                      {/* Decorative circles */}
                      <View style={{ position: 'absolute', top: -30, right: -30, width: 120, height: 120, borderRadius: 60, backgroundColor: cardLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)' }} />
                      <View style={{ position: 'absolute', bottom: -20, left: -20, width: 80, height: 80, borderRadius: 40, backgroundColor: cardLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)' }} />

                      {/* Merchant logo top-right */}
                      {cardLogoUrl && (
                        <Image
                          source={{ uri: cardLogoUrl }}
                          style={{ position: 'absolute', top: 16, right: 16, width: 48, height: 48, borderRadius: 14 }}
                          resizeMode="cover"
                        />
                      )}

                      {/* Header */}
                      <View className="flex-row items-center mb-5">
                        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                          <Star size={18} color={cardTextColor} fill={cardTextColor} />
                        </View>
                        <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginLeft: 10 }}>
                          {cardTitle}
                        </Text>
                      </View>

                      {/* Banner image behind stamps */}
                      {bannerUrl && (
                        <Image
                          source={{ uri: bannerUrl }}
                          style={{ position: 'absolute', left: 0, right: 0, top: 60, height: 140, opacity: 0.3 }}
                          resizeMode="cover"
                        />
                      )}

                      {/* Stamp grid */}
                      <View className="flex-row flex-wrap gap-2">
                        {Array.from({ length: balance?.stampTarget ?? 10 }).map((_, i) => (
                          <View
                            key={i}
                            className="w-10 h-10 rounded-xl items-center justify-center"
                            style={{
                              backgroundColor: i < (balance?.stamps ?? 0)
                                ? stampBoxColor
                                : (cardLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.1)'),
                            }}
                          >
                            {i < (balance?.stamps ?? 0) ? (
                              stampIconUrl ? (
                                <Image source={{ uri: stampIconUrl }} style={{ width: 20, height: 20 }} resizeMode="contain" />
                              ) : (
                                <Star size={16} color={stampIconColor} fill={stampIconColor} />
                              )
                            ) : (
                              <Text style={{ color: cardSubTextColor, fontSize: 11 }}>{i + 1}</Text>
                            )}
                          </View>
                        ))}
                      </View>

                      {/* Divider */}
                      <View style={{ height: 1, marginTop: 16, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />

                      {/* Remaining info */}
                      <Text style={{ color: cardSubTextColor, fontSize: 13 }}>
                        {isArabic
                          ? `تبقى ${(balance?.stampTarget ?? 10) - (balance?.stamps ?? 0)} للحصول على: ${balance?.stampRewardDescription ?? ''}`
                          : `${(balance?.stampTarget ?? 10) - (balance?.stamps ?? 0)} remaining to get: ${balance?.stampRewardDescription ?? ''}`}
                      </Text>

                      {/* Completed cards */}
                      {(balance?.completedCards ?? 0) > 0 && (
                        <Text style={{ color: cardTextColor, fontSize: 12, fontWeight: '600', marginTop: 6 }}>
                          {isArabic ? `بطاقات مكتملة: ${balance?.completedCards}` : `Cards completed: ${balance?.completedCards}`}
                        </Text>
                      )}
                    </LinearGradient>
                  </View>
                );
              }

              /* ── CASHBACK ── */
              if (loyaltyType === 'cashback') {
                return (
                  <View
                    style={{
                      borderRadius: 24, overflow: 'hidden',
                      shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                      shadowOpacity: 0.2, shadowRadius: 16, elevation: 10,
                    }}
                  >
                    <LinearGradient
                      colors={[cardBgColor, gradientEnd]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={{ padding: 24, position: 'relative' }}
                    >
                      {/* Decorative circles */}
                      <View style={{ position: 'absolute', top: -30, right: -30, width: 120, height: 120, borderRadius: 60, backgroundColor: cardLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)' }} />
                      <View style={{ position: 'absolute', bottom: -20, left: -20, width: 80, height: 80, borderRadius: 40, backgroundColor: cardLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)' }} />

                      {/* Merchant logo top-right */}
                      {cardLogoUrl && (
                        <Image
                          source={{ uri: cardLogoUrl }}
                          style={{ position: 'absolute', top: 16, right: 16, width: 48, height: 48, borderRadius: 14 }}
                          resizeMode="cover"
                        />
                      )}

                      {/* Header */}
                      <View className="flex-row items-center mb-5">
                        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                          <Gift size={18} color={cardTextColor} />
                        </View>
                        <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginLeft: 10 }}>
                          {cardTitle}
                        </Text>
                      </View>

                      {/* Cashback balance */}
                      <View className="flex-row items-baseline">
                        <PriceWithSymbol amount={balance?.cashbackBalance ?? 0} iconSize={36} iconColor={cardTextColor} textStyle={{ color: cardTextColor, fontSize: 48, fontWeight: '800', lineHeight: 52 }} />
                      </View>
                      <Text style={{ color: cardSubTextColor, fontSize: 14, marginTop: 4 }}>
                        {isArabic ? 'رصيد الكاش باك' : 'Cashback Balance'}
                      </Text>

                      {/* Divider */}
                      <View style={{ height: 1, marginTop: 16, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />

                      {/* Earn info */}
                      <View className="flex-row items-center">
                        <TrendingUp size={14} color={cardSubTextColor} />
                        <Text style={{ color: cardSubTextColor, fontSize: 13, marginLeft: 6 }}>
                          {isArabic
                            ? `اكسب ${balance?.cashbackPercent ?? 5}% كاش باك على كل طلب`
                            : `Earn ${balance?.cashbackPercent ?? 5}% cashback on every order`}
                        </Text>
                      </View>
                    </LinearGradient>
                  </View>
                );
              }

              /* ── POINTS (default) ── */
              return (
                <View
                  style={{
                    borderRadius: 24, overflow: 'hidden',
                    shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                    shadowOpacity: 0.2, shadowRadius: 16, elevation: 10,
                  }}
                >
                  <LinearGradient
                    colors={[cardBgColor, gradientEnd]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={{ padding: 24, position: 'relative' }}
                  >
                    {/* Decorative circle */}
                    <View style={{ position: 'absolute', bottom: -20, left: -20, width: 80, height: 80, borderRadius: 40, backgroundColor: cardLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)' }} />

                    {/* Merchant logo top-right */}
                    {cardLogoUrl && (
                      <Image
                        source={{ uri: cardLogoUrl }}
                        style={{ position: 'absolute', top: 16, right: 16, width: 48, height: 48, borderRadius: 14 }}
                        resizeMode="cover"
                      />
                    )}

                    {/* Header */}
                    <View className="flex-row items-center mb-5">
                      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                        <Star size={18} color={cardTextColor} fill={cardTextColor} />
                      </View>
                      <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginLeft: 10 }}>
                        {cardTitle}
                      </Text>
                    </View>

                    {/* Points */}
                    <Text style={{ color: cardTextColor, fontSize: 48, fontWeight: '800', lineHeight: 52 }}>
                      {balance?.points ?? 0}
                    </Text>
                    <View className="flex-row items-center mt-1">
                      <Text style={{ color: cardSubTextColor, fontSize: 14 }}>{isArabic ? 'القيمة ' : 'Worth '}</Text>
                      <PriceWithSymbol amount={balance?.pointsValue ?? 0} iconSize={14} iconColor={cardSubTextColor} textStyle={{ color: cardSubTextColor, fontSize: 14 }} />
                    </View>

                    {/* Divider */}
                    <View style={{ height: 1, marginVertical: 16, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />

                    {/* Earn rate */}
                    <View className="flex-row items-center">
                      <TrendingUp size={14} color={cardSubTextColor} />
                      <Text style={{ color: cardSubTextColor, fontSize: 13, marginLeft: 6 }}>
                        {balance?.earnMode === 'per_order'
                          ? (isArabic ? `اكسب ${balance?.pointsPerOrder ?? 10} نقطة لكل طلب` : `Earn ${balance?.pointsPerOrder ?? 10} points per order`)
                          : (isArabic ? `اكسب ${Math.round((balance?.pointsPerSar ?? 0.1) * 100)}% نقاط على كل طلب` : `Earn ${Math.round((balance?.pointsPerSar ?? 0.1) * 100)}% back in points`)}
                      </Text>
                    </View>
                  </LinearGradient>
                </View>
              );
            })()}

            {/* Add to Apple Wallet — native PKAddPassButton (Apple HIG) */}
            {appleWalletAvailable && user?.id && merchantId && Platform.OS === 'ios' && (
              <View style={{ marginTop: 20, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}>
                {walletLoading ? (
                  <ActivityIndicator size="small" color={primaryColor} />
                ) : (
                  <AppleWalletAddPassButton
                    style={{ width: '100%', maxWidth: 320, height: 48, alignSelf: 'center' }}
                    onWalletButtonPress={() => {
                      void handleAddToAppleWallet();
                    }}
                  />
                )}
              </View>
            )}

            {/* Add to Google Wallet */}
            {googleWalletAvailable && user?.id && merchantId && (
              <TouchableOpacity
                onPress={async () => {
                  try {
                    const authToken = await getAuthToken();
                    if (!authToken) {
                      Alert.alert('Error', 'Please sign in again to add this pass.');
                      return;
                    }

                    const res = await fetch(
                      `${API_URL}/api/loyalty/google-wallet?customerId=${encodeURIComponent(user.id)}&merchantId=${encodeURIComponent(merchantId)}`,
                      {
                        headers: { Authorization: `Bearer ${authToken}` },
                      },
                    );
                    const data = await res.json();
                    if (data.saveUrl) {
                      Linking.openURL(data.saveUrl);
                    } else {
                      Alert.alert('Error', data.error || 'Could not generate Google Wallet pass.');
                    }
                  } catch {
                    Alert.alert('Error', 'Failed to connect to server.');
                  }
                }}
                className="mt-5 flex-row items-center justify-center py-3.5 rounded-2xl"
                style={{ backgroundColor: '#000' }}
              >
                <Text className="text-white text-base font-semibold">Add to Google Wallet</Text>
              </TouchableOpacity>
            )}

            {/* Rewards Catalog */}
            {rewards.length > 0 && (
              <View className="mt-5">
                <Text className="text-lg font-bold mb-3" style={{ color: textColor }}>{isArabic ? 'المكافآت' : 'Rewards'}</Text>
                {rewards.map((r) => (
                  <View
                    key={r.id}
                    className="flex-row items-center mb-3 p-4 rounded-2xl"
                    style={{ backgroundColor: menuCardColor, borderWidth: 1, borderColor: '#e2e8f0' }}
                  >
                    {r.image_url ? (
                      <Image source={{ uri: r.image_url }} className="w-14 h-14 rounded-xl mr-3" resizeMode="cover" />
                    ) : (
                      <View className="w-14 h-14 rounded-xl mr-3 bg-slate-100 items-center justify-center">
                        <Gift size={24} color={primaryColor} />
                      </View>
                    )}
                    <View className="flex-1">
                      <Text className="font-semibold text-sm" style={{ color: textColor }}>{r.name}</Text>
                      {r.description && <Text className="text-xs text-slate-400 mt-0.5">{r.description}</Text>}
                      <Text className="text-xs font-bold mt-1" style={{ color: primaryColor }}>
                        {r.points_cost} {isArabic ? 'نقطة' : 'points'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleRedeemReward(r)}
                      disabled={redeemingId === r.id || (balance?.points ?? 0) < r.points_cost}
                      className="px-4 py-2 rounded-xl"
                      style={{
                        backgroundColor: (balance?.points ?? 0) >= r.points_cost ? primaryColor : '#e2e8f0',
                        opacity: redeemingId === r.id ? 0.5 : 1,
                      }}
                    >
                      <Text
                        className="text-xs font-bold"
                        style={{ color: (balance?.points ?? 0) >= r.points_cost ? '#fff' : '#94a3b8' }}
                      >
                        {redeemingId === r.id ? '...' : 'Redeem'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Transaction History */}
            <View className="mt-5">
              <TouchableOpacity
                onPress={() => setShowHistory(!showHistory)}
                className="flex-row items-center justify-between mb-3"
              >
                <Text className="text-lg font-bold" style={{ color: textColor }}>
                  {isArabic ? 'النشاط الأخير' : 'Recent Activity'}
                </Text>
                <ChevronDown
                  size={20}
                  color="#64748b"
                  style={{ transform: [{ rotate: showHistory ? '180deg' : '0deg' }] }}
                />
              </TouchableOpacity>
              {showHistory && (
                transactions.length > 0 ? (
                  transactions.map((tx) => (
                    <View key={tx.id} className="flex-row items-center py-3 border-b border-slate-100">
                      <View
                        className="w-9 h-9 rounded-full items-center justify-center"
                        style={{ backgroundColor: tx.type === 'earn' ? '#dcfce7' : '#fef3c7' }}
                      >
                        {tx.type === 'earn' ? (
                          <TrendingUp size={16} color="#16a34a" />
                        ) : (
                          <Gift size={16} color="#d97706" />
                        )}
                      </View>
                      <View className="flex-1 ml-3">
                        <Text className="text-slate-800 font-medium text-sm">{tx.description}</Text>
                        <Text className="text-slate-400 text-xs">
                          {new Date(tx.created_at).toLocaleDateString()}
                        </Text>
                      </View>
                      <Text
                        className="font-bold"
                        style={{ color: tx.type === 'earn' ? '#16a34a' : '#d97706' }}
                      >
                        {tx.type === 'earn' ? '+' : ''}{tx.points}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text className="text-slate-400 text-center py-4">
                    {isArabic ? 'لا توجد معاملات بعد. قم بإجراء طلب لكسب المكافآت!' : 'No transactions yet. Make an order to start earning!'}
                  </Text>
                )
              )}
            </View>
          </ScrollView>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  offersTabWrap: { flex: 1 },
  offersLoadingInner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  offersLoadingHint: {
    marginTop: 14,
    fontSize: 14,
    fontWeight: '500',
  },
});
