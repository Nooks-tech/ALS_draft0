/**
 * Phase 3 rewards screen — winding-path catalog of points-mode milestones.
 *
 * Layout:
 *   - Header (back arrow + title)
 *   - Large animated point-balance counter (rolls up to the latest value
 *     on every change) with a "Lifetime: X points earned" subtitle.
 *   - Vertical SVG S-curve connecting milestone nodes that alternate
 *     left/right of center. Each node is a 84dp circle showing the
 *     reward image; below it sits the reward name + a points-cost pill.
 *     Affordable milestones (balance >= points_threshold) are full
 *     color + tappable; unaffordable ones render in greyscale with a
 *     lock overlay and a "Need X more points" label.
 *   - Tap an affordable milestone → confirmation modal → POST to
 *     /api/loyalty/redeem-milestone with a client-generated
 *     idempotencyKey. On success, the milestone's foodics_product_ids
 *     are added to the cart as 0-priced reward lines (same pattern as
 *     the legacy stamps flow), the balance refreshes from the response,
 *     and a "redeemed!" toast flashes for 2 s.
 *   - Empty state (0 milestones): friendly illustration + copy, no
 *     winding path drawn.
 *
 * Reusing the existing AsyncStorage cache key so the offers tab + this
 * screen still warm each other's data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StatusBar,
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
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Gift, Lock, Sparkles, X, Check } from 'lucide-react-native';
import { useAuth } from '../src/context/AuthContext';
import { useCart } from '../src/context/CartContext';
import { useMenuContext } from '../src/context/MenuContext';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import {
  loyaltyApi,
  type LoyaltyBalance,
  type LoyaltyReward,
  type LoyaltyTransaction,
  type RedemptionResult,
} from '../src/api/loyalty';
import { readCache, writeCache } from '../src/lib/persistentCache';

/** Shared cache key/shape with app/(tabs)/offers.tsx + app/(tabs)/menu.tsx. */
type LoyaltyCache = {
  balance: LoyaltyBalance | null;
  transactions: LoyaltyTransaction[];
  rewards: LoyaltyReward[];
};
const loyaltyCacheKey = (merchantId: string, userId: string) =>
  `@als_loyalty_${merchantId}_${userId}`;

/**
 * Compact UUID-ish generator suitable for an idempotency key. Crypto
 * randomness isn't required — the only consumer is the server's
 * 24-hour-window dedup check, which uses (idempotencyKey, milestoneId)
 * as a composite. 96 bits of entropy is plenty against accidental
 * collisions within a per-customer-per-milestone scope.
 */
function makeIdempotencyKey(): string {
  const ts = Date.now().toString(36);
  const a = Math.random().toString(36).slice(2, 10);
  const b = Math.random().toString(36).slice(2, 10);
  return `als-redeem-${ts}-${a}${b}`;
}

/**
 * Animated digit counter — text node whose displayed number rolls
 * from prev to next over ~600ms with an ease-out curve. Used for the
 * point balance header so a successful redemption visibly counts the
 * balance DOWN instead of snapping.
 */
function AnimatedBalance({ value, color }: { value: number; color: string }) {
  const animated = useSharedValue(value);
  const [displayed, setDisplayed] = useState(value);
  const lastValueRef = useRef(value);

  useEffect(() => {
    if (lastValueRef.current === value) return;
    animated.value = lastValueRef.current;
    animated.value = withTiming(value, { duration: 650, easing: Easing.out(Easing.cubic) });
    lastValueRef.current = value;
    // Drive setDisplayed off requestAnimationFrame so reanimated
    // doesn't clobber the JS-side text. We sample the shared value
    // ~16ms per tick. Cleared on unmount or re-fire.
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
    <Text
      style={{
        color,
        fontSize: 64,
        fontWeight: '800',
        lineHeight: 70,
        letterSpacing: -1,
      }}
    >
      {displayed}
    </Text>
  );
}

/** Vertical S-curve between two points, alternating left/right of center. */
function buildSCurvePath(
  nodes: Array<{ x: number; y: number }>,
): string {
  if (nodes.length === 0) return '';
  let path = `M ${nodes[0].x} ${nodes[0].y}`;
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const cur = nodes[i];
    const midY = (prev.y + cur.y) / 2;
    // Bezier control points pull the curve sideways so the path
    // S-swings between nodes rather than zig-zagging linearly.
    path += ` C ${prev.x} ${midY}, ${cur.x} ${midY}, ${cur.x} ${cur.y}`;
  }
  return path;
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

export default function RewardsScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { merchantId } = useMerchant();
  const { user } = useAuth();
  const { primaryColor, backgroundColor, menuCardColor, textColor } = useMerchantBranding();
  const { products: menuProducts } = useMenuContext();
  const { addToCart } = useCart();
  const isArabic = i18n.language === 'ar';

  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<MilestoneRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Local "just redeemed" set — milestone IDs that the user has redeemed
   * this session. Used for the green-checkmark flash so the UI confirms
   * the redemption even before the balance number animates down. Cleared
   * after 2.5 s per id so a second redemption of the same milestone
   * re-animates fresh.
   */
  const [recentRedeems, setRecentRedeems] = useState<Set<string>>(new Set());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  // Cleanup toast timer on unmount
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  /** Stale-while-revalidate balance load. */
  const refreshBalance = useCallback(async () => {
    if (!user?.id || !merchantId) return;
    try {
      const b = await loyaltyApi.getBalance(user.id, merchantId);
      setBalance(b);
      const key = loyaltyCacheKey(merchantId, user.id);
      const prev = await readCache<LoyaltyCache>(key);
      await writeCache<LoyaltyCache>(key, {
        balance: b,
        transactions: prev?.transactions ?? [],
        rewards: prev?.rewards ?? [],
      });
    } catch {
      // best-effort — keep whatever the cache had
    }
  }, [user?.id, merchantId]);

  useEffect(() => {
    if (!user?.id || !merchantId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const key = loyaltyCacheKey(merchantId, user.id);
    readCache<LoyaltyCache>(key).then((cached) => {
      if (cancelled) return;
      if (cached?.balance) {
        setBalance(cached.balance);
        setLoading(false);
      }
    });
    refreshBalance().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id, merchantId, refreshBalance]);

  const points = balance?.points ?? 0;
  const lifetimePoints = balance?.lifetimePoints ?? 0;

  /** Catalog of milestone rows, sorted by points_threshold ascending. */
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

  /** SVG winding path nodes — alternating left/right of center. */
  const pathLayout = useMemo(() => {
    if (milestoneRows.length === 0) return null;
    const width = 320;
    const horizontalOffset = 90; // distance from center
    const nodeSpacing = 200;
    const top = 40;
    const nodes = milestoneRows.map((row, i) => ({
      id: row.id,
      x: width / 2 + (i % 2 === 0 ? -horizontalOffset : horizontalOffset),
      y: top + i * nodeSpacing,
    }));
    const path = buildSCurvePath(nodes);
    const height = top + (milestoneRows.length - 1) * nodeSpacing + 120;
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

    // Update local balance immediately from the response (the server
    // is the source of truth; we don't subtract locally and hope).
    setBalance((prev) =>
      prev ? { ...prev, points: result!.newBalance } : prev,
    );

    // Add the reward's foodics products to the cart as 0-priced
    // reward items, same pattern the legacy stamps flow used so
    // checkout/server reward-floor exemption recognises them.
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
        rewardOriginalPriceSar: typeof product.price === 'number' ? product.price : 0,
      });
    }

    // Flash a checkmark on the milestone for 2.5 s.
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
    // Refresh from server so lifetime + history are fresh too.
    void refreshBalance();
  }, [
    confirmTarget,
    user?.id,
    merchantId,
    isArabic,
    addToCart,
    menuProducts,
    refreshBalance,
    showToast,
  ]);

  const hasAnyMilestones = milestoneRows.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View
        style={{
          paddingTop: 56,
          paddingHorizontal: 20,
          paddingBottom: 24,
          backgroundColor: primaryColor,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: 'rgba(255,255,255,0.18)',
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scaleX: isArabic ? -1 : 1 }],
          }}
        >
          <ArrowLeft size={18} color="#ffffff" />
        </TouchableOpacity>
        <Text
          style={{
            color: '#ffffff',
            fontSize: 18,
            fontWeight: '700',
            flex: 1,
            textAlign: 'center',
            marginEnd: 36,
          }}
        >
          {isArabic ? 'كتالوج المكافآت' : 'Rewards Catalog'}
        </Text>
      </View>

      {/* Header points balance */}
      <View
        style={{
          backgroundColor: primaryColor,
          paddingHorizontal: 24,
          paddingBottom: 28,
          alignItems: 'center',
          borderBottomLeftRadius: 36,
          borderBottomRightRadius: 36,
        }}
      >
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600', letterSpacing: 1 }}>
          {isArabic ? 'رصيدك' : 'YOUR BALANCE'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 4 }}>
          <AnimatedBalance value={points} color="#ffffff" />
          <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600', marginStart: 8 }}>
            {isArabic ? 'نقطة' : 'pts'}
          </Text>
        </View>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 6 }}>
          {isArabic
            ? `العمر الإجمالي: ${lifetimePoints} نقطة مكتسبة`
            : `Lifetime: ${lifetimePoints} points earned`}
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : !hasAnyMilestones ? (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 40,
          }}
        >
          <View
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              backgroundColor: `${primaryColor}20`,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
            }}
          >
            <Sparkles size={42} color={primaryColor} />
          </View>
          <Text
            style={{
              color: textColor,
              fontWeight: '700',
              fontSize: 18,
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            {isArabic ? 'لا توجد مكافآت بعد' : 'No rewards yet'}
          </Text>
          <Text style={{ color: textColor, opacity: 0.6, textAlign: 'center' }}>
            {isArabic
              ? 'هذا المتجر لم يضف مكافآت إلى الكتالوج بعد. تابع لتجميع النقاط!'
              : 'This merchant hasn’t added any rewards yet. Keep earning points!'}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingTop: 28, paddingBottom: 80, paddingHorizontal: 12, alignItems: 'center' }}
          showsVerticalScrollIndicator={false}
        >
          {pathLayout && (
            <View style={{ width: pathLayout.width, height: pathLayout.height, position: 'relative' }}>
              {/* The winding S-curve path itself. Rendered behind the
                  nodes so the line passes through every node center. */}
              <Svg
                width={pathLayout.width}
                height={pathLayout.height}
                style={{ position: 'absolute', top: 0, left: 0 }}
              >
                <Path
                  d={pathLayout.path}
                  stroke={`${primaryColor}40`}
                  strokeWidth={10}
                  fill="none"
                  strokeLinecap="round"
                />
                <Path
                  d={pathLayout.path}
                  stroke={primaryColor}
                  strokeWidth={4}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray="2,8"
                />
              </Svg>

              {/* Milestone nodes overlaid on the path. */}
              {milestoneRows.map((row, idx) => {
                const node = pathLayout.nodes[idx];
                const NODE_SIZE = 84;
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
                      accessibilityLabel={`${row.reward_name} ${row.points_threshold} ${isArabic ? 'نقطة' : 'points'}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !row.affordable }}
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
                        shadowOffset: { width: 0, height: 4 },
                        shadowOpacity: row.affordable ? 0.18 : 0.06,
                        shadowRadius: 8,
                        elevation: row.affordable ? 6 : 2,
                        overflow: 'hidden',
                      }}
                    >
                      {row.reward_image_url ? (
                        <Image
                          source={{ uri: row.reward_image_url }}
                          style={{
                            width: '100%',
                            height: '100%',
                            opacity: row.affordable ? 1 : 0.4,
                          }}
                          resizeMode="cover"
                        />
                      ) : (
                        <Gift
                          size={32}
                          color={row.affordable ? primaryColor : '#94a3b8'}
                        />
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
                          <Lock size={26} color="#ffffff" />
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
                          <Check size={32} color="#ffffff" />
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

                    {/* Reward name */}
                    <Text
                      numberOfLines={1}
                      style={{
                        marginTop: 8,
                        fontSize: 12,
                        fontWeight: '700',
                        color: textColor,
                        opacity: row.affordable ? 1 : 0.55,
                        textAlign: 'center',
                        maxWidth: 132,
                      }}
                    >
                      {row.reward_name || (isArabic ? 'مكافأة' : 'Reward')}
                    </Text>

                    {/* Cost pill */}
                    <View
                      style={{
                        marginTop: 4,
                        paddingHorizontal: 10,
                        paddingVertical: 3,
                        borderRadius: 12,
                        backgroundColor: row.affordable ? primaryColor : '#e2e8f0',
                      }}
                    >
                      <Text
                        style={{
                          color: row.affordable ? '#ffffff' : '#64748b',
                          fontSize: 11,
                          fontWeight: '700',
                        }}
                      >
                        {row.points_threshold} {isArabic ? 'نقطة' : 'pts'}
                      </Text>
                    </View>

                    {!row.affordable && (
                      <Text
                        style={{
                          marginTop: 2,
                          fontSize: 10,
                          color: textColor,
                          opacity: 0.5,
                          textAlign: 'center',
                          maxWidth: 120,
                        }}
                        numberOfLines={2}
                      >
                        {isArabic
                          ? `يلزم ${row.pointsShort} نقطة`
                          : `Need ${row.pointsShort} more`}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
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

            <Text
              style={{
                color: textColor,
                fontSize: 18,
                fontWeight: '700',
                textAlign: 'center',
                marginBottom: 6,
              }}
            >
              {isArabic
                ? `استبدال ${confirmTarget?.reward_name ?? ''}؟`
                : `Redeem ${confirmTarget?.reward_name ?? ''}?`}
            </Text>
            <Text
              style={{ color: textColor, opacity: 0.7, textAlign: 'center', marginBottom: 18 }}
            >
              {isArabic
                ? `سيتم خصم ${confirmTarget?.points_threshold ?? 0} نقطة من رصيدك.`
                : `${confirmTarget?.points_threshold ?? 0} points will be deducted from your balance.`}
            </Text>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => setConfirmTarget(null)}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 14,
                  backgroundColor: '#f1f5f9',
                  alignItems: 'center',
                }}
                activeOpacity={0.8}
              >
                <Text style={{ color: '#475569', fontWeight: '700' }}>
                  {isArabic ? 'إلغاء' : 'Cancel'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleConfirmRedeem}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 14,
                  backgroundColor: primaryColor,
                  alignItems: 'center',
                }}
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
    </View>
  );
}
