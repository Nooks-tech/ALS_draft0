/**
 * Polaroid orders screen.
 *
 * Layout (matches `.po-order-*` classes):
 *  - white polaroid card per past order
 *  - small row of thumbnail images at the top
 *  - mono caption "ORDER #1248"
 *  - rotated "stamp" effect (rounded rect with a slight twist
 *    and a translucent red/terracotta border) top-right
 *  - terracotta "RE-ORDER" mini pill at the bottom of each card
 *
 * Tapping a card navigates to the existing order detail modal
 * (kept as-is by spec).
 */
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  I18nManager,
  Image,
  Platform,
  StatusBar,
  TouchableOpacity,
  View,
} from 'react-native';
import { useCart } from '../../context/CartContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { useOrders, type PlacedOrder } from '../../context/OrdersContext';
import { MonoText, PolaroidCard } from './PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from './styles';

function shortOrderId(id: string): string {
  // The orders context prefixes with "order-"; trim that for display.
  return id.replace(/^order-/, '').slice(0, 8);
}

function statusStampInfo(status: PlacedOrder['status']): { label: string; color: string } | null {
  switch (status) {
    case 'Delivered':
      return { label: 'DELIVERED', color: '#1f7a3d' };
    case 'Cancelled':
      return { label: 'CANCELLED', color: '#9b1c1c' };
    case 'Ready':
      return { label: 'READY', color: '#b85a18' };
    case 'Out for delivery':
      return { label: 'EN ROUTE', color: '#a14a14' };
    case 'Preparing':
    case 'Accepted':
    case 'Placed':
      return { label: 'IN PREP', color: '#c8370a' };
    default:
      return null;
  }
}

export default function PolaroidOrdersScreen() {
  const { i18n } = useTranslation();
  const router = useRouter();
  const isArabic = i18n.language === 'ar' || I18nManager.isRTL;
  const { orders, loading } = useOrders();
  const { setCartFromOrder } = useCart();
  const { layoutColors } = useMerchantBranding();
  const colors = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);

  const handleReorder = (order: PlacedOrder) => {
    setCartFromOrder({
      items: order.items,
      orderType: order.orderType,
      branchId: order.branchId,
      branchName: order.branchName,
      deliveryAddress: order.deliveryAddress,
      deliveryLat: order.deliveryLat,
      deliveryLng: order.deliveryLng,
    });
    router.replace('/(tabs)/menu');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />

      <View style={{ backgroundColor: colors.headerBg, paddingTop: Platform.OS === 'ios' ? 58 : 36, paddingHorizontal: 18, paddingBottom: 14 }}>
        <MonoText
          size={22}
          tracking={-0.3}
          color={colors.text}
          style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}
        >
          {isArabic ? 'طلباتي' : 'My Orders'}
        </MonoText>
      </View>

      {loading && orders.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{
            paddingHorizontal: 14,
            paddingBottom: Platform.OS === 'ios' ? 130 : 110,
          }}
          ListEmptyComponent={
            <View style={{ paddingVertical: 80, alignItems: 'center' }}>
              <MonoText
                size={11}
                tracking={1.6}
                uppercase
                color={`${colors.text}55`}
              >
                {isArabic ? 'لا توجد طلبات بعد' : 'No orders yet'}
              </MonoText>
            </View>
          }
          renderItem={({ item, index }) => {
            const stamp = statusStampInfo(item.status);
            const grossTotal =
              (typeof item.total === 'number' ? item.total : 0) +
              (typeof item.cashbackPaidSar === 'number' ? item.cashbackPaidSar : 0);
            const thumbs = item.items.slice(0, 4);
            return (
              <View style={{ marginBottom: 14 }}>
                <PolaroidCard
                  rotation={rotationForIndex(index)}
                  style={{ padding: 12, paddingBottom: 14 }}
                >
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() =>
                      router.push({
                        pathname: '/order-detail-modal',
                        params: { orderId: item.id },
                      })
                    }
                  >
                    {/* Thumbnail row */}
                    <View style={{ flexDirection: 'row', marginBottom: 8 }}>
                      {thumbs.map((p, i) => (
                        <View
                          key={`${item.id}-thumb-${i}`}
                          style={{
                            width: 36,
                            height: 36,
                            backgroundColor: '#d9cdb8',
                            borderRadius: 2,
                            marginEnd: 4,
                            overflow: 'hidden',
                          }}
                        >
                          {p.image ? (
                            <Image
                              source={{ uri: p.image }}
                              style={{ width: '100%', height: '100%' }}
                            />
                          ) : null}
                        </View>
                      ))}
                    </View>

                    <MonoText
                      size={12}
                      tracking={1.5}
                      uppercase
                      weight="700"
                      color={colors.textOnSurface}
                    >
                      {isArabic ? `طلب #${shortOrderId(item.id)}` : `Order #${shortOrderId(item.id)}`}
                    </MonoText>
                    <MonoText
                      size={10}
                      tracking={0.4}
                      color={`${colors.textOnSurface}88`}
                      style={{ marginTop: 4 }}
                    >
                      {item.items.length} {isArabic ? 'صنف' : 'items'} · {grossTotal.toFixed(0)} {isArabic ? 'ر.س' : 'SAR'} · {item.date}
                    </MonoText>
                  </TouchableOpacity>

                  {/* Reorder pill */}
                  <View style={{ alignItems: 'center', marginTop: 12 }}>
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={() => handleReorder(item)}
                      style={{
                        backgroundColor: colors.accent,
                        paddingHorizontal: 16,
                        paddingVertical: 6,
                        borderRadius: 999,
                      }}
                    >
                      <MonoText
                        size={9}
                        tracking={2}
                        uppercase
                        weight="800"
                        color="#ffffff"
                      >
                        {isArabic ? 'اطلب مرة أخرى' : 'Re-order'}
                      </MonoText>
                    </TouchableOpacity>
                  </View>

                  {/* Status stamp (top-right corner) */}
                  {stamp && (
                    <View
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        transform: [{ rotate: '8deg' }],
                        borderWidth: 1.5,
                        borderColor: stamp.color,
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 4,
                        backgroundColor: 'transparent',
                        opacity: 0.85,
                      }}
                    >
                      <MonoText
                        size={9}
                        tracking={1.8}
                        uppercase
                        weight="800"
                        color={stamp.color}
                      >
                        {stamp.label}
                      </MonoText>
                    </View>
                  )}
                </PolaroidCard>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}
