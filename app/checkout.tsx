import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  MapPin,
  Percent,
  Pencil,
  X,
} from 'lucide-react-native';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ApplePayConfig,
  CreditCard as CreditCardPayment,
  CreditCardConfig,
  PaymentConfig,
  PaymentResponse,
  PaymentStatus,
  isMoyasarError,
} from 'react-native-moyasar-sdk';
import { MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY, APPLE_PAY_MERCHANT_ID } from '../src/api/config';
import { foodicsApi } from '../src/api/foodics';
import { loyaltyApi } from '../src/api/loyalty';
import { otoApi } from '../src/api/oto';
import { paymentApi } from '../src/api/payment';
import { buildNooksOrderPayload, submitOrderToNooks } from '../src/api/nooksOrders';
import { validatePromoCode } from '../src/api/promo';
import { getBranchOtoConfig } from '../src/config/branchOtoConfig';

/** Haversine distance in km. Used when city is missing to detect cross-city delivery. */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
import { useAuth } from '../src/context/AuthContext';
import { useCart } from '../src/context/CartContext';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useOrders } from '../src/context/OrdersContext';
import { useProfile } from '../src/context/ProfileContext';

export type PaymentMethod = 'apple_pay' | 'samsung_pay' | 'credit_card';

const VAT_RATE = 0.15; // 15% Saudi VAT

export default function CheckoutScreen() {
  const router = useRouter();
  const {
    cartItems,
    totalPrice,
    orderType,
    selectedBranch,
    deliveryAddress,
    clearCart,
  } = useCart();
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  const { addOrder } = useOrders();
  const { profile } = useProfile();
  const customerId = user?.id ?? profile?.phone ?? profile?.full_name ?? 'guest';
  const { primaryColor } = useMerchantBranding();

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    Platform.OS === 'ios' ? 'apple_pay' : 'samsung_pay'
  );
  const [submitting, setSubmitting] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showPaymentPicker, setShowPaymentPicker] = useState(false);
  const [orderNote, setOrderNote] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [showCouponInput, setShowCouponInput] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [promoValidating, setPromoValidating] = useState(false);
  const [moyasarWebUrl, setMoyasarWebUrl] = useState<string | null>(null);
  const paymentSuccessHandled = useRef(false);

  const deliveryFee = orderType === 'delivery' ? 15 : 0;
  const subtotalBeforePromo = totalPrice + deliveryFee;
  const discount = promoApplied ? promoDiscount : 0;
  const subtotalAfterDiscount = Math.max(0, subtotalBeforePromo - discount);
  const amountExclVAT = subtotalAfterDiscount / (1 + VAT_RATE);
  const deliveryExclVAT = (orderType === 'delivery' ? deliveryFee : 0) / (1 + VAT_RATE);
  const itemsExclVAT = amountExclVAT - deliveryExclVAT;
  const vatAmount = subtotalAfterDiscount - amountExclVAT;
  const finalTotal = subtotalAfterDiscount;
  const amountHalals = Math.round(finalTotal * 100);

  const paymentConfig = useMemo(() => {
    if (!MOYASAR_PUBLISHABLE_KEY) return null;
    try {
      return new PaymentConfig({
        publishableApiKey: MOYASAR_PUBLISHABLE_KEY,
        baseUrl: MOYASAR_BASE_URL,
        amount: Math.max(amountHalals, 100),
        currency: 'SAR',
        merchantCountryCode: 'SA',
        description: `Order #${Date.now()}`,
        metadata: { order_id: `order-${Date.now()}` },
        supportedNetworks: ['mada', 'visa', 'mastercard', 'amex'],
        creditCard: new CreditCardConfig({ saveCard: false, manual: false }),
        applePay: Platform.OS === 'ios'
          ? new ApplePayConfig({
              merchantId: APPLE_PAY_MERCHANT_ID,
              label: 'ALS',
              manual: false,
              saveCard: false,
            })
          : undefined,
        createSaveOnlyToken: false,
      });
    } catch {
      return null;
    }
  }, [amountHalals]);

  const applyCoupon = async () => {
    const code = (couponInput || promoCode).trim();
    if (!code) return;
    setPromoValidating(true);
    try {
      const result = await validatePromoCode(code, subtotalBeforePromo);
      if (result.valid) {
        setPromoDiscount(result.discountAmount);
        setPromoApplied(true);
        setPromoCode(result.code);
        setShowCouponInput(false);
        setCouponInput('');
      } else {
        Alert.alert('Invalid Code', 'This promo code is not valid or has expired.');
      }
    } catch {
      Alert.alert('Error', 'Could not validate promo code. Please try again.');
    } finally {
      setPromoValidating(false);
    }
  };

  const removeCoupon = () => {
    setPromoApplied(false);
    setPromoDiscount(0);
    setPromoCode('');
    setCouponInput('');
  };

  const createOrderAfterPayment = useCallback(async () => {
    if (!selectedBranch?.id) return;
    setSubmitting(true);
    const orderId = `order-${Date.now()}`;
    let foodicsOk = false;
    try {
      const payload = {
        branchId: selectedBranch.id,
        orderType,
        items: cartItems.map((item) => ({
          productId: item.id,
          quantity: item.quantity,
          price: item.price,
          options: {},
        })),
        deliveryAddress: orderType === 'delivery' && deliveryAddress ? deliveryAddress : undefined,
        ...(promoApplied && promoDiscount > 0 && promoCode && {
          discount: {
            reference: promoCode,
            amount: promoDiscount,
            type: 'amount' as const,
            name: 'App Promo',
          },
        }),
      };
      try {
        await foodicsApi.createOrder(payload);
        foodicsOk = true;
      } catch (foodicsErr: any) {
        console.warn('[Foodics] createOrder failed:', foodicsErr?.message);
        if (foodicsErr?.message?.toLowerCase().includes('not found') || foodicsErr?.message?.toLowerCase().includes('unauthorized') || foodicsErr?.message?.toLowerCase().includes('token')) {
          // Demo mode: Foodics not configured, continue with local order
        } else {
          throw foodicsErr;
        }
      }
      let otoId: number | undefined;
      // Request OTO delivery for delivery orders (driver dispatch)
      if (orderType === 'delivery' && deliveryAddress?.address) {
        console.log('[Checkout] Calling OTO requestDelivery...');
        try {
          const branchOto = getBranchOtoConfig(selectedBranch?.id ?? '', selectedBranch?.name);
          const originCity = branchOto?.city ?? 'Madinah';
          const destCity = deliveryAddress.city ?? originCity;
          let deliveryOptionId: number | undefined;
          let pickupLocationCode: string | undefined = branchOto?.otoPickupLocationCode;

          if (branchOto) {
            try {
              const opts = await otoApi.getDeliveryOptions({
                originCity,
                destinationCity: destCity,
                weight: 1,
                originLat: branchOto.lat,
                originLon: branchOto.lon,
                destinationLat: deliveryAddress.lat,
                destinationLon: deliveryAddress.lng,
              });
              if (opts?.options?.[0]) {
                deliveryOptionId = opts.options[0].deliveryOptionId;
              }
            } catch (_) {}
          }

          const otoResult = await otoApi.requestDelivery({
            orderId,
            amount: finalTotal,
            pickupLocationCode,
            deliveryOptionId,
            customer: {
              name: profile?.fullName || 'Customer',
              phone: profile?.phone || '500000000',
              email: profile?.email,
            },
            deliveryAddress: {
              address: deliveryAddress.address,
              lat: deliveryAddress.lat,
              lng: deliveryAddress.lng,
              city: destCity,
            },
            branch: {
              name: selectedBranch.name,
              address: selectedBranch.address,
            },
            items: cartItems.map((i) => ({
              name: i.name,
              price: i.price,
              quantity: i.quantity,
            })),
          });
          if (otoResult?.otoId != null) otoId = otoResult.otoId;
        } catch (otoErr: any) {
          console.warn('[Checkout] OTO delivery failed:', otoErr?.message);
          // Order is placed; OTO failure is non-blocking
        }
      } else {
        console.log('[Checkout] Skipping OTO: orderType=', orderType, 'hasAddress=', !!deliveryAddress?.address);
      }
      addOrder(
        {
          total: finalTotal,
          items: [...cartItems],
          orderType,
          merchantId: merchantId || undefined,
          branchName: selectedBranch?.name,
          branchId: selectedBranch?.id,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address : undefined,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat : undefined,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng : undefined,
          otoId,
          deliveryFee,
          paymentId: orderId,
        },
        orderId
      );
      if (customerId && customerId !== 'guest') {
        const subtotalForPoints = Math.max(0, finalTotal - deliveryFee);
        loyaltyApi.earn(customerId, orderId, subtotalForPoints).catch(() => {});
      }
      const nooksPayload = buildNooksOrderPayload(
        {
          merchantId: merchantId || undefined,
          branchId: selectedBranch?.id,
          total: finalTotal,
          items: cartItems,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address : undefined,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat : undefined,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng : undefined,
        },
        customerId,
        orderType === 'delivery' ? deliveryAddress?.city : undefined
      );
      if (nooksPayload) submitOrderToNooks(nooksPayload);
      clearCart();
      setShowPaymentModal(false);
      setMoyasarWebUrl(null);
      setShowPaymentPicker(false);
      router.dismissAll();
      setTimeout(() => router.replace({ pathname: '/order-confirmed', params: { orderId } }), 0);
    } catch (err: any) {
      Alert.alert('Order Failed', err?.message || 'Order could not be created. Please contact support.');
    } finally {
      setSubmitting(false);
    }
  }, [cartItems, finalTotal, orderType, merchantId, selectedBranch, deliveryAddress, addOrder, clearCart, promoApplied, promoDiscount, promoCode, profile]);

  const handlePaymentResult = useCallback(
    (result: unknown) => {
      setShowPaymentModal(false);
      if (isMoyasarError(result)) {
        Alert.alert('Payment Failed', result.message || 'Payment could not be completed.');
        return;
      }
      if (result instanceof PaymentResponse && result.status === PaymentStatus.paid) {
        createOrderAfterPayment();
      } else if (result instanceof PaymentResponse && result.status === PaymentStatus.failed) {
        Alert.alert('Payment Failed', 'Your payment was declined. Please try again.');
      } else {
        Alert.alert('Payment', 'Payment was not completed.');
      }
    },
    [createOrderAfterPayment]
  );

  const handlePay = async () => {
    if (orderType === 'delivery' && !deliveryAddress?.address) {
      Alert.alert('Address Required', 'Delivery address is required. Go back to add one.');
      return;
    }
    if (orderType === 'delivery' && selectedBranch?.id && deliveryAddress?.address) {
      const branchOto = getBranchOtoConfig(selectedBranch.id, selectedBranch.name);
      const branchCity = branchOto?.city;
      const customerCity = deliveryAddress.city;

      // City-based check when both cities are known
      if (branchCity && customerCity && branchCity.toLowerCase() !== customerCity.toLowerCase()) {
        Alert.alert(
          'Delivery Not Available',
          `Delivery is only available within ${branchCity}. Your address is in ${customerCity}. Please select a branch in ${customerCity} or choose pickup.`
        );
        return;
      }

      // Coordinate-based fallback when city is missing (Mapbox/saved addresses often omit city)
      const branchLat = branchOto?.lat;
      const branchLon = branchOto?.lon;
      const delLat = deliveryAddress.lat;
      const delLng = deliveryAddress.lng;
      if (branchCity && branchLat != null && branchLon != null && delLat != null && delLng != null) {
        const dist = distanceKm(branchLat, branchLon, delLat, delLng);
        if (dist > 50) {
          Alert.alert(
            'Delivery Not Available',
            `Delivery is only available within ${branchCity}. Your address is too far from this branch (${Math.round(dist)} km). Please select a branch near your location or choose pickup.`
          );
          return;
        }
      }
    }
    if (!selectedBranch?.id) {
      Alert.alert('Branch Required', 'Please select a branch.');
      return;
    }

    if (!paymentConfig || !MOYASAR_PUBLISHABLE_KEY) {
      Alert.alert(
        'Payment Not Configured',
        'Add EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY to your .env'
      );
      return;
    }
    if (paymentMethod === 'apple_pay' && Platform.OS !== 'ios') {
      Alert.alert('Apple Pay', 'Apple Pay is only available on iOS.');
      return;
    }
    if (paymentMethod === 'samsung_pay' && Platform.OS !== 'android') {
      Alert.alert('Samsung Pay', 'Samsung Pay is only available on Android.');
      return;
    }

    if (paymentMethod === 'apple_pay' || paymentMethod === 'samsung_pay') {
      paymentSuccessHandled.current = false;
      setSubmitting(true);
      try {
        const session = await paymentApi.initiate({
          amount: finalTotal,
          currency: 'SAR',
          orderId: `order-${Date.now()}`,
          successUrl: 'alsdraft0://payment/success',
        });
        if (session.url) {
          setMoyasarWebUrl(session.url);
        } else {
          Alert.alert('Payment Error', 'Could not open payment page. Please try again.');
        }
      } catch (err: unknown) {
        Alert.alert('Payment Error', err instanceof Error ? err.message : 'Failed to start payment.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setShowPaymentModal(true);
  };

  const paymentLabel =
    paymentMethod === 'apple_pay'
      ? 'Apple Pay'
      : paymentMethod === 'samsung_pay'
        ? 'Samsung Pay'
        : 'Credit / Debit Card';

  if (cartItems.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center px-6">
        <Text className="text-slate-600 text-center mb-4">Your cart is empty</Text>
        <TouchableOpacity onPress={() => router.back()} className="bg-black px-6 py-3 rounded-xl">
          <Text className="text-white font-bold">Back to Cart</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center px-5 py-4 border-b border-slate-100">
        <TouchableOpacity onPress={() => router.back()} className="p-2 -ml-2">
          <ArrowLeft size={24} color="#111" />
        </TouchableOpacity>
        <Text className="flex-1 text-center text-lg font-bold text-slate-900">Checkout</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 200 }}
      >
        <View className="px-5 pt-5">
          {/* Delivery & Order Details (display only, no change) */}
          <View className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <View className="flex-row items-center px-4 py-3.5">
              <MapPin size={20} color="#64748b" />
              <View className="flex-1 ml-3">
                <Text className="text-slate-500 text-xs">{orderType === 'delivery' ? 'Delivery to' : 'Pickup from'}</Text>
                <Text className="text-slate-900 font-medium" numberOfLines={1}>
                  {orderType === 'delivery' ? deliveryAddress?.address || '—' : selectedBranch?.name || '—'}
                </Text>
              </View>
            </View>
            <View className="h-px bg-slate-100 ml-12" />
            <View className="flex-row items-center px-4 py-3.5">
              <Clock size={20} color="#64748b" />
              <View className="flex-1 ml-3">
                <Text className="text-slate-500 text-xs">Expected due time</Text>
                <Text className="text-slate-900 font-medium">~ 30 minutes</Text>
              </View>
            </View>
            <View className="h-px bg-slate-100 ml-12" />
            <TouchableOpacity
              onPress={() => Alert.prompt('Note', 'Add a note for your order', (t) => setOrderNote(t || ''))}
              className="flex-row items-center px-4 py-3.5"
            >
              <Pencil size={20} color="#64748b" />
              <View className="flex-1 ml-3">
                <Text className="text-slate-900 font-medium">{orderNote || 'Write a note'}</Text>
              </View>
              <ChevronRight size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Promo / Coupon */}
          <View className="mt-5">
            {showCouponInput ? (
              <View className="flex-row items-center border-2 border-dashed border-slate-200 rounded-2xl p-3 gap-2">
                <TextInput
                  placeholder="Enter promo code"
                  value={couponInput}
                  onChangeText={setCouponInput}
                  className="flex-1 text-slate-900 font-medium"
                  autoCapitalize="characters"
                />
                <TouchableOpacity
                  onPress={applyCoupon}
                  disabled={promoValidating}
                  className="bg-black px-4 py-2 rounded-xl disabled:opacity-60"
                >
                  {promoValidating ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <Text className="text-white font-bold">Apply</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setShowCouponInput(false); setCouponInput(''); }}>
                  <Text className="text-slate-500">Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : promoApplied ? (
              <TouchableOpacity
                onPress={removeCoupon}
                className="border-2 rounded-2xl p-4 flex-row items-center justify-between bg-teal-50/50"
            style={{ borderColor: primaryColor, backgroundColor: `${primaryColor}08` }}
              >
                <View className="flex-row items-center">
                  <Percent size={20} color={primaryColor} />
                  <Text className="ml-3 font-bold" style={{ color: primaryColor }}>{promoCode} applied</Text>
                </View>
                <Text className="text-slate-500 text-sm">−{promoDiscount} SAR</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={() => setShowCouponInput(true)}
                className="border-2 border-dashed border-slate-200 rounded-2xl p-4 flex-row items-center justify-center"
              >
                <Text className="text-slate-500 font-medium">Add promo code or coupon</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Order Summary */}
          <View className="mt-6">
            <Text className="text-slate-500 text-sm mb-1">Amount excl. VAT</Text>
            <View className="flex-row justify-between">
              <Text className="text-slate-900 font-medium">Amount excl. VAT</Text>
              <Text className="text-slate-900 font-bold">{itemsExclVAT.toFixed(2)} SAR</Text>
            </View>
            <View className="flex-row justify-between mt-1">
              <Text className="text-slate-900 font-medium">Delivery fee excl. VAT</Text>
              <Text className="text-slate-900 font-bold">{deliveryExclVAT.toFixed(2)} SAR</Text>
            </View>
            <View className="flex-row justify-between mt-1">
              <Text className="text-slate-900 font-medium">VAT</Text>
              <Text className="text-slate-900 font-bold">{vatAmount.toFixed(2)} SAR</Text>
            </View>
            <View className="flex-row justify-between mt-3 pt-3 border-t border-slate-100">
              <Text className="text-slate-900 font-bold">Total VAT included</Text>
              <Text className="text-slate-900 font-bold text-lg">{finalTotal.toFixed(2)} SAR</Text>
            </View>
          </View>

          {/* Payment Method */}
          <View className="mt-8">
            <Text className="text-slate-500 text-sm mb-2">Selected payment method</Text>
            <TouchableOpacity
              onPress={() => setShowPaymentPicker(true)}
              className="flex-row items-center bg-slate-50 rounded-2xl p-4 border border-slate-100"
            >
              {paymentMethod === 'apple_pay' ? (
                <View className="w-12 h-8 bg-black rounded" style={{ justifyContent: 'center', alignItems: 'center' }}>
                  <Text className="text-white font-bold text-xs"> Pay</Text>
                </View>
              ) : paymentMethod === 'samsung_pay' ? (
                <View className="w-12 h-8 bg-blue-900 rounded" style={{ justifyContent: 'center', alignItems: 'center' }}>
                  <Text className="text-white font-bold text-xs">S Pay</Text>
                </View>
              ) : (
                <View className="w-12 h-10 bg-slate-200 rounded-lg items-center justify-center">
                  <Text className="text-slate-600 font-bold text-xs">••••</Text>
                </View>
              )}
              <Text className="flex-1 ml-3 font-bold text-slate-900">{paymentLabel}</Text>
              <ChevronRight size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Footer */}
      <View className="absolute bottom-0 left-0 right-0 bg-white border-t border-slate-100 px-5 pt-4 pb-10">
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-2xl font-bold text-slate-900">{finalTotal.toFixed(2)} SAR</Text>
          <TouchableOpacity
            onPress={handlePay}
            disabled={submitting}
            className="px-8 py-4 rounded-2xl min-w-[160px] items-center"
            style={{ backgroundColor: primaryColor }}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Text className="text-white font-bold text-base">
                {paymentMethod === 'apple_pay'
                  ? 'Pay with  Pay'
                  : paymentMethod === 'samsung_pay'
                    ? 'Pay with Samsung Pay'
                    : `Pay ${finalTotal.toFixed(2)} SAR`}
              </Text>
            )}
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => router.push('/terms-modal')} className="self-center">
          <Text className="text-slate-500 text-sm underline">Cancellation Policy</Text>
        </TouchableOpacity>
      </View>

      {/* Payment Method Picker Modal */}
      <Modal visible={showPaymentPicker} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setShowPaymentPicker(false)}
          className="flex-1 bg-black/50 justify-end"
        >
          <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} className="bg-white rounded-t-3xl p-6 pb-10">
            <Text className="text-lg font-bold text-slate-900 mb-4">Select payment method</Text>
            {Platform.OS === 'ios' && (
              <TouchableOpacity
                onPress={() => { setPaymentMethod('apple_pay'); setShowPaymentPicker(false); }}
                className="flex-row items-center py-3 border-b border-slate-100"
              >
                <View className="w-12 h-8 bg-black rounded items-center justify-center">
                  <Text className="text-white font-bold text-xs"> Pay</Text>
                </View>
                <Text className="ml-3 font-medium">Apple Pay</Text>
              </TouchableOpacity>
            )}
            {Platform.OS === 'android' && (
              <TouchableOpacity
                onPress={() => { setPaymentMethod('samsung_pay'); setShowPaymentPicker(false); }}
                className="flex-row items-center py-3 border-b border-slate-100"
              >
                <View className="w-12 h-8 bg-blue-900 rounded items-center justify-center">
                  <Text className="text-white font-bold text-xs">S Pay</Text>
                </View>
                <Text className="ml-3 font-medium">Samsung Pay</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => {
                setPaymentMethod('credit_card');
                setShowPaymentPicker(false);
                setShowPaymentModal(true);
              }}
              className="flex-row items-center py-3"
            >
              <Text className="font-medium">Credit / Debit Card</Text>
              <Text className="text-slate-400 text-sm ml-1">– Enter card or use saved</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Payment Modal - Moyasar (Credit Card only; Apple Pay uses web) */}
      <Modal visible={showPaymentModal} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView className="flex-1 bg-white">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
            <Text className="text-lg font-bold text-slate-800">{paymentLabel}</Text>
            <TouchableOpacity onPress={() => setShowPaymentModal(false)} className="p-2">
              <X size={24} color="#64748b" />
            </TouchableOpacity>
          </View>
          <ScrollView className="flex-1 px-5 py-6" contentContainerStyle={{ paddingBottom: 40 }}>
            {paymentConfig && paymentMethod === 'credit_card' && (
              <CreditCardPayment
                paymentConfig={paymentConfig}
                onPaymentResult={handlePaymentResult}
                style={{
                  textInputs: { color: '#0f172a' },
                  textInputsPlaceholderColor: '#94a3b8',
                }}
              />
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Moyasar Web Page - Apple Pay (opens hosted checkout) */}
      <Modal visible={!!moyasarWebUrl} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView className="flex-1 bg-white">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
            <Text className="text-lg font-bold text-slate-800">
              {paymentMethod === 'samsung_pay' ? 'Pay with Samsung Pay' : 'Pay with Apple Pay'}
            </Text>
            <TouchableOpacity onPress={() => setMoyasarWebUrl(null)} className="p-2">
              <X size={24} color="#64748b" />
            </TouchableOpacity>
          </View>
          {moyasarWebUrl && (
            <WebView
              source={{ uri: moyasarWebUrl }}
              style={{ flex: 1 }}
              onShouldStartLoadWithRequest={(request) => {
                const url = (request as any).url ?? (request as any).nativeEvent?.url ?? '';
                if ((url.includes('alsdraft0://') || url.includes('/api/payment/redirect')) && !paymentSuccessHandled.current) {
                  paymentSuccessHandled.current = true;
                  setMoyasarWebUrl(null);
                  createOrderAfterPayment();
                  return false;
                }
                return true;
              }}
              onNavigationStateChange={(navState) => {
                const url = navState?.url ?? '';
                if ((url.includes('alsdraft0://') || url.includes('/api/payment/redirect')) && !paymentSuccessHandled.current) {
                  paymentSuccessHandled.current = true;
                  setMoyasarWebUrl(null);
                  createOrderAfterPayment();
                  return;
                }
                if (url.includes('moyasar') && (url.includes('callback') || url.includes('return') || url.includes('status=paid'))) {
                  if (!paymentSuccessHandled.current) {
                    paymentSuccessHandled.current = true;
                    setMoyasarWebUrl(null);
                    createOrderAfterPayment();
                  }
                }
              }}
              injectedJavaScript={`
                (function() {
                  var done = false;
                  var check = function() {
                    if (done) return;
                    try {
                      var text = (document.body && document.body.innerText) || '';
                      if (text.indexOf('مدفوعة') >= 0 || text.indexOf('Payment successful') >= 0) {
                        done = true;
                        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('PAYMENT_SUCCESS');
                      }
                    } catch(e) {}
                  };
                  if (document.readyState === 'complete') check();
                  else window.addEventListener('load', check);
                  setTimeout(check, 500);
                  setTimeout(check, 1500);
                })();
                true;
              `}
              onMessage={(e) => {
                if (e.nativeEvent?.data === 'PAYMENT_SUCCESS' && !paymentSuccessHandled.current) {
                  paymentSuccessHandled.current = true;
                  setMoyasarWebUrl(null);
                  createOrderAfterPayment();
                }
              }}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
