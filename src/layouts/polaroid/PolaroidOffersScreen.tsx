/**
 * Polaroid offers screen.
 *
 * Two segments:
 *  - Promos: banner + promo polaroid cards (the discount images
 *    and codes), nothing loyalty-related.
 *  - Loyalty: points balance polaroid + Apple Wallet pass preview
 *    + the Add-to-Apple-Wallet CTA. Tapping the CTA routes to
 *    /loyalty-modal which holds the actual PKPass add flow.
 *
 * Heavy data lifting is delegated to the same fetchers the classic
 * offers.tsx uses (banners / promos / loyalty balance).
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  I18nManager,
  Image,
  Platform,
  RefreshControl,
  ScrollView,
  StatusBar,
  TouchableOpacity,
  View,
} from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../../api/nooksBanners';
import { fetchNooksPromos } from '../../api/nooksPromos';
import { loyaltyApi, type LoyaltyBalance, type LoyaltyReward } from '../../api/loyalty';
import { useAuth } from '../../context/AuthContext';
import { useMerchant } from '../../context/MerchantContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { useAppleWalletPass } from '../../hooks/useAppleWalletPass';
import { AppleWalletAddPassButton } from '../../components/apple-wallet/AppleWalletAddPassButton';
import { MonoText, PolaroidCard } from './PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from './styles';

type OfferEntry = {
  id: string;
  image: string | null;
  title: string;
  subtitle: string;
  badge?: string | null;
};

type Segment = 'promos' | 'loyalty';

export default function PolaroidOffersScreen() {
  const { i18n } = useTranslation();
  const router = useRouter();
  const isArabic = i18n.language === 'ar' || I18nManager.isRTL;
  const { merchantId } = useMerchant();
  const { user } = useAuth();
  const { layoutColors, appName, cafeName, logoUrl } = useMerchantBranding();
  const colors = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);

  const [segment, setSegment] = useState<Segment>('promos');
  const [banners, setBanners] = useState<NooksBanner[]>([]);
  const [promos, setPromos] = useState<Array<{
    id: string; code: string; name: string; description?: string;
    valid_until?: string; image_url?: string | null; imageUrl?: string | null;
  }>>([]);
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId) {
      setLoading(false);
      return;
    }
    try {
      const [b, p] = await Promise.all([
        fetchNooksBanners(merchantId).catch(() => [] as NooksBanner[]),
        fetchNooksPromos(merchantId).catch(() => []),
      ]);
      setBanners(b);
      setPromos(p as typeof promos);

      if (user?.id) {
        try {
          const bal = await loyaltyApi.getBalance(user.id, merchantId);
          setBalance(bal);
        } catch {
          // best-effort
        }
      }
      try {
        const r = await loyaltyApi.getRewards(merchantId);
        setRewards(r.rewards ?? []);
      } catch {
        setRewards([]);
      }
    } finally {
      setLoading(false);
    }
  }, [merchantId, user?.id]);

  const handleRedeem = useCallback(async (reward: LoyaltyReward) => {
    if (!user?.id || !merchantId) return;
    if ((balance?.points ?? 0) < reward.points_cost) {
      Alert.alert(
        isArabic ? 'النقاط غير كافية' : 'Not enough points',
        isArabic
          ? `تحتاج ${reward.points_cost} نقطة ولديك ${balance?.points ?? 0}.`
          : `You need ${reward.points_cost} points; you have ${balance?.points ?? 0}.`,
      );
      return;
    }
    Alert.alert(
      isArabic ? 'استبدال المكافأة' : 'Redeem reward',
      isArabic
        ? `استبدال ${reward.points_cost} نقطة مقابل "${reward.name}"؟`
        : `Spend ${reward.points_cost} pts on "${reward.name}"?`,
      [
        { text: isArabic ? 'إلغاء' : 'Cancel', style: 'cancel' },
        {
          text: isArabic ? 'استبدال' : 'Redeem',
          onPress: async () => {
            setRedeemingId(reward.id);
            try {
              await loyaltyApi.redeemReward(user.id, reward.id, merchantId);
              const bal = await loyaltyApi.getBalance(user.id, merchantId);
              setBalance(bal);
              Alert.alert(
                isArabic ? 'تم الاستبدال' : 'Redeemed',
                isArabic ? 'اعرض هذا للموظف' : 'Show this to the cashier',
              );
            } catch {
              Alert.alert(isArabic ? 'خطأ' : 'Error', isArabic ? 'تعذر الاستبدال' : 'Could not redeem');
            } finally {
              setRedeemingId(null);
            }
          },
        },
      ],
    );
  }, [user?.id, merchantId, balance?.points, isArabic]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const offerEntries: OfferEntry[] = useMemo(() => {
    const fromBanners = banners
      .filter((b) => b.placement === 'slider')
      .map<OfferEntry>((b) => ({
        id: `banner-${b.id}`,
        image: b.image_url,
        title: b.title ?? '',
        subtitle: b.subtitle ?? '',
      }));
    const fromPromos = promos.map<OfferEntry>((p) => ({
      id: `promo-${p.id}`,
      image: p.image_url ?? p.imageUrl ?? null,
      title: p.name,
      subtitle: p.description ?? '',
      badge: p.code,
    }));
    return [...fromBanners, ...fromPromos];
  }, [banners, promos]);

  const brandTitle = appName || cafeName || 'Offers';
  const pointsValue = balance?.points ?? 0;
  const lifetimeValue = balance?.lifetimePoints ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />

      <View style={{ paddingTop: Platform.OS === 'ios' ? 58 : 36, paddingHorizontal: 18, paddingBottom: 10 }}>
        <MonoText
          size={22}
          tracking={-0.3}
          color={colors.text}
          style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}
        >
          {isArabic ? 'العروض' : `Today's Deals`}
        </MonoText>
        <MonoText
          size={9}
          tracking={1.8}
          uppercase
          color={`${colors.text}66`}
          style={{ marginTop: 2 }}
          numberOfLines={1}
        >
          {brandTitle}
        </MonoText>

        {/* Segment switcher — Promos / Loyalty */}
        <View
          style={{
            marginTop: 14,
            flexDirection: 'row',
            backgroundColor: `${colors.text}11`,
            borderRadius: 999,
            padding: 4,
            borderWidth: 1,
            borderColor: `${colors.text}1F`,
          }}
        >
          {(['promos', 'loyalty'] as const).map((key) => {
            const active = segment === key;
            return (
              <TouchableOpacity
                key={key}
                onPress={() => setSegment(key)}
                activeOpacity={0.8}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 999,
                  backgroundColor: active ? colors.accent : 'transparent',
                  alignItems: 'center',
                }}
              >
                <MonoText
                  size={10}
                  tracking={2}
                  uppercase
                  weight="800"
                  color={active ? '#ffffff' : `${colors.text}88`}
                >
                  {key === 'promos'
                    ? (isArabic ? 'العروض' : 'Promos')
                    : (isArabic ? 'الولاء' : 'Loyalty')}
                </MonoText>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 14,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 130 : 110,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.text}
            colors={[colors.accent]}
          />
        }
      >
        {segment === 'promos' ? (
          <PromosTab
            loading={loading}
            entries={offerEntries}
            colors={colors}
            isArabic={isArabic}
          />
        ) : (
          <LoyaltyTab
            balance={balance}
            rewards={rewards}
            redeemingId={redeemingId}
            pointsValue={pointsValue}
            lifetimeValue={lifetimeValue}
            colors={colors}
            isArabic={isArabic}
            merchantId={merchantId}
            userId={user?.id ?? null}
            signedIn={!!user?.id}
            onRedeem={handleRedeem}
          />
        )}
      </ScrollView>
    </View>
  );
}

/* ─────────────────────────── Promos tab ─────────────────────────── */

function PromosTab({
  loading,
  entries,
  colors,
  isArabic,
}: {
  loading: boolean;
  entries: OfferEntry[];
  colors: ReturnType<typeof resolvePolaroidColors>;
  isArabic: boolean;
}) {
  if (loading && entries.length === 0) {
    return (
      <View style={{ paddingVertical: 60, alignItems: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (entries.length === 0) {
    return (
      <View style={{ paddingVertical: 60, alignItems: 'center' }}>
        <MonoText size={11} tracking={1.5} uppercase color={`${colors.text}66`}>
          {isArabic ? 'لا توجد عروض الآن' : 'No promos right now'}
        </MonoText>
      </View>
    );
  }
  return (
    <>
      {entries.map((offer, idx) => (
        <View key={offer.id} style={{ marginBottom: 16 }}>
          <PolaroidCard
            rotation={rotationForIndex(idx + 1)}
            large
            style={{ padding: 6, paddingBottom: 16 }}
          >
            {/* Bounded image — `cover` + a fixed aspect ratio so
                wide source images don't blow out the polaroid frame
                (was causing the cropped "Versio…" text earlier). */}
            {offer.image ? (
              <Image
                source={{ uri: offer.image }}
                style={{
                  width: '100%',
                  aspectRatio: 4 / 3,
                  backgroundColor: '#e7e2d6',
                  borderRadius: 2,
                }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  width: '100%',
                  aspectRatio: 4 / 3,
                  backgroundColor: colors.stampRed,
                  borderRadius: 2,
                }}
              />
            )}
            {!!offer.title && (
              <MonoText
                size={13}
                tracking={0.4}
                weight="700"
                align="center"
                color={colors.textOnSurface}
                style={{ marginTop: 10, paddingHorizontal: 8 }}
                numberOfLines={2}
              >
                {offer.title}
              </MonoText>
            )}
            {!!offer.subtitle && (
              <MonoText
                size={10}
                tracking={0.4}
                align="center"
                color={`${colors.textOnSurface}88`}
                style={{ marginTop: 4, paddingHorizontal: 8 }}
                numberOfLines={3}
              >
                {offer.subtitle}
              </MonoText>
            )}
            {!!offer.badge && (
              <View style={{ alignItems: 'center', marginTop: 8 }}>
                <View
                  style={{
                    backgroundColor: colors.stampRed,
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                    borderRadius: 2,
                  }}
                >
                  <MonoText
                    size={11}
                    tracking={2.2}
                    uppercase
                    weight="800"
                    color="#ffffff"
                  >
                    {offer.badge}
                  </MonoText>
                </View>
              </View>
            )}
          </PolaroidCard>
        </View>
      ))}
    </>
  );
}

/* ─────────────────────────── Loyalty tab ─────────────────────────── */

function LoyaltyTab({
  balance,
  rewards,
  redeemingId,
  pointsValue,
  lifetimeValue,
  colors,
  isArabic,
  merchantId,
  userId,
  signedIn,
  onRedeem,
}: {
  balance: LoyaltyBalance | null;
  rewards: LoyaltyReward[];
  redeemingId: string | null;
  pointsValue: number;
  lifetimeValue: number;
  colors: ReturnType<typeof resolvePolaroidColors>;
  isArabic: boolean;
  merchantId: string | null;
  userId: string | null;
  signedIn: boolean;
  onRedeem: (r: LoyaltyReward) => void;
}) {
  const { available: walletAvailable, loading: walletLoading, addPass } = useAppleWalletPass({
    merchantId,
    userId,
    configUpdatedAt: balance?.configUpdatedAt ?? null,
  });
  if (!signedIn) {
    return (
      <View style={{ paddingVertical: 60, alignItems: 'center' }}>
        <MonoText size={11} tracking={1.5} uppercase color={`${colors.text}66`} align="center">
          {isArabic ? 'سجل الدخول لعرض ولاؤك' : 'Sign in to view your loyalty'}
        </MonoText>
      </View>
    );
  }
  const isCashback = balance?.loyaltyType === 'cashback';

  return (
    <>
      {/* Points / cashback balance polaroid */}
      <View style={{ marginBottom: 16 }}>
        <PolaroidCard rotation="-1.2deg" large style={{ paddingVertical: 18, paddingHorizontal: 18 }}>
          <MonoText
            size={9}
            tracking={2}
            uppercase
            weight="700"
            align="center"
            color={`${colors.textOnSurface}80`}
          >
            {isCashback
              ? (isArabic ? 'كاش باك' : 'Cashback')
              : (isArabic ? 'نقاطك' : 'Your Points')}
          </MonoText>
          <MonoText
            size={isCashback ? 28 : 36}
            tracking={-0.5}
            weight="800"
            align="center"
            color={colors.textOnSurface}
            style={{ marginTop: 4 }}
          >
            {isCashback
              ? `${(balance?.cashbackBalance ?? 0).toFixed(2)} ${isArabic ? 'ر.س' : 'SAR'}`
              : pointsValue}
          </MonoText>
          {!isCashback && (
            <MonoText
              size={9}
              tracking={1.5}
              uppercase
              align="center"
              color={`${colors.textOnSurface}66`}
              style={{ marginTop: 4 }}
            >
              {isArabic
                ? `${lifetimeValue} نقطة مكتسبة`
                : `${lifetimeValue} lifetime`}
            </MonoText>
          )}
        </PolaroidCard>
      </View>

      {/* Real Apple Wallet add — native PKAddPassButton, same flow
          as classic. Sits high so the user always sees it. */}
      {walletAvailable && userId && merchantId && Platform.OS === 'ios' && (
        <View style={{ marginBottom: 16 }}>
          <PolaroidCard
            rotation="-0.6deg"
            large
            surfaceColor={colors.surface}
            style={{ paddingVertical: 14, paddingHorizontal: 16 }}
          >
            <View style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
              {walletLoading ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <AppleWalletAddPassButton
                  style={{ width: '100%', maxWidth: 320, height: 48, alignSelf: 'center' }}
                  onWalletButtonPress={() => { void addPass(); }}
                />
              )}
            </View>
            <MonoText
              size={9}
              tracking={1.2}
              uppercase
              align="center"
              color={`${colors.textOnSurface}66`}
              style={{ marginTop: 8 }}
            >
              {isArabic ? 'احتفظ ببطاقتك في جوالك' : 'Keep your card on your phone'}
            </MonoText>
          </PolaroidCard>
        </View>
      )}

      {/* Stamp milestones — only for stamps loyalty type. Same
          data shape as classic: balance.stampMilestones[]. */}
      {balance?.loyaltyType === 'stamps' && (balance?.stampMilestones?.length ?? 0) > 0 && (
        <View style={{ marginBottom: 18 }}>
          <MonoText
            size={11}
            tracking={2}
            uppercase
            weight="800"
            color={colors.text}
            style={{ marginHorizontal: 4, marginBottom: 10 }}
          >
            {isArabic ? 'المعالم' : 'Milestones'}
          </MonoText>
          <PolaroidCard rotation="0.5deg" large style={{ padding: 14 }}>
            {(balance?.stampMilestones ?? [])
              .filter((m) => (m.reward_name || '').trim().length > 0)
              .slice()
              .sort((a, b) => a.stamp_number - b.stamp_number)
              .map((m) => {
                const filled = (balance?.stamps ?? 0) >= m.stamp_number;
                return (
                  <View
                    key={m.stamp_number}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 8,
                      borderBottomWidth: 1,
                      borderBottomColor: `${colors.textOnSurface}11`,
                    }}
                  >
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 999,
                        backgroundColor: filled ? colors.accent : `${colors.textOnSurface}11`,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginEnd: 12,
                      }}
                    >
                      <MonoText size={11} weight="800" color={filled ? '#ffffff' : colors.textOnSurface}>
                        {m.stamp_number}
                      </MonoText>
                    </View>
                    <MonoText
                      size={11}
                      weight="600"
                      color={filled ? colors.textOnSurface : `${colors.textOnSurface}99`}
                      style={{ flex: 1 }}
                      numberOfLines={1}
                    >
                      {m.reward_name}
                    </MonoText>
                    {filled && (
                      <MonoText size={9} tracking={1.6} uppercase weight="800" color={colors.accent}>
                        {isArabic ? 'متاح' : 'Ready'}
                      </MonoText>
                    )}
                  </View>
                );
              })}
          </PolaroidCard>
        </View>
      )}

      {/* Rewards catalog — actual list of catalog rewards
          (loyaltyApi.getRewards). Same content as classic, polaroid
          chrome. Tapping a card with enough points fires onRedeem. */}
      {rewards.length > 0 && (
        <View style={{ marginBottom: 18 }}>
          <MonoText
            size={11}
            tracking={2}
            uppercase
            weight="800"
            color={colors.text}
            style={{ marginHorizontal: 4, marginBottom: 10 }}
          >
            {isArabic ? 'المكافآت' : 'Rewards Catalog'}
          </MonoText>
          {rewards.map((r, i) => {
            const affordable = (balance?.points ?? 0) >= r.points_cost;
            const isRedeeming = redeemingId === r.id;
            return (
              <View key={r.id} style={{ marginBottom: 12 }}>
                <PolaroidCard
                  rotation={rotationForIndex(i + 2)}
                  large
                  style={{ padding: 12, opacity: affordable ? 1 : 0.7 }}
                >
                  <TouchableOpacity
                    activeOpacity={0.85}
                    disabled={!affordable || isRedeeming}
                    onPress={() => onRedeem(r)}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      {r.image_url ? (
                        <Image
                          source={{ uri: r.image_url }}
                          style={{ width: 56, height: 56, marginEnd: 12, backgroundColor: '#e7e2d6' }}
                          resizeMode="cover"
                        />
                      ) : (
                        <View
                          style={{
                            width: 56,
                            height: 56,
                            marginEnd: 12,
                            backgroundColor: `${colors.accent}22`,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <MonoText size={26} color={colors.accent}>★</MonoText>
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <MonoText
                          size={12}
                          weight="700"
                          color={colors.textOnSurface}
                          numberOfLines={1}
                        >
                          {r.name}
                        </MonoText>
                        {!!r.description && (
                          <MonoText
                            size={9}
                            color={`${colors.textOnSurface}88`}
                            style={{ marginTop: 2 }}
                            numberOfLines={2}
                          >
                            {r.description}
                          </MonoText>
                        )}
                        <MonoText
                          size={10}
                          tracking={1.4}
                          uppercase
                          weight="800"
                          color={affordable ? colors.accent : `${colors.textOnSurface}66`}
                          style={{ marginTop: 4 }}
                        >
                          {r.points_cost} {isArabic ? 'نقطة' : 'pts'}
                        </MonoText>
                      </View>
                      <View
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 999,
                          backgroundColor: affordable ? colors.accent : `${colors.textOnSurface}22`,
                          minWidth: 60,
                          alignItems: 'center',
                        }}
                      >
                        {isRedeeming ? (
                          <ActivityIndicator size="small" color="#ffffff" />
                        ) : (
                          <MonoText
                            size={9}
                            tracking={1.4}
                            uppercase
                            weight="800"
                            color={affordable ? '#ffffff' : colors.textOnSurface}
                          >
                            {affordable ? (isArabic ? 'استبدل' : 'Redeem') : (isArabic ? 'مقفل' : 'Locked')}
                          </MonoText>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>
                </PolaroidCard>
              </View>
            );
          })}
        </View>
      )}
    </>
  );
}
