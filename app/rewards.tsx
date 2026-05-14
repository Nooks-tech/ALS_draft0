/**
 * Stand-alone rewards screen. Opens from the menu page's circular
 * rewards button. Lets the customer redeem stamp milestones WITHOUT
 * adding regular menu items first — the redeemed milestone's free
 * items go into the cart as zero-priced line items, just like a
 * normal order. Whether they then add menu items on top or check
 * out with just the rewards is their choice.
 *
 * Layout:
 *   - Header (back arrow + title)
 *   - Compact stamp counter at top (boxes only, no full loyalty card)
 *   - Scrollable milestone list, each with reward name, sub-text,
 *     and the Foodics product images (side-by-side if multiple)
 *   - Tap a redeemable milestone -> adds its products to cart as
 *     reward items + flashes a "Added!" state. Locked milestones
 *     show "Need N more stamps" and are tappable but non-functional.
 *   - Bottom button -> go to cart to checkout.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Gift, Lock, ShoppingCart, Star } from 'lucide-react-native';
import { useAuth } from '../src/context/AuthContext';
import { useCart } from '../src/context/CartContext';
import { useMenuContext } from '../src/context/MenuContext';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { loyaltyApi, type LoyaltyBalance } from '../src/api/loyalty';

function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  const aHex = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${m[1]}${aHex}`;
}

/**
 * Compact stamp counter — just the box grid, no card chrome / QR / logo.
 * Mirrors the StampGrid from app/(tabs)/offers.tsx but kept inline so the
 * rewards screen doesn't depend on the offers tab.
 */
function CompactStampGrid({
  stampTarget,
  stamps,
  boxColor,
  iconColor,
  iconUrl,
  iconScalePercent,
}: {
  stampTarget: number;
  stamps: number;
  boxColor: string;
  iconColor: string;
  iconUrl: string | null;
  iconScalePercent: number | null;
}) {
  const total = Math.max(1, Math.min(20, Math.round(stampTarget)));
  const filled = Math.max(0, Math.min(total, Math.round(stamps)));
  const cols = total <= 5 ? total : Math.ceil(total / 2);
  const emptyBg = hexWithAlpha(boxColor, 0.22);
  const cellWidthPct = `${100 / cols}%` as const;
  const iconFrac = Math.max(0.6, Math.min(1.4, (iconScalePercent ?? 100) / 100));
  const uploadedIconSize = `${Math.round(55 * iconFrac)}%` as const;
  const defaultIconSize = Math.max(10, Math.min(40, Math.floor(200 / cols) * iconFrac));

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 }}>
      {Array.from({ length: total }).map((_, i) => {
        const isFilled = i < filled;
        return (
          <View key={i} style={{ width: cellWidthPct, paddingHorizontal: 4, paddingVertical: 4 }}>
            <View
              style={{
                aspectRatio: 1,
                borderRadius: 14,
                backgroundColor: isFilled ? boxColor : emptyBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {iconUrl ? (
                <Image
                  source={{ uri: iconUrl }}
                  style={{ width: uploadedIconSize, height: uploadedIconSize, opacity: isFilled ? 1 : 0.35 }}
                  resizeMode="contain"
                />
              ) : (
                <Star
                  size={defaultIconSize}
                  color={iconColor}
                  fill={iconColor}
                  style={{ opacity: isFilled ? 1 : 0.35 }}
                />
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export default function RewardsScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { merchantId } = useMerchant();
  const { user } = useAuth();
  const { primaryColor, backgroundColor, menuCardColor, textColor } = useMerchantBranding();
  const { products: menuProducts } = useMenuContext();
  const { cartItems, addToCart, removeFromCart, totalItems } = useCart();
  const isArabic = i18n.language === 'ar';

  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id || !merchantId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loyaltyApi
      .getBalance(user.id, merchantId)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        // best effort
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, merchantId]);

  // Derive which milestones are currently selected from cart items.
  // Reward items in the cart carry a rewardMilestoneId tag; the set
  // of those tag values IS the selected-milestones set.
  const selectedMilestoneIds = useMemo(() => {
    const s = new Set<string>();
    for (const ci of cartItems) {
      if (ci.rewardMilestoneId) s.add(ci.rewardMilestoneId);
    }
    return s;
  }, [cartItems]);

  // Stamps committed to already-selected milestones — used to disable
  // additional selections that would exceed the balance.
  const usedBudget = useMemo(() => {
    if (!balance) return 0;
    let used = 0;
    for (const id of selectedMilestoneIds) {
      const m = balance.stampMilestones.find((x) => x.id === id);
      if (m) used += m.stamp_number;
    }
    return used;
  }, [balance, selectedMilestoneIds]);

  // Build the milestone list with redeem state + product previews.
  const milestoneRows = useMemo(() => {
    if (!balance) return [];
    return [...balance.stampMilestones]
      .sort((a, b) => a.stamp_number - b.stamp_number)
      .map((m) => {
        const products = (m.foodics_product_ids ?? [])
          .map((fid) => menuProducts.find((p) => p.foodicsProductId === fid))
          .filter((p): p is NonNullable<typeof p> => !!p);
        const selected = selectedMilestoneIds.has(m.id);
        const remainingBudget = balance.stamps - usedBudget;
        const budgetBlocked = !selected && m.stamp_number > remainingBudget;
        return {
          id: m.id,
          reward_name: m.reward_name,
          stamp_number: m.stamp_number,
          products,
          redeemable: balance.stamps >= m.stamp_number,
          selected,
          budgetBlocked,
        };
      });
  }, [balance, menuProducts, selectedMilestoneIds, usedBudget]);

  const handleRedeem = (row: (typeof milestoneRows)[number]) => {
    if (!row.redeemable || row.budgetBlocked) return;
    // Add the milestone's product(s) to the cart as zero-priced
    // line items, tagged with rewardMilestoneId so checkout + cart
    // know they're rewards, not regular paid items.
    for (const product of row.products) {
      if (!product.foodicsProductId) continue;
      addToCart({
        id: product.id,
        name: `🎁 ${product.name}`,
        price: 0,
        basePrice: 0,
        image: product.image ?? '',
        customizations: null,
        uniqueId: `reward-${row.id}-${product.foodicsProductId}`,
        rewardMilestoneId: row.id,
      });
    }
  };

  const handleUnredeem = (row: (typeof milestoneRows)[number]) => {
    if (!row.selected) return;
    for (const product of row.products) {
      if (!product.foodicsProductId) continue;
      removeFromCart({ uniqueId: `reward-${row.id}-${product.foodicsProductId}` });
    }
  };

  // Stamp-card styling — read from loyalty balance with sensible defaults.
  const stampTarget = Math.max(1, balance?.stampTarget ?? 8);
  const stamps = Math.max(0, Math.min(stampTarget, balance?.stamps ?? 0));
  const boxColor = balance?.walletStampBoxColor || primaryColor || '#10B981';
  const iconColor = balance?.walletStampIconColor || '#FFFFFF';
  const iconUrl = balance?.walletStampIconUrl || null;
  const iconScale = balance?.walletStampIconScale ?? null;

  const hasAnyMilestones = milestoneRows.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View
        style={{
          paddingTop: 56,
          paddingHorizontal: 20,
          paddingBottom: 16,
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
          {isArabic ? 'مكافآت الأختام' : 'Stamp Rewards'}
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : !hasAnyMilestones ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
          <Gift size={48} color="#94a3b8" />
          <Text style={{ color: '#64748b', marginTop: 12, textAlign: 'center' }}>
            {isArabic
              ? 'لم يحدد المتجر مكافآت ختم بعد.'
              : 'This store has no stamp rewards yet.'}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Compact stamp counter at top — just the boxes, no card chrome. */}
          <View
            style={{
              backgroundColor: menuCardColor,
              borderRadius: 24,
              padding: 16,
              marginBottom: 20,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ color: textColor, fontWeight: '700', flex: 1 }}>
                {isArabic ? `لديك ${stamps} ختم` : `You have ${stamps} stamp${stamps === 1 ? '' : 's'}`}
              </Text>
              <Text style={{ color: textColor, opacity: 0.6, fontSize: 12 }}>
                {isArabic ? `من أصل ${stampTarget}` : `of ${stampTarget}`}
              </Text>
            </View>
            <CompactStampGrid
              stampTarget={stampTarget}
              stamps={stamps}
              boxColor={boxColor}
              iconColor={iconColor}
              iconUrl={iconUrl}
              iconScalePercent={iconScale}
            />
          </View>

          {/* Milestone list */}
          {milestoneRows.map((row) => {
            const stampsShort = Math.max(0, row.stamp_number - stamps);
            const subText = row.selected
              ? isArabic ? 'تمت إضافته إلى السلة' : 'Added to cart'
              : row.budgetBlocked
                ? isArabic ? 'الرصيد المتبقي غير كافٍ' : 'Not enough stamps left'
                : row.redeemable
                  ? isArabic ? `يستهلك ${row.stamp_number} ختم` : `Uses ${row.stamp_number} stamp${row.stamp_number === 1 ? '' : 's'}`
                  : isArabic ? `يلزم ${stampsShort} ختم إضافي` : `Need ${stampsShort} more stamp${stampsShort === 1 ? '' : 's'}`;
            const dim = (!row.redeemable || row.budgetBlocked) && !row.selected;

            return (
              <View
                key={row.id}
                style={{
                  backgroundColor: menuCardColor,
                  borderRadius: 24,
                  padding: 16,
                  marginBottom: 14,
                  borderWidth: row.selected ? 2 : 0,
                  borderColor: row.selected ? primaryColor : 'transparent',
                  opacity: dim ? 0.55 : 1,
                }}
              >
                {/* Product images — side-by-side if multiple */}
                {row.products.length > 0 ? (
                  <View style={{ flexDirection: 'row', marginBottom: 12, gap: 8 }}>
                    {row.products.map((p, idx) => (
                      <View
                        key={`${p.id}-${idx}`}
                        style={{
                          flex: 1,
                          aspectRatio: row.products.length === 1 ? 16 / 9 : 1,
                          borderRadius: 16,
                          backgroundColor: '#e2e8f0',
                          overflow: 'hidden',
                        }}
                      >
                        {p.image ? (
                          <Image source={{ uri: p.image }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                        ) : (
                          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                            <Gift size={32} color="#94a3b8" />
                          </View>
                        )}
                      </View>
                    ))}
                  </View>
                ) : null}

                {/* Reward name + sub-text */}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 16,
                      backgroundColor: row.redeemable ? `${primaryColor}25` : '#f1f5f9',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginEnd: 10,
                    }}
                  >
                    {row.redeemable ? (
                      <Gift size={16} color={primaryColor} />
                    ) : (
                      <Lock size={14} color="#94a3b8" />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: textColor, fontWeight: '700', fontSize: 16 }}>
                      {row.reward_name || (isArabic ? 'مكافأة' : 'Reward')}
                    </Text>
                    <Text style={{ color: textColor, opacity: 0.6, fontSize: 12, marginTop: 2 }}>
                      {subText}
                    </Text>
                  </View>
                </View>

                {/* Action button */}
                {row.selected ? (
                  <TouchableOpacity
                    onPress={() => handleUnredeem(row)}
                    style={{
                      paddingVertical: 12,
                      borderRadius: 16,
                      alignItems: 'center',
                      backgroundColor: '#fee2e2',
                      flexDirection: 'row',
                      justifyContent: 'center',
                    }}
                    activeOpacity={0.7}
                  >
                    <Check size={16} color="#b91c1c" style={{ marginEnd: 6 }} />
                    <Text style={{ color: '#b91c1c', fontWeight: '700' }}>
                      {isArabic ? 'إلغاء الاستبدال' : 'Cancel redemption'}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    onPress={() => handleRedeem(row)}
                    disabled={!row.redeemable || row.budgetBlocked}
                    style={{
                      paddingVertical: 12,
                      borderRadius: 16,
                      alignItems: 'center',
                      backgroundColor: row.redeemable && !row.budgetBlocked ? primaryColor : '#e2e8f0',
                      flexDirection: 'row',
                      justifyContent: 'center',
                    }}
                    activeOpacity={0.7}
                  >
                    <Gift
                      size={16}
                      color={row.redeemable && !row.budgetBlocked ? '#ffffff' : '#94a3b8'}
                      style={{ marginEnd: 6 }}
                    />
                    <Text
                      style={{
                        color: row.redeemable && !row.budgetBlocked ? '#ffffff' : '#94a3b8',
                        fontWeight: '700',
                      }}
                    >
                      {row.redeemable
                        ? row.budgetBlocked
                          ? isArabic ? 'الرصيد غير كافٍ' : 'Not enough stamps'
                          : isArabic ? 'استبدال' : 'Redeem'
                        : isArabic
                          ? 'مقفل'
                          : 'Locked'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Bottom CTA. Shows when EITHER the cart has regular items OR
          the customer has selected at least one reward — so a
          rewards-only order can also proceed to checkout. */}
      {(totalItems > 0 || selectedMilestoneIds.size > 0) && (
        <View
          style={{
            position: 'absolute',
            left: 20,
            right: 20,
            bottom: 32,
          }}
        >
          <TouchableOpacity
            onPress={() => router.push((totalItems > 0 ? '/cart' : '/checkout') as never)}
            style={{
              paddingVertical: 16,
              borderRadius: 28,
              alignItems: 'center',
              backgroundColor: primaryColor,
              flexDirection: 'row',
              justifyContent: 'center',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.2,
              shadowRadius: 16,
              elevation: 8,
            }}
            activeOpacity={0.85}
          >
            <ShoppingCart size={18} color="#ffffff" style={{ marginEnd: 8 }} />
            <Text style={{ color: '#ffffff', fontWeight: '700', fontSize: 16 }}>
              {totalItems > 0
                ? isArabic
                  ? `عرض السلة (${totalItems})`
                  : `View cart (${totalItems})`
                : isArabic
                  ? `الذهاب للدفع (${selectedMilestoneIds.size} مكافأة)`
                  : `Checkout (${selectedMilestoneIds.size} reward${selectedMilestoneIds.size === 1 ? '' : 's'})`}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
