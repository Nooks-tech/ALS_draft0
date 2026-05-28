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
import { loyaltyApi, type LoyaltyBalance } from '../../api/loyalty';
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
    } finally {
      setLoading(false);
    }
  }, [merchantId, user?.id]);

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
            pointsValue={pointsValue}
            lifetimeValue={lifetimeValue}
            colors={colors}
            isArabic={isArabic}
            brandTitle={brandTitle}
            logoUrl={logoUrl}
            merchantId={merchantId}
            userId={user?.id ?? null}
            onOpenRoadmap={() => router.push('/rewards' as never)}
            signedIn={!!user?.id}
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
  pointsValue,
  lifetimeValue,
  colors,
  isArabic,
  brandTitle,
  logoUrl,
  merchantId,
  userId,
  onOpenRoadmap,
  signedIn,
}: {
  balance: LoyaltyBalance | null;
  pointsValue: number;
  lifetimeValue: number;
  colors: ReturnType<typeof resolvePolaroidColors>;
  isArabic: boolean;
  brandTitle: string;
  logoUrl: string | null;
  merchantId: string | null;
  userId: string | null;
  onOpenRoadmap: () => void;
  signedIn: boolean;
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

      {/* Wallet pass preview — looks like the actual pass laid on
          the kraft board, so the merchant can see what they're
          adding before they tap. */}
      <View style={{ marginBottom: 16 }}>
        <PolaroidCard
          rotation="0.8deg"
          large
          surfaceColor={colors.accent}
          style={{ padding: 14 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            {logoUrl ? (
              <Image
                source={{ uri: logoUrl }}
                style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: '#ffffff22', marginEnd: 10 }}
                resizeMode="contain"
              />
            ) : null}
            <View style={{ flex: 1 }}>
              <MonoText size={9} tracking={2} uppercase weight="700" color="#ffffff" style={{ opacity: 0.7 }}>
                {isArabic ? 'بطاقة الولاء' : 'Loyalty Pass'}
              </MonoText>
              <MonoText size={13} weight="800" color="#ffffff" numberOfLines={1}>
                {brandTitle}
              </MonoText>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <View>
              <MonoText size={8} tracking={2} uppercase color="#ffffff" style={{ opacity: 0.7 }}>
                {isCashback ? (isArabic ? 'الرصيد' : 'Balance') : (isArabic ? 'النقاط' : 'Points')}
              </MonoText>
              <MonoText size={22} weight="800" color="#ffffff" style={{ marginTop: 2 }}>
                {isCashback
                  ? `${(balance?.cashbackBalance ?? 0).toFixed(0)}`
                  : pointsValue}
              </MonoText>
            </View>
            {/* Barcode placeholder bars — purely cosmetic. The real
                wallet pass renders an actual scannable code. */}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 32 }}>
              {[3, 1, 2, 1, 4, 2, 1, 3, 2, 1, 3].map((w, i) => (
                <View
                  key={i}
                  style={{
                    width: w,
                    height: '100%',
                    backgroundColor: '#ffffff',
                    marginEnd: 1,
                    opacity: 0.85,
                  }}
                />
              ))}
            </View>
          </View>
        </PolaroidCard>
      </View>

      {/* Real Apple Wallet add — native PKAddPassButton via the
          same hook the classic offers screen uses, so the pass is
          guaranteed to render correctly. iOS dedupes by pass type
          id + serial, so tapping after the pass is already added
          just re-opens it; tapping after deletion adds it back. */}
      {walletAvailable && userId && merchantId && Platform.OS === 'ios' && (
        <View style={{ marginBottom: 14 }}>
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
              {isArabic
                ? 'احتفظ ببطاقتك في جوالك'
                : 'Keep your card on your phone'}
            </MonoText>
          </PolaroidCard>
        </View>
      )}

      {/* Rewards roadmap shortcut */}
      <View style={{ marginBottom: 14 }}>
        <PolaroidCard
          rotation="1deg"
          large
          style={{ paddingVertical: 12, paddingHorizontal: 16 }}
        >
          <TouchableOpacity activeOpacity={0.85} onPress={onOpenRoadmap}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  backgroundColor: colors.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginEnd: 12,
                }}
              >
                <MonoText size={16} color="#ffffff">★</MonoText>
              </View>
              <View style={{ flex: 1 }}>
                <MonoText size={11} tracking={1.5} uppercase weight="800" color={colors.textOnSurface}>
                  {isArabic ? 'مسار المكافآت' : 'Rewards roadmap'}
                </MonoText>
                <MonoText size={9} color={`${colors.textOnSurface}77`} style={{ marginTop: 2 }}>
                  {isArabic
                    ? 'تتبع كل معلم في طريقك'
                    : 'See every milestone on the way'}
                </MonoText>
              </View>
              <MonoText size={16} color={`${colors.textOnSurface}77`}>›</MonoText>
            </View>
          </TouchableOpacity>
        </PolaroidCard>
      </View>
    </>
  );
}
