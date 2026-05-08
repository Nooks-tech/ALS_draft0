import { useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, Bike, ChevronLeft, ChevronRight, Minus, Pencil, Plus, Store, Trash2 } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useMerchant } from '../src/context/MerchantContext';
import { getDeliveryQuote } from '../src/api/deliveryQuote';
import { reportCartEvent } from '../src/api/cartEvents';
export default function CartScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { merchantId } = useMerchant();
  const isArabic = i18n.language === 'ar';
  const rowDirection = isArabic ? 'row-reverse' : 'row';
  const {
    cartItems,
    updateQuantity,
    removeFromCart,
    totalPrice,
    orderType,
    selectedBranch,
    deliveryAddress } = useCart();
  const [zoneChecking, setZoneChecking] = useState(false);

  // Phase 5 — fire a cart.opened event the first time the cart screen
  // mounts with items. Empty-cart visits don't count as engagement, so
  // we gate on cartItems.length. Fires once per mount; same session id
  // is reused across opens within an app launch (see getCartSessionId).
  useEffect(() => {
    if (!merchantId || cartItems.length === 0) return;
    reportCartEvent({
      event: 'cart.opened',
      merchantId,
      cartItemCount: cartItems.length,
      cartTotalSar: totalPrice,
    });
    // Intentional: we want the open event tied to the mount + first
    // observation of items, not refire every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  const handleEditItem = (item: (typeof cartItems)[0]) => {
    router.push({ pathname: '/product', params: { id: item.id, uniqueId: item.uniqueId } });
  };

  // Delivery fee is computed at checkout (per-branch, possibly zone-based).
  // Cart shows the items subtotal only — no fake flat fee to mislead the customer.
  const finalTotal = totalPrice;
  const BackIcon = isArabic ? ArrowRight : ArrowLeft;
  const ForwardIcon = isArabic ? ChevronLeft : ChevronRight;

  const handleCheckout = async () => {
    // Branch open/busy status is now evaluated at checkout against the
    // customer's chosen (pickup) or nearest (delivery) branch. Don't block
    // here — let the customer proceed and see a branch-specific message
    // on the checkout screen if needed.
    if (orderType === 'delivery' && !deliveryAddress?.address) {
      router.push('/order-type');
      return;
    }
    if (!selectedBranch?.id) {
      router.push('/order-type');
      return;
    }

    // Hard delivery-zone check BEFORE entering checkout. Previously the
    // zone validation lived only on the checkout screen as a soft banner
    // + a Pay-button disable that started enabled and flipped racy after
    // the quote API resolved. Customers were tapping Pay before the
    // disable kicked in, which charged the card and then 409'd at the
    // server-side gate. Now we run the same /delivery-quote up front
    // and refuse the navigation entirely if the address is out of zone.
    if (
      orderType === 'delivery' &&
      merchantId &&
      selectedBranch?.id &&
      typeof deliveryAddress?.lat === 'number' &&
      typeof deliveryAddress?.lng === 'number'
    ) {
      setZoneChecking(true);
      try {
        const quote = await getDeliveryQuote({
          merchantId,
          branchId: selectedBranch.id,
          items: cartItems.map((i) => ({
            product_id: (i as any).foodicsProductId || i.id,
            quantity: i.quantity,
            price_sar: i.price })),
          lat: deliveryAddress.lat,
          lng: deliveryAddress.lng,
          address: deliveryAddress.address || undefined });
        if (!quote.withinServiceArea) {
          Alert.alert(
            isArabic ? 'العنوان خارج منطقة التوصيل' : 'Address outside delivery zone',
            isArabic
              ? 'عنوانك الحالي يقع خارج منطقة توصيل المتجر. اختر عنواناً آخر، أو غيّر نوع الطلب إلى الاستلام للمتابعة.'
              : "Your current address is outside this store's delivery area. Pick a different address, or switch the order type to pickup to continue.",
            [
              {
                text: isArabic ? 'تغيير العنوان' : 'Change address',
                onPress: () => router.push('/order-type') },
              { text: isArabic ? 'إلغاء' : 'Cancel', style: 'cancel' },
            ],
          );
          return;
        }
      } catch {
        // Network / server error — soft fall-through. Server-side gate
        // in /api/public/orders is the safety net.
      } finally {
        setZoneChecking(false);
      }
    }

    router.push('/checkout');
  };

  return (
    // edges = top + bottom only. The default safe-area-context
    // SafeAreaView pads ALL physical insets (including the device's
    // left + right margins on rounded-corner phones) which adds up
    // to slightly asymmetric horizontal space in some RTL layouts.
    // The body content already paints behind the modal's own edge
    // mask, so we only need vertical safe-area handling.
    <SafeAreaView className="flex-1 bg-white" edges={['top', 'bottom']}>
      {/* --- HEADER --- */}
      <View className="px-5 py-4 border-b border-slate-100 items-center justify-center relative">
        <TouchableOpacity
          onPress={() => router.back()}
          className="bg-slate-100 p-2 rounded-full absolute"
          style={{ start: 20, top: 12 }}
        >
          <BackIcon size={22} color="#334155" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-slate-900">{isArabic ? 'سلتي' : 'My Basket'}</Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 200 }}
      >
        {/* --- ORDER TYPE STATUS --- */}
          <View className="items-center p-4 bg-slate-50 rounded-3xl mb-8 border border-slate-100" style={{ flexDirection: 'row' }}>
            <View style={[orderType === 'delivery' ? { backgroundColor: `${primaryColor}20` } : undefined, { marginEnd: 16 }]} className={orderType === 'delivery' ? 'p-3 rounded-2xl' : 'bg-orange-100 p-3 rounded-2xl'}>
              {orderType === 'delivery' ? (
                <Bike size={24} color={primaryColor} />
              ) : (
                <Store size={24} color="#F59E0B" />
              )}
            </View>
            <View className="flex-1" style={{ marginEnd: 12 }}>
              {/* writingDirection makes the English branch name align
                  to the start of its line in RTL mode (= right side
                  on screen), so it doesn't run into the Change
                  button on the far end. */}
              <Text
                className="text-[10px] font-bold text-slate-400 uppercase tracking-widest"
                style={{ writingDirection: isArabic ? 'rtl' : 'ltr' }}
              >
                {orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivering to') : (isArabic ? 'الاستلام من' : 'Picking up from')}
              </Text>
              <Text
                className="text-slate-800 font-bold text-base"
                style={{ writingDirection: isArabic ? 'rtl' : 'ltr' }}
                numberOfLines={2}
              >
                {orderType === 'delivery'
                  ? deliveryAddress?.address || (isArabic ? 'أضف عنوان التوصيل' : 'Add delivery address')
                  : selectedBranch?.name || (isArabic ? 'اختر الفرع' : 'Select branch')}
              </Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/order-type')}>
              <Text className="font-bold" style={{ color: primaryColor }}>{isArabic ? 'تغيير' : 'Change'}</Text>
            </TouchableOpacity>
          </View>

          <Text className="text-lg font-bold text-slate-900 mb-4" style={{ }}>{isArabic ? 'ملخص الطلب' : 'Order Summary'}</Text>

          {/* --- CART ITEMS --- */}
          {cartItems.length === 0 ? (
            <View className="items-center py-20">
              <Text className="text-slate-400 font-medium text-lg">{isArabic ? 'سلتك فارغة' : 'Your basket is empty'}</Text>
              <TouchableOpacity
                onPress={() => router.back()}
                className="mt-4"
              >
                <Text className="font-bold" style={{ color: primaryColor }}>{isArabic ? 'اذهب لإضافة بعض القهوة!' : 'Go add some coffee!'}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            cartItems.map((item) => (
              <View
                key={item.uniqueId}
                className="items-center mb-6 bg-white rounded-3xl p-3 border border-slate-100 shadow-sm"
                style={{ flexDirection: 'row', alignItems: 'center' }}
              >
                <Image
                  source={{ uri: item.image }}
                  className="w-20 h-20 rounded-2xl bg-slate-100"
                />

                <View
                  className="flex-1"
                  style={{
                    marginStart: 16,
                    // Native RTL auto-flips flex-start, so the explicit
                    // isArabic check was double-flipping and pinning
                    // text to the wrong side in Arabic. Plain
                    // 'flex-start' aligns to the start of the line in
                    // either direction.
                    alignItems: 'flex-start' }}
                >
                  <Text className="text-base font-bold text-slate-800" style={{ }} numberOfLines={1}>
                    {item.name}
                  </Text>

                  {!!item.customizations && (
                    <Text className="text-slate-400 text-xs mt-0.5" style={{ }} numberOfLines={1}>
                      {Object.values(item.customizations)
                        .map((opt: any) => opt.name)
                        .join(' • ')}
                    </Text>
                  )}

                  <PriceWithSymbol amount={item.price * item.quantity} iconSize={16} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700' }} className="mt-1" />
                </View>

                <View className="items-center" style={{ minWidth: 120 }}>
                  <TouchableOpacity
                    onPress={() => handleEditItem(item)}
                    className="mb-2 items-center p-2"
                    style={{ flexDirection: 'row' }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Pencil size={18} color={primaryColor} />
                    <Text
                      className="font-bold text-sm"
                      style={{
                        color: primaryColor,
                        marginStart: 6 }}
                    >
                      {isArabic ? 'تعديل' : 'Edit'}
                    </Text>
                  </TouchableOpacity>
                  <View className="items-center bg-slate-100 rounded-2xl p-2" style={{ flexDirection: 'row' }}>
                    <TouchableOpacity
                      onPress={() => updateQuantity(item.uniqueId, -1)}
                      className="p-2.5 bg-white rounded-xl shadow-sm"
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <Minus size={20} color="#64748b" />
                    </TouchableOpacity>

                    <Text
                      className="font-bold text-slate-800 text-base"
                      style={{ marginHorizontal: 16 }}
                    >
                      {item.quantity}
                    </Text>

                    <TouchableOpacity
                      onPress={() => updateQuantity(item.uniqueId, 1)}
                      className="p-2.5 bg-white rounded-xl shadow-sm"
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <Plus size={20} color={primaryColor} />
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    onPress={() => {
                      Alert.alert(
                        isArabic ? 'حذف المنتج' : 'Remove item',
                        isArabic
                          ? `تبي تحذف "${item.name}" من السلة؟`
                          : `Remove "${item.name}" from your cart?`,
                        [
                          { text: isArabic ? 'لا' : 'Cancel', style: 'cancel' },
                          {
                            text: isArabic ? 'احذفه' : 'Remove',
                            style: 'destructive',
                            onPress: () => removeFromCart(item) },
                        ],
                      );
                    }}
                    className="mt-2 p-2"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Trash2 size={22} color="#f87171" />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}

          {!!cartItems.length && (
            <View className="mt-4 p-6 bg-slate-50 rounded-[32px] border border-slate-100">
              <View className="justify-between mb-3" style={{ flexDirection: 'row' }}>
                <Text className="text-slate-500 font-medium" style={{ }}>{isArabic ? 'المجموع الفرعي' : 'Subtotal'}</Text>
                <PriceWithSymbol amount={totalPrice} iconSize={15} iconColor="#1e293b" textStyle={{ color: '#1e293b', fontWeight: '700' }} />
              </View>
              {orderType === 'delivery' && (
                <View className="justify-between mb-3" style={{ flexDirection: 'row' }}>
                  <Text className="text-slate-500 font-medium" style={{ }}>{isArabic ? 'رسوم التوصيل' : 'Delivery'}</Text>
                  <Text className="text-slate-400 text-sm">{isArabic ? 'تُحسب عند الدفع' : 'Calculated at checkout'}</Text>
                </View>
              )}

              <View className="h-[1px] bg-slate-200 my-4" />

              <View className="justify-between" style={{ flexDirection: 'row' }}>
                <Text className="text-xl font-bold text-slate-900" style={{ }}>{isArabic ? 'الإجمالي' : 'Total'}</Text>
                <View style={{ alignItems: 'flex-end' }}>
                  <PriceWithSymbol amount={finalTotal} iconSize={18} iconColor={primaryColor} textStyle={{ color: primaryColor, fontWeight: '700', fontSize: 20 }} />
                  <Text className="text-[10px] text-slate-400">{isArabic ? 'شامل الضريبة' : 'VAT Included'}</Text>
                </View>
              </View>
            </View>
          )}
      </ScrollView>

      {!!cartItems.length && (
        <View className="p-6 pt-4 pb-8 bg-white border-t border-slate-100">
          <TouchableOpacity
            style={{ backgroundColor: primaryColor, flexDirection: 'row', opacity: zoneChecking ? 0.6 : 1 }}
            className="p-5 rounded-[28px] items-center shadow-xl"
            activeOpacity={0.9}
            onPress={handleCheckout}
            disabled={zoneChecking}
          >
            <View className="bg-white/20 px-3 py-1.5 rounded-xl" style={{ marginEnd: 12 }}>
              <Text className="text-white font-bold">{cartItems.length}</Text>
            </View>
            <Text className="text-white font-bold text-xl">
              {zoneChecking
                ? (isArabic ? 'جارٍ التحقق…' : 'Checking…')
                : (isArabic ? 'المتابعة للدفع' : 'Proceed to Checkout')}
            </Text>
            {/* marginStart: 'auto' pushes the price + chevron to the
                end side of the row regardless of RTL/LTR — same effect
                as the old marginLeft:'auto' but flips correctly in
                Arabic instead of pinning to physical left. */}
            <View style={{ marginStart: 'auto', marginEnd: 12 }}>
              <PriceWithSymbol amount={finalTotal} iconSize={18} iconColor="#fff" textStyle={{ color: '#fff', fontWeight: '700', fontSize: 18 }} />
            </View>
            <ForwardIcon size={24} color="white" />
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}