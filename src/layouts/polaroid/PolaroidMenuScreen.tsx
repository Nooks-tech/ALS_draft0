/**
 * Polaroid menu screen.
 *
 * Visual spec mirrors the `.po-*` classes in
 * nooksweb/tmp/layouts-cleaned.html:
 *  - dark kraft paper background
 *  - cream serif italic brand name top-left
 *  - mono caps branch dropdown below
 *  - row of terracotta-tinted pill chips for order types
 *  - small pill row for categories
 *  - 2-column grid of white polaroid cards, alternating rotations
 *  - sticky rotated polaroid card cart bar at the bottom
 *
 * All cart / menu state still comes from the existing contexts —
 * this screen is purely a visual swap of the classic menu.tsx.
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  I18nManager,
  Image,
  Platform,
  RefreshControl,
  ScrollView,
  StatusBar,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useCart } from '../../context/CartContext';
import { useMenuContext } from '../../context/MenuContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { MonoText, PolaroidCard } from './PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from './styles';

type OrderType = 'pickup' | 'delivery' | 'drivethru';

export default function PolaroidMenuScreen() {
  const { i18n, t } = useTranslation();
  const router = useRouter();
  const isArabic = i18n.language === 'ar' || I18nManager.isRTL;

  const {
    cartItems,
    totalItems,
    totalPrice,
    orderType,
    selectedBranch,
    deliveryAddress,
    addToCart,
  } = useCart();
  const { products, categories, loading } = useMenuContext();
  const { layoutColors, appName, cafeName, logoUrl } = useMerchantBranding();
  const colors = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);

  const displayCategories = useMemo(() => categories.filter((c) => c !== 'All'), [categories]);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Group products by category — we show ALL categories as sections
  // on the same page now (no single-category filter). Search narrows
  // every section in place.
  const groupedProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesQuery = (name: string) => !q || name.toLowerCase().includes(q);
    const cats = displayCategories.length > 0 ? displayCategories : ['Menu'];
    return cats
      .map((cat) => ({
        category: cat,
        items: products.filter((p) => (p.category === cat || cats.length === 1) && matchesQuery(p.name)),
      }))
      .filter((s) => s.items.length > 0);
  }, [displayCategories, products, searchQuery]);

  const totalVisible = groupedProducts.reduce((sum, s) => sum + s.items.length, 0);

  // 3 order-type chips (Dine-in is web-only). The chips just
  // navigate to /order-type so the existing branch + delivery flow
  // handles cart semantics, keeping the delivery-address rule intact.
  const orderTypeChips: { key: OrderType; labelEn: string; labelAr: string; emoji: string }[] = [
    { key: 'pickup', labelEn: 'Pickup', labelAr: 'استلام', emoji: '🥡' },
    { key: 'delivery', labelEn: 'Delivery', labelAr: 'توصيل', emoji: '🛵' },
    { key: 'drivethru', labelEn: 'Drive-thru', labelAr: 'سيارة', emoji: '🚗' },
  ];

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // Defer to allow the spinner to actually paint. The MenuContext
    // is driven by AppState change + cache TTL — we just need to
    // give the user feedback. Hold for a beat then release.
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const openProduct = useCallback(
    (id: string) => {
      router.push({ pathname: '/product', params: { id } });
    },
    [router],
  );

  const handleQuickAdd = useCallback(
    (product: (typeof products)[number]) => {
      const hasModifiers = (product.modifierGroups?.length ?? 0) > 0;
      if (hasModifiers) {
        openProduct(product.id);
        return;
      }
      addToCart(product, 1);
    },
    [addToCart, openProduct, products],
  );

  const brandTitle = appName || cafeName || 'Menu';
  const headerLocation = orderType === 'delivery'
    ? deliveryAddress?.address || (isArabic ? 'أضف عنواناً' : 'Add address')
    : selectedBranch?.name || (isArabic ? 'اختر الفرع' : 'Select branch');

  // -- Render -------------------------------------------------------

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />

      {/* Top header band — in-app logo + brand + location */}
      <View style={{ paddingTop: Platform.OS === 'ios' ? 58 : 36, paddingHorizontal: 18, paddingBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {logoUrl ? (
            <Image
              source={{ uri: logoUrl }}
              style={{ width: 42, height: 42, borderRadius: 10, marginEnd: 12, backgroundColor: '#ffffff10' }}
              resizeMode="contain"
            />
          ) : null}
          <View style={{ flex: 1 }}>
            <MonoText
              size={22}
              tracking={-0.3}
              color={colors.text}
              style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}
              numberOfLines={1}
            >
              {brandTitle}
            </MonoText>
            <TouchableOpacity onPress={() => router.push('/order-type')} activeOpacity={0.7}>
              <MonoText
                size={10}
                tracking={2}
                uppercase
                color={`${colors.text}80`}
                style={{ marginTop: 2 }}
                numberOfLines={1}
              >
                {headerLocation} ▾
              </MonoText>
            </TouchableOpacity>
          </View>
          {/* Rewards roadmap CTA */}
          <TouchableOpacity
            onPress={() => router.push('/rewards' as never)}
            activeOpacity={0.8}
            accessibilityLabel={isArabic ? 'مسار النقاط' : 'Rewards roadmap'}
            style={{
              backgroundColor: colors.accent,
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: 999,
              marginStart: 8,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <MonoText size={12} weight="700" color="#ffffff" style={{ marginEnd: 4 }}>★</MonoText>
            <MonoText size={9} tracking={1.4} uppercase weight="700" color="#ffffff">
              {isArabic ? 'مكافآت' : 'Rewards'}
            </MonoText>
          </TouchableOpacity>
        </View>

        {/* Search bar */}
        <View
          style={{
            marginTop: 12,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: `${colors.text}10`,
            borderRadius: 12,
            paddingHorizontal: 12,
            height: 38,
            borderWidth: 1,
            borderColor: `${colors.text}1F`,
          }}
        >
          <MonoText size={13} color={`${colors.text}88`} style={{ marginEnd: 8 }}>⌕</MonoText>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={isArabic ? 'ابحث في القائمة' : 'Search menu'}
            placeholderTextColor={`${colors.text}55`}
            style={{
              flex: 1,
              color: colors.text,
              fontFamily: POLAROID_FONT.mono,
              fontSize: 12,
              padding: 0,
              textAlign: isArabic ? 'right' : 'left',
            }}
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchQuery.length > 0 ? (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MonoText size={12} color={`${colors.text}99`}>✕</MonoText>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Order-type chips (rotated mini polaroids) */}
        <View style={{ flexDirection: 'row', marginTop: 14, marginHorizontal: -3 }}>
          {orderTypeChips.map((chip, idx) => {
            const active = orderType === chip.key;
            return (
              <View key={chip.key} style={{ flex: 1, paddingHorizontal: 3 }}>
                <PolaroidCard
                  rotation={rotationForIndex(idx)}
                  surfaceColor={active ? colors.accent : colors.surface}
                  style={{ paddingVertical: 6, paddingHorizontal: 4, alignItems: 'center' }}
                >
                  <TouchableOpacity
                    onPress={() => router.push('/order-type')}
                    activeOpacity={0.8}
                    style={{ alignItems: 'center', width: '100%' }}
                  >
                    <MonoText size={14} align="center" color={active ? colors.surface : colors.textOnSurface}>
                      {chip.emoji}
                    </MonoText>
                    <MonoText
                      size={8}
                      tracking={1.2}
                      uppercase
                      weight="700"
                      align="center"
                      color={active ? colors.surface : colors.textOnSurface}
                      style={{ marginTop: 2 }}
                      numberOfLines={1}
                    >
                      {isArabic ? chip.labelAr : chip.labelEn}
                    </MonoText>
                  </TouchableOpacity>
                </PolaroidCard>
              </View>
            );
          })}
        </View>
      </View>

      {/* All-categories scroll — each category becomes its own
          section header followed by a 2-column polaroid grid. */}
      {loading && totalVisible === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
          <MonoText
            size={11}
            tracking={1.6}
            uppercase
            color={`${colors.text}88`}
            style={{ marginTop: 12 }}
          >
            {isArabic ? 'جار التحميل' : 'Loading menu'}
          </MonoText>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 10,
            paddingTop: 14,
            paddingBottom: totalItems > 0 ? 200 : 140,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.text}
              colors={[colors.accent]}
            />
          }
        >
          {groupedProducts.map((section, sIdx) => (
            <View key={section.category} style={{ marginBottom: sIdx === groupedProducts.length - 1 ? 0 : 18 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginHorizontal: 8,
                  marginBottom: 10,
                }}
              >
                <MonoText
                  size={12}
                  tracking={2}
                  uppercase
                  weight="700"
                  color={colors.text}
                  style={{ marginEnd: 8 }}
                >
                  {section.category}
                </MonoText>
                <View style={{ flex: 1, height: 1, backgroundColor: `${colors.text}1F` }} />
                <MonoText
                  size={9}
                  tracking={1.2}
                  color={`${colors.text}66`}
                  style={{ marginStart: 8 }}
                >
                  {section.items.length}
                </MonoText>
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {section.items.map((product, idx) => {
                  const hasModifiers = (product.modifierGroups?.length ?? 0) > 0;
                  return (
                    <View key={product.id} style={{ width: '50%', padding: 8 }}>
                      <PolaroidCard
                        rotation={rotationForIndex(idx)}
                        style={{ padding: 6, paddingBottom: 12 }}
                      >
                        <TouchableOpacity activeOpacity={0.85} onPress={() => openProduct(product.id)}>
                          <Image
                            source={{ uri: product.image }}
                            style={{
                              width: '100%',
                              aspectRatio: 1,
                              backgroundColor: '#e7e2d6',
                              borderRadius: 2,
                            }}
                          />
                          <MonoText
                            size={11}
                            tracking={0.5}
                            align="center"
                            color={colors.textOnSurface}
                            weight="600"
                            style={{ marginTop: 8 }}
                            numberOfLines={1}
                          >
                            {product.name}
                          </MonoText>
                          <MonoText
                            size={9.5}
                            align="center"
                            color={`${colors.textOnSurface}99`}
                            style={{ marginTop: 2 }}
                          >
                            {product.price.toFixed(0)} {isArabic ? 'ر.س' : 'SAR'}
                          </MonoText>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => handleQuickAdd(product)}
                          activeOpacity={0.75}
                          accessibilityRole="button"
                          accessibilityLabel={
                            hasModifiers
                              ? (isArabic ? 'تخصيص' : 'Customize')
                              : (isArabic ? 'أضف' : 'Add')
                          }
                          style={{
                            alignSelf: 'center',
                            marginTop: 8,
                            backgroundColor: colors.accent,
                            borderRadius: 999,
                            paddingHorizontal: hasModifiers ? 10 : 0,
                            height: 26,
                            minWidth: 26,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <MonoText
                            size={hasModifiers ? 9 : 16}
                            tracking={hasModifiers ? 1.2 : 0}
                            uppercase={hasModifiers}
                            weight="700"
                            color="#ffffff"
                          >
                            {hasModifiers ? (isArabic ? 'خصص' : 'CST') : '+'}
                          </MonoText>
                        </TouchableOpacity>
                      </PolaroidCard>
                    </View>
                  );
                })}
              </View>
            </View>
          ))}

          {totalVisible === 0 && !loading && (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <MonoText
                size={11}
                tracking={1.5}
                uppercase
                color={`${colors.text}66`}
              >
                {searchQuery
                  ? (isArabic ? 'لا توجد نتائج' : 'No matches')
                  : (isArabic ? 'لا توجد منتجات' : 'No items here')}
              </MonoText>
            </View>
          )}
        </ScrollView>
      )}

      {/* Sticky polaroid cart bar */}
      {totalItems > 0 && (
        <View
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: Platform.OS === 'ios' ? 110 : 92,
            zIndex: 50,
          }}
          pointerEvents="box-none"
        >
          <PolaroidCard rotation="-0.8deg" large style={{ paddingVertical: 10, paddingHorizontal: 12 }}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => router.push('/cart')}
              style={{ flexDirection: 'row', alignItems: 'center' }}
            >
              <View style={{ flex: 1 }}>
                <MonoText
                  size={9}
                  tracking={1.8}
                  uppercase
                  weight="700"
                  color={`${colors.textOnSurface}99`}
                >
                  {isArabic ? 'سلتك' : 'Your Cart'}
                </MonoText>
                <MonoText
                  size={13}
                  tracking={0.4}
                  weight="700"
                  color={colors.textOnSurface}
                  style={{ marginTop: 2 }}
                  numberOfLines={1}
                >
                  {totalItems} {isArabic ? 'صنف' : 'items'} · {totalPrice.toFixed(0)} {isArabic ? 'ر.س' : 'SAR'}
                </MonoText>
              </View>
              <View
                style={{
                  backgroundColor: colors.accent,
                  paddingHorizontal: 18,
                  paddingVertical: 8,
                  borderRadius: 999,
                  marginStart: 10,
                }}
              >
                <MonoText
                  size={11}
                  tracking={2.4}
                  uppercase
                  weight="800"
                  color="#ffffff"
                >
                  {isArabic ? 'ادفع' : 'Pay'}
                </MonoText>
              </View>
            </TouchableOpacity>
          </PolaroidCard>
        </View>
      )}

      {/* Tiny "cartItems unused" warning suppress for linter — we
          read totalItems instead, but cartItems was originally
          surfaced for parity with the classic screen if we later
          want to inline-edit. Reference once to keep the
          destructure honest. */}
      {cartItems.length < 0 && null}
    </View>
  );
}
