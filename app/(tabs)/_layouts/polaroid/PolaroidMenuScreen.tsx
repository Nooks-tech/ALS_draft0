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
  TouchableOpacity,
  View,
} from 'react-native';
import { useCart } from '../../../../src/context/CartContext';
import { useMenuContext } from '../../../../src/context/MenuContext';
import { useMerchantBranding } from '../../../../src/context/MerchantBrandingContext';
import { MonoText, PolaroidCard } from './PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from './styles';

type OrderType = 'pickup' | 'delivery' | 'drivethru' | 'dine_in';

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
  const { layoutColors, appName, cafeName } = useMerchantBranding();
  const colors = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);

  const displayCategories = useMemo(() => categories.filter((c) => c !== 'All'), [categories]);
  const [selectedCategory, setSelectedCategory] = useState<string>(displayCategories[0] ?? '');
  const [refreshing, setRefreshing] = useState(false);

  const visibleProducts = useMemo(() => {
    if (!selectedCategory) return products;
    return products.filter((p) => p.category === selectedCategory);
  }, [products, selectedCategory]);

  // The 4 order-type chips. We don't change the cart's order type
  // from here — the chips just navigate to /order-type so the
  // existing branch + delivery flow handles it. This keeps cart
  // semantics untouched and avoids regressions on the delivery
  // address requirement.
  const orderTypeChips: { key: OrderType; labelEn: string; labelAr: string; emoji: string }[] = [
    { key: 'pickup', labelEn: 'Pickup', labelAr: 'استلام', emoji: '🥡' },
    { key: 'delivery', labelEn: 'Delivery', labelAr: 'توصيل', emoji: '🛵' },
    { key: 'drivethru', labelEn: 'Drive-thru', labelAr: 'سيارة', emoji: '🚗' },
    { key: 'dine_in', labelEn: 'Dine-in', labelAr: 'صالة', emoji: '🍽️' },
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

      {/* Top header band */}
      <View style={{ paddingTop: Platform.OS === 'ios' ? 58 : 36, paddingHorizontal: 18, paddingBottom: 10 }}>
        <MonoText
          size={22}
          tracking={-0.3}
          color={colors.text}
          style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}
        >
          {brandTitle}
        </MonoText>
        <TouchableOpacity onPress={() => router.push('/order-type')} activeOpacity={0.7}>
          <MonoText
            size={10}
            tracking={2}
            uppercase
            color={`${colors.text}80`}
            style={{ marginTop: 4 }}
            numberOfLines={1}
          >
            {headerLocation} ▾
          </MonoText>
        </TouchableOpacity>

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

      {/* Category pills */}
      {displayCategories.length > 0 && (
        <View
          style={{
            paddingHorizontal: 14,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderBottomColor: `${colors.text}14`,
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 6 }}
          >
            {displayCategories.map((cat) => {
              const isActive = cat === selectedCategory;
              return (
                <TouchableOpacity
                  key={cat}
                  onPress={() => setSelectedCategory(cat)}
                  activeOpacity={0.75}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    marginHorizontal: 4,
                    backgroundColor: isActive ? `${colors.accent}33` : 'transparent',
                    borderWidth: 1,
                    borderColor: isActive ? colors.accent : `${colors.text}1F`,
                  }}
                >
                  <MonoText
                    size={10}
                    tracking={1.4}
                    uppercase
                    weight="700"
                    color={isActive ? colors.accent : `${colors.text}77`}
                  >
                    {cat}
                  </MonoText>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Product grid */}
      {loading && visibleProducts.length === 0 ? (
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
            // Leave room for the floating cart bar + tab bar.
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
          {!!selectedCategory && (
            <MonoText
              size={11}
              tracking={2}
              uppercase
              weight="700"
              color={colors.text}
              style={{ marginHorizontal: 8, marginBottom: 10 }}
            >
              {selectedCategory}
            </MonoText>
          )}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {visibleProducts.map((product, idx) => {
              const hasModifiers = (product.modifierGroups?.length ?? 0) > 0;
              return (
                <View
                  key={product.id}
                  style={{ width: '50%', padding: 8 }}
                >
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

          {visibleProducts.length === 0 && !loading && (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <MonoText
                size={11}
                tracking={1.5}
                uppercase
                color={`${colors.text}66`}
              >
                {isArabic ? 'لا توجد منتجات' : 'No items here'}
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
