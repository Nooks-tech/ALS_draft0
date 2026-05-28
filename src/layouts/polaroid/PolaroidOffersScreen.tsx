/**
 * Polaroid offers screen.
 *
 * Layout (matches `.po-offer-*` classes):
 *  - dark kraft background
 *  - large white polaroid card per offer, rotated -0.8deg
 *    with a 4:3 image up top, mono caption below, terracotta
 *    discount badge
 *  - "Your points" balance card in mono caps
 *  - terracotta polaroid CTA for Add to Apple Wallet
 *
 * Heavy lifting (banner / promo / loyalty fetches) is handled by
 * the same APIs the classic offers.tsx uses. We just intercept
 * the rendering layer.
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
import { MonoText, PolaroidCard } from './PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from './styles';

type OfferEntry = {
  id: string;
  image: string | null;
  title: string;
  subtitle: string;
  badge?: string | null;
};

export default function PolaroidOffersScreen() {
  const { i18n } = useTranslation();
  const router = useRouter();
  const isArabic = i18n.language === 'ar' || I18nManager.isRTL;
  const { merchantId } = useMerchant();
  const { user } = useAuth();
  const { layoutColors, appName, cafeName } = useMerchantBranding();
  const colors = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);

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
      // Promo entries may use either snake_case or camelCase from
      // the API normalization helper; we coerce to a flat shape
      // for rendering.
      setPromos(p as typeof promos);

      if (user?.id) {
        try {
          const bal = await loyaltyApi.getBalance(user.id, merchantId);
          setBalance(bal);
        } catch {
          // best-effort — points card is optional
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

  // -- Render -------------------------------------------------------

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />

      <View style={{ paddingTop: Platform.OS === 'ios' ? 58 : 36, paddingHorizontal: 18, paddingBottom: 8 }}>
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
        >
          {brandTitle}
        </MonoText>
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
        {/* Points balance card (only for signed-in customers) */}
        {balance && balance.loyaltyType !== 'cashback' && (
          <View style={{ marginBottom: 16 }}>
            <PolaroidCard rotation="-1.2deg" large style={{ paddingVertical: 18, paddingHorizontal: 18 }}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => router.push('/loyalty-modal' as never)}>
                <MonoText
                  size={9}
                  tracking={2}
                  uppercase
                  weight="700"
                  align="center"
                  color={`${colors.textOnSurface}80`}
                >
                  {isArabic ? 'نقاطك' : 'Your Points'}
                </MonoText>
                <MonoText
                  size={36}
                  tracking={-0.5}
                  weight="800"
                  align="center"
                  color={colors.textOnSurface}
                  style={{ marginTop: 4 }}
                >
                  {balance.points ?? 0}
                </MonoText>
                <MonoText
                  size={9}
                  tracking={1.5}
                  uppercase
                  align="center"
                  color={`${colors.textOnSurface}66`}
                  style={{ marginTop: 4 }}
                >
                  {isArabic
                    ? `${balance.lifetimePoints ?? 0} نقطة مكتسبة`
                    : `${balance.lifetimePoints ?? 0} lifetime`}
                </MonoText>
              </TouchableOpacity>
            </PolaroidCard>
          </View>
        )}

        {/* Cashback balance variant */}
        {balance && balance.loyaltyType === 'cashback' && (
          <View style={{ marginBottom: 16 }}>
            <PolaroidCard rotation="-1.2deg" large style={{ paddingVertical: 18, paddingHorizontal: 18 }}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => router.push('/loyalty-modal' as never)}>
                <MonoText
                  size={9}
                  tracking={2}
                  uppercase
                  weight="700"
                  align="center"
                  color={`${colors.textOnSurface}80`}
                >
                  {isArabic ? 'كاش باك' : 'Cashback'}
                </MonoText>
                <MonoText
                  size={28}
                  tracking={-0.3}
                  weight="800"
                  align="center"
                  color={colors.textOnSurface}
                  style={{ marginTop: 4 }}
                >
                  {(balance.cashbackBalance ?? 0).toFixed(2)} {isArabic ? 'ر.س' : 'SAR'}
                </MonoText>
              </TouchableOpacity>
            </PolaroidCard>
          </View>
        )}

        {/* Add to Apple Wallet CTA — terracotta polaroid */}
        {user?.id && balance && (
          <View style={{ marginBottom: 18 }}>
            <PolaroidCard
              rotation="0.9deg"
              large
              surfaceColor={colors.accent}
              style={{ paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' }}
            >
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => router.push('/loyalty-modal' as never)}
              >
                <MonoText
                  size={10}
                  tracking={2}
                  uppercase
                  weight="800"
                  color="#ffffff"
                  align="center"
                >
                  {isArabic ? 'أضف للمحفظة' : 'Add to Apple Wallet'}
                </MonoText>
              </TouchableOpacity>
            </PolaroidCard>
          </View>
        )}

        {/* Offers list */}
        {loading && offerEntries.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : offerEntries.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <MonoText
              size={11}
              tracking={1.5}
              uppercase
              color={`${colors.text}66`}
            >
              {isArabic ? 'لا توجد عروض الآن' : 'No offers right now'}
            </MonoText>
          </View>
        ) : (
          offerEntries.map((offer, idx) => (
            <View key={offer.id} style={{ marginBottom: 16 }}>
              <PolaroidCard
                rotation={rotationForIndex(idx + 1)}
                large
                style={{ padding: 6, paddingBottom: 16 }}
              >
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
                    style={{ marginTop: 10 }}
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
                    style={{ marginTop: 4 }}
                  >
                    {offer.subtitle}
                  </MonoText>
                )}
                {!!offer.badge && (
                  <View style={{ alignItems: 'center', marginTop: 8 }}>
                    <View
                      style={{
                        backgroundColor: colors.stampRed,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: 2,
                      }}
                    >
                      <MonoText
                        size={10}
                        tracking={2}
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
          ))
        )}
      </ScrollView>
    </View>
  );
}
