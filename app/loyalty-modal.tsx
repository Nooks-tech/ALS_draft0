/**
 * Phase 3 loyalty modal — compact version of the winding-path catalog.
 *
 * Opens from the menu tab's loyalty card. Same redemption flow as
 * /rewards: tap an affordable milestone → confirmation → POST to
 * /api/loyalty/redeem-milestone with a client idempotencyKey. On
 * success, the reward's foodics products land in the cart as
 * 0-priced lines and the balance refreshes.
 *
 * The full catalog tab (with full S-curve, lifetime stats, history)
 * lives at /rewards — the modal links there via "View full catalog".
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  AlertTriangle,
  ChevronDown,
  Gift,
  Lock,
  Sparkles,
  Star,
  TrendingUp,
  X,
  Check,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  Easing,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  loyaltyApi,
  type LoyaltyBalance,
  type LoyaltyTransaction,
  type RedemptionResult,
} from '../src/api/loyalty';
import { supabase } from '../src/api/supabase';
import { useAuth } from '../src/context/AuthContext';
import { useCart } from '../src/context/CartContext';
import { useMenuContext } from '../src/context/MenuContext';
import { useMerchant } from '../src/context/MerchantContext';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { loyaltyEvents } from '../src/lib/loyaltyEvents';

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

function makeIdempotencyKey(): string {
  const ts = Date.now().toString(36);
  const a = Math.random().toString(36).slice(2, 10);
  const b = Math.random().toString(36).slice(2, 10);
  return `als-redeem-${ts}-${a}${b}`;
}

function buildSCurvePath(nodes: Array<{ x: number; y: number }>): string {
  if (nodes.length === 0) return '';
  let path = `M ${nodes[0].x} ${nodes[0].y}`;
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const cur = nodes[i];
    const midY = (prev.y + cur.y) / 2;
    path += ` C ${prev.x} ${midY}, ${cur.x} ${midY}, ${cur.x} ${cur.y}`;
  }
  return path;
}

function AnimatedBalance({ value, color }: { value: number; color: string }) {
  const animated = useSharedValue(value);
  const [displayed, setDisplayed] = useState(value);
  const lastValueRef = useRef(value);

  useEffect(() => {
    if (lastValueRef.current === value) return;
    animated.value = lastValueRef.current;
    animated.value = withTiming(value, { duration: 650, easing: Easing.out(Easing.cubic) });
    lastValueRef.current = value;
    let raf: number;
    const sample = () => {
      const v = Math.round(animated.value);
      setDisplayed(v);
      if (Math.abs(v - value) > 0.5) raf = requestAnimationFrame(sample);
    };
    sample();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [value, animated]);

  return (
    <Text style={{ color, fontSize: 48, fontWeight: '800', lineHeight: 52 }}>
      {displayed}
    </Text>
  );
}

type MilestoneRow = {
  id: string;
  reward_name: string;
  reward_image_url: string | null;
  points_threshold: number;
  foodics_product_ids: string[];
  affordable: boolean;
  pointsShort: number;
};

export default function LoyaltyModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, cafeName, menuCardColor, textColor } = useMerchantBranding();
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  const { products: menuProducts } = useMenuContext();
  const { addToCart } = useCart();
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<MilestoneRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recentRedeems, setRecentRedeems] = useState<Set<string>>(new Set());
  const isArabic = i18n.language === 'ar';

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const loadLoyalty = useCallback(async (opts?: { showSpinner?: boolean }) => {
    if (!user?.id) return;
    if (opts?.showSpinner) setLoading(true);
    try {
      const [bal, hist] = await Promise.all([
        loyaltyApi.getBalance(user.id, merchantId).catch(() => null),
        loyaltyApi.getHistory(user.id, merchantId).catch(() => ({ transactions: [] as LoyaltyTransaction[] })),
      ]);
      if (bal) setBalance(bal);
      if (hist) setTransactions(hist.transactions);
    } finally {
      setLoading(false);
    }
  }, [user?.id, merchantId]);

  useEffect(() => {
    if (!user?.id) return;
    void loadLoyalty({ showSpinner: true });
  }, [user?.id, merchantId, loadLoyalty]);

  useFocusEffect(
    useCallback(() => {
      void loadLoyalty();
    }, [loadLoyalty]),
  );

  // Refetch balance the moment a cart-removal triggers a points refund.
  useEffect(() => {
    const unsubscribe = loyaltyEvents.subscribe(() => {
      void loadLoyalty();
    });
    return unsubscribe;
  }, [loadLoyalty]);

  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!supabase || !user?.id) return;
    const sb = supabase;
    const scheduleReload = () => {
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
      reloadDebounceRef.current = setTimeout(() => { void loadLoyalty(); }, 500);
    };
    const channel = sb
      .channel(`loyalty-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'loyalty_transactions', filter: `customer_id=eq.${user.id}` },
        scheduleReload,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'loyalty_cashback_balances', filter: `customer_id=eq.${user.id}` },
        scheduleReload,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'loyalty_points', filter: `customer_id=eq.${user.id}` },
        scheduleReload,
      )
      .subscribe();
    return () => {
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
      sb.removeChannel(channel);
    };
  }, [user?.id, loadLoyalty]);

  const points = balance?.points ?? 0;

  /** Sorted catalog with affordability flags. */
  const milestoneRows: MilestoneRow[] = useMemo(() => {
    if (!balance) return [];
    return [...balance.stampMilestones]
      .sort((a, b) => (a.points_threshold ?? a.stamp_number) - (b.points_threshold ?? b.stamp_number))
      .map((m) => {
        const cost = m.points_threshold ?? m.stamp_number;
        const affordable = points >= cost;
        return {
          id: m.id,
          reward_name: m.reward_name,
          reward_image_url: m.reward_image_url ?? null,
          points_threshold: cost,
          foodics_product_ids: m.foodics_product_ids ?? [],
          affordable,
          pointsShort: Math.max(0, cost - points),
        };
      });
  }, [balance, points]);

  /** Mini S-curve path — same math as /rewards, scaled smaller. */
  const pathLayout = useMemo(() => {
    if (milestoneRows.length === 0) return null;
    const width = 300;
    const horizontalOffset = 80;
    const nodeSpacing = 150;
    const top = 36;
    const nodes = milestoneRows.map((row, i) => ({
      id: row.id,
      x: width / 2 + (i % 2 === 0 ? -horizontalOffset : horizontalOffset),
      y: top + i * nodeSpacing,
    }));
    const path = buildSCurvePath(nodes);
    const height = top + (milestoneRows.length - 1) * nodeSpacing + 100;
    return { width, height, nodes, path };
  }, [milestoneRows]);

  const handleConfirmRedeem = useCallback(async () => {
    if (!confirmTarget || !user?.id || !merchantId) return;
    const target = confirmTarget;
    setConfirmTarget(null);
    setRedeemingId(target.id);

    const idempotencyKey = makeIdempotencyKey();
    let result: RedemptionResult | null = null;
    try {
      result = await loyaltyApi.redeemMilestone(merchantId, user.id, target.id, idempotencyKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Redemption failed';
      showToast(msg);
      setRedeemingId(null);
      return;
    }

    if (!result || !result.success) {
      showToast(isArabic ? 'تعذّر الاستبدال' : 'Could not redeem');
      setRedeemingId(null);
      return;
    }

    setBalance((prev) =>
      prev ? { ...prev, points: result!.newBalance } : prev,
    );

    for (const fid of target.foodics_product_ids) {
      const product = menuProducts.find((p) => p.foodicsProductId === fid);
      if (!product || !product.foodicsProductId) continue;
      addToCart({
        id: product.id,
        name: `🎁 ${product.name}`,
        price: 0,
        basePrice: 0,
        image: product.image ?? '',
        customizations: null,
        uniqueId: `reward-${target.id}-${product.foodicsProductId}-${idempotencyKey}`,
        rewardMilestoneId: target.id,
        rewardRedemptionId: result.redemptionId,
        rewardOriginalPriceSar: typeof product.price === 'number' ? product.price : 0,
      });
    }

    setRecentRedeems((prev) => {
      const next = new Set(prev);
      next.add(target.id);
      return next;
    });
    setTimeout(() => {
      setRecentRedeems((prev) => {
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
    }, 2500);

    showToast(
      isArabic
        ? `تم استبدال ${target.reward_name}!`
        : `Redeemed ${target.reward_name}!`,
    );
    setRedeemingId(null);
    void loadLoyalty();
  }, [
    confirmTarget,
    user?.id,
    merchantId,
    isArabic,
    addToCart,
    menuProducts,
    loadLoyalty,
    showToast,
  ]);

  // Effective loyalty type (cashback vs points). 'stamps' is legacy
  // and treated as 'points' for the catalog view since Phase 1 collapsed
  // the underlying storage.
  const loyaltyType = balance?.loyaltyType ?? 'points';
  const isCashbackMode = loyaltyType === 'cashback';
  const cardLabel = balance?.walletCardLabel || cafeName || (isArabic ? 'بطاقة الولاء' : 'Loyalty Card');
  const cardBgColor = balance?.walletCardBgColor || primaryColor;
  const cardLight = isLightColor(cardBgColor);
  const gradientEnd = darkenColor(cardBgColor, 0.35);
  const cardTextColor = balance?.walletCardTextColor || (cardLight ? '#1f2937' : '#ffffff');
  const cardSubTextColor = cardLight ? 'rgba(31,41,55,0.6)' : 'rgba(255,255,255,0.7)';

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: '#ffffff' }}>
      <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
        <Text className="text-lg font-bold text-slate-800">
          {isCashbackMode
            ? (isArabic ? 'كاش باك' : 'Cashback')
            : (isArabic ? 'نقاط الولاء' : 'Loyalty Points')}
        </Text>
        <TouchableOpacity onPress={() => router.back()} className="p-2">
          <X size={24} color="#64748b" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Loyalty Transition Banner */}
          {balance?.transitioning && balance?.oldSystemType && (
            <View className="mx-5 mt-5 rounded-2xl p-4" style={{ backgroundColor: '#FEF3C7' }}>
              <View className="flex-row items-start">
                <AlertTriangle size={20} color="#D97706" style={{ marginTop: 2 }} />
                <View className="flex-1 ms-3">
                  <Text className="font-bold text-amber-800 text-sm">
                    {isArabic ? 'انتقال برنامج الولاء' : 'Loyalty Program Transition'}
                  </Text>
                  <Text className="text-amber-700 text-xs mt-1">
                    {isArabic
                      ? `لديك ${balance.oldSystemBalance} ${balance.oldSystemType === 'cashback' ? 'ر.س كاش باك' : 'نقطة'} متبقية. أنفقها قبل الانتقال إلى البرنامج الجديد!`
                      : `You have ${balance.oldSystemType === 'cashback' ? `${balance.oldSystemBalance} SAR cashback` : `${balance.oldSystemBalance} points`} remaining on the old system. Spend them to unlock the new program!`
                    }
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* ── Cashback card ── */}
          {isCashbackMode ? (
            <View
              className="mx-5 mt-5"
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
                style={{ paddingTop: 20, paddingBottom: 24, paddingLeft: 20, paddingRight: 20 }}
              >
                <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginBottom: 16 }}>
                  {cardLabel}
                </Text>
                <View className="flex-row items-baseline">
                  <PriceWithSymbol
                    amount={balance?.cashbackBalance ?? 0}
                    iconSize={36}
                    iconColor={cardTextColor}
                    textStyle={{ color: cardTextColor, fontSize: 48, fontWeight: '800', lineHeight: 52 }}
                  />
                </View>
                <Text style={{ color: cardSubTextColor, fontSize: 14, marginTop: 4 }}>
                  {isArabic ? 'رصيد الكاش باك' : 'Cashback Balance'}
                </Text>
                <View style={{ height: 1, marginTop: 16, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />
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
          ) : (
            <>
              {/* ── Points balance card ── */}
              <View
                className="mx-5 mt-5"
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
                  style={{ paddingTop: 20, paddingBottom: 24, paddingLeft: 20, paddingRight: 20 }}
                >
                  <View className="flex-row items-center mb-4">
                    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                      <Star size={18} color={cardTextColor} fill={cardTextColor} />
                    </View>
                    <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginLeft: 10 }}>
                      {cardLabel}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                    <AnimatedBalance value={points} color={cardTextColor} />
                    <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '600', marginStart: 6 }}>
                      {isArabic ? 'نقطة' : 'pts'}
                    </Text>
                  </View>
                  <Text style={{ color: cardSubTextColor, fontSize: 13, marginTop: 4 }}>
                    {isArabic
                      ? `العمر الإجمالي: ${balance?.lifetimePoints ?? 0} نقطة مكتسبة`
                      : `Lifetime: ${balance?.lifetimePoints ?? 0} points earned`}
                  </Text>

                  <View style={{ height: 1, marginTop: 16, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />

                  <View className="flex-row items-center">
                    <TrendingUp size={14} color={cardSubTextColor} />
                    <View className="flex-row flex-wrap items-center" style={{ marginLeft: 6 }}>
                      {balance?.earnMode === 'per_order' ? (
                        <Text style={{ color: cardSubTextColor, fontSize: 13 }}>
                          {isArabic
                            ? `اكسب ${balance?.pointsPerOrder ?? 10} نقطة لكل طلب`
                            : `Earn ${balance?.pointsPerOrder ?? 10} points per order`}
                        </Text>
                      ) : (
                        <>
                          <Text style={{ color: cardSubTextColor, fontSize: 13 }}>
                            {isArabic
                              ? `اكسب ${balance?.pointsPerSar ?? 1} نقطة لكل `
                              : `Earn ${balance?.pointsPerSar ?? 1} point per `}
                          </Text>
                          <PriceWithSymbol symbolOnly iconSize={13} iconColor={cardSubTextColor} textStyle={{ color: cardSubTextColor, fontSize: 13 }} />
                          <Text style={{ color: cardSubTextColor, fontSize: 13 }}>
                            {isArabic ? ' يتم إنفاقه' : ' spent'}
                          </Text>
                        </>
                      )}
                    </View>
                  </View>
                </LinearGradient>
              </View>

              {/* ── Mini winding-path catalog ── */}
              <View className="mx-5 mt-6">
                <Text className="text-lg font-bold text-slate-800 mb-3">
                  {isArabic ? 'كتالوج المكافآت' : 'Rewards Catalog'}
                </Text>

                {milestoneRows.length === 0 ? (
                  <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24 }}>
                    <View
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 32,
                        backgroundColor: `${primaryColor}20`,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: 12,
                      }}
                    >
                      <Sparkles size={28} color={primaryColor} />
                    </View>
                    <Text style={{ color: textColor, fontWeight: '700', textAlign: 'center' }}>
                      {isArabic ? 'لا توجد مكافآت بعد' : 'No rewards yet'}
                    </Text>
                    <Text style={{ color: textColor, opacity: 0.6, textAlign: 'center', marginTop: 6, fontSize: 13 }}>
                      {isArabic
                        ? 'استمر في تجميع النقاط — قريباً ستظهر المكافآت هنا!'
                        : 'Keep earning points — rewards will appear here.'}
                    </Text>
                  </View>
                ) : (
                  <View style={{ alignItems: 'center' }}>
                    {pathLayout && (
                      <View style={{ width: pathLayout.width, height: pathLayout.height, position: 'relative' }}>
                        <Svg
                          width={pathLayout.width}
                          height={pathLayout.height}
                          style={{ position: 'absolute', top: 0, left: 0 }}
                        >
                          <Path
                            d={pathLayout.path}
                            stroke={`${primaryColor}30`}
                            strokeWidth={8}
                            fill="none"
                            strokeLinecap="round"
                          />
                          <Path
                            d={pathLayout.path}
                            stroke={primaryColor}
                            strokeWidth={3}
                            fill="none"
                            strokeLinecap="round"
                            strokeDasharray="2,8"
                          />
                        </Svg>
                        {milestoneRows.map((row, idx) => {
                          const node = pathLayout.nodes[idx];
                          const NODE_SIZE = 68;
                          const isRecent = recentRedeems.has(row.id);
                          const isBusy = redeemingId === row.id;
                          return (
                            <View
                              key={row.id}
                              style={{
                                position: 'absolute',
                                left: node.x - NODE_SIZE / 2,
                                top: node.y - NODE_SIZE / 2,
                                alignItems: 'center',
                                width: NODE_SIZE,
                              }}
                            >
                              <TouchableOpacity
                                onPress={() => row.affordable && !isBusy && setConfirmTarget(row)}
                                disabled={!row.affordable || isBusy}
                                activeOpacity={0.85}
                                style={{
                                  width: NODE_SIZE,
                                  height: NODE_SIZE,
                                  borderRadius: NODE_SIZE / 2,
                                  backgroundColor: row.affordable ? '#ffffff' : '#f1f5f9',
                                  borderWidth: 3,
                                  borderColor: row.affordable ? primaryColor : '#cbd5e1',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  shadowColor: '#000',
                                  shadowOffset: { width: 0, height: 3 },
                                  shadowOpacity: row.affordable ? 0.18 : 0.06,
                                  shadowRadius: 6,
                                  elevation: row.affordable ? 5 : 2,
                                  overflow: 'hidden',
                                }}
                              >
                                {row.reward_image_url ? (
                                  <Image
                                    source={{ uri: row.reward_image_url }}
                                    style={{ width: '100%', height: '100%', opacity: row.affordable ? 1 : 0.4 }}
                                    resizeMode="cover"
                                  />
                                ) : (
                                  <Gift size={26} color={row.affordable ? primaryColor : '#94a3b8'} />
                                )}
                                {!row.affordable && (
                                  <View
                                    style={{
                                      position: 'absolute',
                                      inset: 0,
                                      backgroundColor: 'rgba(0,0,0,0.18)',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    <Lock size={22} color="#ffffff" />
                                  </View>
                                )}
                                {isRecent && (
                                  <View
                                    style={{
                                      position: 'absolute',
                                      inset: 0,
                                      backgroundColor: 'rgba(16,185,129,0.85)',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    <Check size={26} color="#ffffff" />
                                  </View>
                                )}
                                {isBusy && (
                                  <View
                                    style={{
                                      position: 'absolute',
                                      inset: 0,
                                      backgroundColor: 'rgba(255,255,255,0.7)',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    <ActivityIndicator size="small" color={primaryColor} />
                                  </View>
                                )}
                              </TouchableOpacity>

                              <Text
                                numberOfLines={1}
                                style={{
                                  marginTop: 6,
                                  fontSize: 11,
                                  fontWeight: '700',
                                  color: textColor,
                                  opacity: row.affordable ? 1 : 0.55,
                                  textAlign: 'center',
                                  maxWidth: 112,
                                }}
                              >
                                {row.reward_name || (isArabic ? 'مكافأة' : 'Reward')}
                              </Text>
                              <View
                                style={{
                                  marginTop: 3,
                                  paddingHorizontal: 8,
                                  paddingVertical: 2,
                                  borderRadius: 10,
                                  backgroundColor: row.affordable ? primaryColor : '#e2e8f0',
                                }}
                              >
                                <Text
                                  style={{
                                    color: row.affordable ? '#ffffff' : '#64748b',
                                    fontSize: 10,
                                    fontWeight: '700',
                                  }}
                                >
                                  {row.points_threshold} {isArabic ? 'نقطة' : 'pts'}
                                </Text>
                              </View>
                              {!row.affordable && (
                                <Text
                                  style={{
                                    marginTop: 1,
                                    fontSize: 9,
                                    color: textColor,
                                    opacity: 0.5,
                                    textAlign: 'center',
                                  }}
                                >
                                  {isArabic ? `${row.pointsShort} نقطة` : `Need ${row.pointsShort}`}
                                </Text>
                              )}
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                )}
              </View>
            </>
          )}

          {/* Transaction History */}
          <View className="mx-5 mt-6">
            <TouchableOpacity
              onPress={() => setShowHistory(!showHistory)}
              className="flex-row items-center justify-between mb-3"
            >
              <Text className="text-lg font-bold text-slate-800">{isArabic ? 'النشاط الأخير' : 'Recent Activity'}</Text>
              <ChevronDown
                size={20}
                color="#64748b"
                style={{ transform: [{ rotate: showHistory ? '180deg' : '0deg' }] }}
              />
            </TouchableOpacity>
            {showHistory && (
              transactions.length > 0 ? (
                transactions.map((tx) => (
                  <View key={tx.id} className="flex-row items-center py-3 border-b border-slate-50">
                    <View
                      className="w-10 h-10 rounded-full items-center justify-center"
                      style={{ backgroundColor: tx.type === 'earn' ? '#dcfce7' : '#fef3c7' }}
                    >
                      {tx.type === 'earn' ? (
                        <TrendingUp size={18} color="#16a34a" />
                      ) : (
                        <Gift size={18} color="#d97706" />
                      )}
                    </View>
                    <View className="flex-1 ms-3">
                      <Text className="text-slate-800 font-medium text-sm">{tx.description}</Text>
                      <Text className="text-slate-400 text-xs">
                        {new Date(tx.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text
                      className="font-bold"
                      style={{ color: tx.type === 'earn' ? '#16a34a' : '#d97706' }}
                    >
                      {tx.type === 'earn' ? '+' : ''}
                      {tx.loyalty_type === 'cashback' && tx.amount_sar != null
                        ? `${tx.amount_sar} ${isArabic ? 'ر.س' : 'SAR'}`
                        : tx.points}
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

          {/* View full catalog (only in points mode) */}
          {!isCashbackMode && (
            <TouchableOpacity
              onPress={() => { router.back(); router.push('/rewards' as never); }}
              className="mx-5 mt-6 rounded-2xl p-4 items-center"
              style={{ backgroundColor: '#f8fafc' }}
            >
              <Text className="font-semibold" style={{ color: primaryColor }}>
                {isArabic ? 'فتح كتالوج المكافآت بالكامل' : 'Open full Rewards Catalog'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}

      {/* Confirmation modal */}
      <Modal
        visible={!!confirmTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmTarget(null)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.55)',
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 28,
          }}
        >
          <View
            style={{
              backgroundColor: menuCardColor,
              borderRadius: 22,
              padding: 24,
              width: '100%',
              maxWidth: 420,
            }}
          >
            <TouchableOpacity
              onPress={() => setConfirmTarget(null)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{ position: 'absolute', top: 14, end: 14 }}
            >
              <X size={20} color="#94a3b8" />
            </TouchableOpacity>

            {confirmTarget?.reward_image_url ? (
              <Image
                source={{ uri: confirmTarget.reward_image_url }}
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 44,
                  alignSelf: 'center',
                  marginBottom: 14,
                }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 44,
                  alignSelf: 'center',
                  backgroundColor: `${primaryColor}25`,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 14,
                }}
              >
                <Gift size={40} color={primaryColor} />
              </View>
            )}

            <Text style={{ color: textColor, fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 6 }}>
              {isArabic
                ? `استبدال ${confirmTarget?.reward_name ?? ''}؟`
                : `Redeem ${confirmTarget?.reward_name ?? ''}?`}
            </Text>
            <Text style={{ color: textColor, opacity: 0.7, textAlign: 'center', marginBottom: 18 }}>
              {isArabic
                ? `سيتم خصم ${confirmTarget?.points_threshold ?? 0} نقطة من رصيدك.`
                : `${confirmTarget?.points_threshold ?? 0} points will be deducted from your balance.`}
            </Text>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => setConfirmTarget(null)}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 14, backgroundColor: '#f1f5f9', alignItems: 'center' }}
                activeOpacity={0.8}
              >
                <Text style={{ color: '#475569', fontWeight: '700' }}>
                  {isArabic ? 'إلغاء' : 'Cancel'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleConfirmRedeem}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 14, backgroundColor: primaryColor, alignItems: 'center' }}
                activeOpacity={0.85}
              >
                <Text style={{ color: '#ffffff', fontWeight: '700' }}>
                  {isArabic ? 'تأكيد الاستبدال' : 'Confirm redeem'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Toast */}
      {toast && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 24,
            right: 24,
            bottom: 48,
            paddingVertical: 14,
            paddingHorizontal: 20,
            borderRadius: 18,
            backgroundColor: 'rgba(15,23,42,0.92)',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '600', textAlign: 'center' }}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}
