import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  Car,
  ChevronRight,
  Clock,
  MapPin,
  Percent,
  Pencil,
  Star,
  X,
} from 'lucide-react-native';
import { DeliveryOptionsPicker } from '../src/components/delivery/DeliveryOptionsPicker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ApplePay as ApplePayButton,
  ApplePayConfig,
  CreditCard as CreditCardPayment,
  CreditCardConfig,
  PaymentConfig,
  PaymentResponse,
  PaymentStatus,
  isMoyasarError,
} from 'react-native-moyasar-sdk';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY, APPLE_PAY_MERCHANT_ID, SAMSUNG_PAY_ENABLED } from '../src/api/config';
import { paymentApi } from '../src/api/payment';
import { otoApi } from '../src/api/oto';
import { calculateNooksPromoDiscount, consumeNooksPromo, fetchNooksPromos } from '../src/api/nooksPromos';
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
import { useCart } from '../src/context/CartContext';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useOperations } from '../src/context/OperationsContext';
import { useOrders } from '../src/context/OrdersContext';
import { useProfile } from '../src/context/ProfileContext';
import { useAuth } from '../src/context/AuthContext';
import { loyaltyApi, type LoyaltyBalance } from '../src/api/loyalty';
import { commitOrder } from '../src/api/orders';

export type PaymentMethod = 'apple_pay' | 'samsung_pay' | 'credit_card';

const VAT_RATE = 0.15; // 15% Saudi VAT

export default function CheckoutScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const {
    cartItems,
    totalPrice,
    orderType,
    selectedBranch,
    deliveryAddress,
    deliveryFee: cartDeliveryFee,
    deliveryOptionId,
    clearCart,
  } = useCart();
  const { merchantId } = useMerchant();
  const { addOrder } = useOrders();
  const { profile } = useProfile();
  const { isClosed, isBusy } = useOperations();
  const {
    primaryColor,
    appName,
    moyasarPublishableKey,
    customerPaymentsEnabled,
    applePayEnabled,
  } = useMerchantBranding();
  const { user } = useAuth();
  const isArabic = i18n.language === 'ar';
  const resolvedPublishableKey = (moyasarPublishableKey || MOYASAR_PUBLISHABLE_KEY || '').trim();
  const resolvedApplePayEnabled = Platform.OS === 'ios' && applePayEnabled && Boolean(APPLE_PAY_MERCHANT_ID);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    resolvedApplePayEnabled ? 'apple_pay' : (SAMSUNG_PAY_ENABLED ? 'samsung_pay' : 'credit_card')
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
  const [draftOrderNote, setDraftOrderNote] = useState('');
  const [carMake, setCarMake] = useState('');
  const [carColor, setCarColor] = useState('');
  const [carPlate, setCarPlate] = useState('');
  const [promoValidating, setPromoValidating] = useState(false);
  const [moyasarWebUrl, setMoyasarWebUrl] = useState<string | null>(null);
  const paymentSuccessHandled = useRef(false);
  const samsungPayInvoiceIdRef = useRef<string | null>(null);
  const orderIdRef = useRef(`order-${Date.now()}`);

  // Loyalty redemption (points, cashback, or stamps)
  const [usePoints, setUsePoints] = useState(false);
  const [loyaltyBalance, setLoyaltyBalance] = useState<LoyaltyBalance | null>(null);
  const [pointsLoading, setPointsLoading] = useState(false);
  const loyaltyType = loyaltyBalance?.loyaltyType ?? 'points';

  useEffect(() => {
    if (!user?.id || !merchantId) return;
    setPointsLoading(true);
    loyaltyApi.getBalance(user.id, merchantId)
      .then((bal) => setLoyaltyBalance(bal))
      .catch(() => {})
      .finally(() => setPointsLoading(false));
  }, [user?.id, merchantId]);

  useEffect(() => {
    if (paymentMethod === 'apple_pay' && !resolvedApplePayEnabled) {
      setPaymentMethod('credit_card');
    }
  }, [paymentMethod, resolvedApplePayEnabled]);

  const deliveryFee = orderType === 'delivery' ? (cartDeliveryFee > 0 ? cartDeliveryFee : 15) : 0;
  const subtotalBeforePromo = totalPrice + deliveryFee;
  const discount = promoApplied ? promoDiscount : 0;
  const subtotalAfterPromo = Math.max(0, subtotalBeforePromo - discount);

  // Loyalty discount: applies to items only (not delivery), after promo
  const itemsAfterPromo = Math.max(0, totalPrice - discount);
  const maxPointsDiscountSar = loyaltyBalance
    ? loyaltyType === 'cashback'
      ? +(loyaltyBalance.cashbackBalance ?? 0)
      : +(loyaltyBalance.points * loyaltyBalance.pointValueSar).toFixed(2)
    : 0;
  const pointsDiscount = usePoints ? Math.min(maxPointsDiscountSar, itemsAfterPromo) : 0;
  const pointsToRedeem = usePoints && loyaltyBalance
    ? loyaltyType === 'cashback'
      ? 0 // cashback is SAR-based, no points to redeem
      : Math.min(loyaltyBalance.points, Math.ceil(pointsDiscount / loyaltyBalance.pointValueSar))
    : 0;

  const subtotalAfterDiscount = Math.max(0, subtotalAfterPromo - pointsDiscount);
  const amountExclVAT = subtotalAfterDiscount / (1 + VAT_RATE);
  const deliveryExclVAT = (orderType === 'delivery' ? deliveryFee : 0) / (1 + VAT_RATE);
  const itemsExclVAT = amountExclVAT - deliveryExclVAT;
  const vatAmount = subtotalAfterDiscount - amountExclVAT;
  const finalTotal = subtotalAfterDiscount;
  const amountHalals = Math.round(finalTotal * 100);

  const paymentConfig = useMemo(() => {
    if (!resolvedPublishableKey || !customerPaymentsEnabled) return null;
    try {
      return new PaymentConfig({
        publishableApiKey: resolvedPublishableKey,
        baseUrl: MOYASAR_BASE_URL,
        amount: Math.max(amountHalals, 100),
        currency: 'SAR',
        merchantCountryCode: 'SA',
        description: `${appName || 'Nooks'} order ${orderIdRef.current}`,
        metadata: {
          order_id: orderIdRef.current,
          ...(merchantId ? { merchant_id: merchantId } : {}),
        },
        supportedNetworks: ['mada', 'visa', 'mastercard', 'amex'],
        creditCard: new CreditCardConfig({ saveCard: false, manual: false }),
        applePay: resolvedApplePayEnabled
          ? new ApplePayConfig({
              merchantId: APPLE_PAY_MERCHANT_ID,
              label: appName || 'Nooks',
              manual: false,
              saveCard: false,
            })
          : undefined,
        createSaveOnlyToken: false,
      });
    } catch {
      return null;
    }
  }, [amountHalals, appName, customerPaymentsEnabled, merchantId, resolvedApplePayEnabled, resolvedPublishableKey]);

  const applyCoupon = async () => {
    const code = (couponInput || promoCode).trim();
    if (!code) return;
    setPromoValidating(true);
    try {
      if (merchantId) {
        const promos = await fetchNooksPromos(merchantId);
        const matched = promos.find((p) => p.code?.toUpperCase() === code.toUpperCase());
        if (matched) {
          // Check expiry date
          if (matched.valid_until) {
            const expiry = new Date(matched.valid_until);
            if (!isNaN(expiry.getTime()) && expiry < new Date()) {
              Alert.alert('Expired Code', 'This promo code has expired.');
              setPromoValidating(false);
              return;
            }
          }
          const discountAmount = calculateNooksPromoDiscount(matched, subtotalBeforePromo);
          if (discountAmount > 0) {
            setPromoDiscount(discountAmount);
            setPromoApplied(true);
            setPromoCode(matched.code);
            setShowCouponInput(false);
            setCouponInput('');
            return;
          }
        }
      }
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

  const openNoteModal = () => {
    setDraftOrderNote(orderNote);
    setShowNoteModal(true);
  };

  const saveOrderNote = () => {
    setOrderNote(draftOrderNote.trim());
    setShowNoteModal(false);
  };

  const createOrderAfterPayment = useCallback(async (moyasarPaymentId?: string) => {
    if (!selectedBranch?.id) return;
    if (!merchantId) {
      Alert.alert('Configuration Error', 'Merchant configuration is missing. Please restart the app and try again.');
      return;
    }
    setSubmitting(true);
    const orderId = orderIdRef.current;
    try {
      const resolvedPaymentId = moyasarPaymentId || orderId;
      if (user?.id) {
        await commitOrder({
          id: orderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Preparing',
          items: cartItems.map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId,
          })),
          orderType,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
          deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
          deliveryFee,
          paymentId: resolvedPaymentId,
          paymentMethod,
          customerName: profile.fullName || null,
          customerPhone: profile.phone || null,
          customerEmail: profile.email || null,
          promoCode: promoApplied ? promoCode : null,
          carDetails: orderType === 'drivethru' ? { make: carMake, color: carColor, plate: carPlate } : null,
          relayToNooks: false,
        });
      }

      let otoId: number | undefined = undefined;
      let otoDispatchStatus: 'success' | 'failed' | undefined;
      let otoDispatchError: string | undefined;
      if (orderType === 'delivery' && selectedBranch?.id && deliveryAddress?.address) {
        const branchOto = getBranchOtoConfig(selectedBranch.id, selectedBranch.name);
        const pickupCode = (selectedBranch as any).oto_warehouse_id || branchOto?.otoPickupLocationCode;
        try {
          const deliveryRes = await otoApi.requestDelivery({
            orderId,
            amount: Number(finalTotal.toFixed(2)),
            merchantId,
            pickupLocationCode: pickupCode,
            deliveryOptionId: deliveryOptionId ?? undefined,
            customer: {
              name: (profile.fullName || 'Customer').trim(),
              phone: (profile.phone || '500000000').trim(),
              email: profile.email || undefined,
            },
            deliveryAddress: {
              address: deliveryAddress.address,
              lat: deliveryAddress.lat,
              lng: deliveryAddress.lng,
              city: deliveryAddress.city,
            },
            branch: {
              name: selectedBranch.name || 'Branch',
              address: selectedBranch.address || undefined,
            },
            items: cartItems.map((i) => ({
              name: i.name,
              price: i.price,
              quantity: i.quantity,
            })),
          });
          if (deliveryRes?.success && typeof deliveryRes.otoId === 'number') {
            otoId = deliveryRes.otoId;
            otoDispatchStatus = 'success';
          } else {
            otoDispatchStatus = 'failed';
            otoDispatchError = 'Dispatch request did not return OTO order id.';
          }
        } catch (err: any) {
          otoDispatchStatus = 'failed';
          otoDispatchError = err?.message || 'Failed to dispatch delivery.';
          console.warn('[Checkout] OTO request failed:', err);
        }
      }
      if (user?.id) {
        await commitOrder({
          id: orderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Preparing',
          items: cartItems.map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId,
          })),
          orderType,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
          deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
          deliveryFee,
          paymentId: resolvedPaymentId,
          paymentMethod,
          otoId: otoId ?? null,
          customerName: profile.fullName || null,
          customerPhone: profile.phone || null,
          customerEmail: profile.email || null,
          promoCode: promoApplied ? promoCode : null,
          relayToNooks: true,
        });
      }
      addOrder(
        {
          total: finalTotal,
          items: [...cartItems],
          orderType,
          merchantId,
          branchName: selectedBranch?.name,
          branchId: selectedBranch?.id,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address : undefined,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat : undefined,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng : undefined,
          otoId,
          otoDispatchStatus,
          otoDispatchError,
          deliveryFee,
          paymentId: resolvedPaymentId,
          paymentMethod: paymentMethod,
          promoCode: promoApplied ? promoCode : undefined,
          customerName: profile.fullName || undefined,
          customerPhone: profile.phone || undefined,
          customerEmail: profile.email || undefined,
          serverPersisted: Boolean(user?.id),
        },
        orderId,
        'Preparing'
      );
      if (promoApplied && promoCode) {
        await consumeNooksPromo(merchantId, promoCode);
      }
      if (usePoints && user?.id && merchantId) {
        try {
          if (loyaltyType === 'cashback' && pointsDiscount > 0) {
            await loyaltyApi.redeemCashback(user.id, pointsDiscount, orderId, merchantId);
          } else if (pointsToRedeem > 0) {
            await loyaltyApi.redeem(user.id, pointsToRedeem, orderId, merchantId);
          }
        } catch (err) {
          console.warn('[Checkout] Loyalty redemption failed:', err);
        }
      }
      clearCart();
      setShowPaymentModal(false);
      setMoyasarWebUrl(null);
      setShowPaymentPicker(false);
      orderIdRef.current = `order-${Date.now()}`;
      router.dismissAll();
      setTimeout(() => router.replace({ pathname: '/order-confirmed', params: { orderId } }), 0);
    } catch (err: any) {
      Alert.alert('Order Failed', err?.message || 'Order could not be created. Please contact support.');
    } finally {
      setSubmitting(false);
    }
  }, [cartItems, finalTotal, orderType, merchantId, selectedBranch, deliveryAddress, deliveryFee, paymentMethod, addOrder, promoApplied, promoCode, profile.fullName, profile.phone, profile.email, clearCart, usePoints, pointsToRedeem, pointsDiscount, loyaltyType, router, user?.id]);

  const handlePaymentResult = useCallback(
    (result: unknown) => {
      setShowPaymentModal(false);
      if (isMoyasarError(result)) {
        Alert.alert('Payment Failed', result.message || 'Payment could not be completed.');
        return;
      }
      if (result instanceof PaymentResponse && result.status === PaymentStatus.paid) {
        createOrderAfterPayment(result.id);
      } else if (result instanceof PaymentResponse && result.status === PaymentStatus.failed) {
        Alert.alert('Payment Failed', 'Your payment was declined. Please try again.');
      } else {
        Alert.alert('Payment', 'Payment was not completed.');
      }
    },
    [createOrderAfterPayment]
  );

  const handlePay = async () => {
    if (isClosed || isBusy) {
      Alert.alert(
        'Ordering Unavailable',
        isClosed
          ? 'Store is currently closed.'
          : 'Store is currently busy and not accepting new orders.'
      );
      return;
    }
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
    if (!merchantId) {
      Alert.alert('Configuration Error', 'Merchant configuration is missing. Please restart the app and try again.');
      return;
    }

    if (!paymentConfig || !resolvedPublishableKey || !customerPaymentsEnabled) {
      Alert.alert(
        'Payment Not Configured',
        'Merchant checkout is not configured yet. Please contact the store.'
      );
      return;
    }
    if (paymentMethod === 'apple_pay' && Platform.OS !== 'ios') {
      Alert.alert('Apple Pay', 'Apple Pay is only available on iOS.');
      return;
    }
    if (paymentMethod === 'apple_pay' && !resolvedApplePayEnabled) {
      Alert.alert('Apple Pay', 'Apple Pay is not ready for this merchant yet. Please use card payment.');
      return;
    }
    if (paymentMethod === 'samsung_pay' && Platform.OS !== 'android') {
      Alert.alert('Samsung Pay', 'Samsung Pay is only available on Android.');
      return;
    }
    if (paymentMethod === 'samsung_pay' && !SAMSUNG_PAY_ENABLED) {
      Alert.alert('Samsung Pay', 'Samsung Pay is not configured for this merchant yet. Please use card payment.');
      return;
    }

    if (paymentMethod === 'apple_pay') {
      return;
    }

    if (paymentMethod === 'samsung_pay') {
      paymentSuccessHandled.current = false;
      setSubmitting(true);
      try {
        const samsungOrderId = orderIdRef.current;
        if (user?.id) {
          await commitOrder({
            id: samsungOrderId,
            merchantId,
            branchId: selectedBranch.id,
            branchName: selectedBranch.name ?? null,
            totalSar: Number(finalTotal.toFixed(2)),
            status: 'Pending',
            items: cartItems.map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price,
              quantity: item.quantity,
              image: item.image,
              customizations: item.customizations ?? null,
              uniqueId: item.uniqueId,
            })),
            orderType,
            deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
            deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
            deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
            deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
            deliveryFee,
            paymentMethod,
            customerName: profile.fullName || null,
            customerPhone: profile.phone || null,
            customerEmail: profile.email || null,
            promoCode: promoApplied ? promoCode : null,
            relayToNooks: false,
          });
        }
        const session = await paymentApi.initiate({
          amount: finalTotal,
          currency: 'SAR',
          orderId: samsungOrderId,
          merchantId,
          successUrl: 'alsdraft0://payment/success',
        });
        samsungPayInvoiceIdRef.current = session.id;
        if (session.url) {
          setMoyasarWebUrl(session.url);
        } else {
          Alert.alert('Payment Error', 'Could not open payment page. Please try again.');
        }
      } catch (err: unknown) {
        Alert.alert(isArabic ? 'خطأ في الدفع' : 'Payment Error', err instanceof Error ? err.message : (isArabic ? 'تعذر بدء عملية الدفع.' : 'Failed to start payment.'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setShowPaymentModal(true);
  };

  const paymentLabel =
    paymentMethod === 'apple_pay'
      ? '\uF8FF Apple Pay'
      : paymentMethod === 'samsung_pay'
        ? 'Samsung Pay'
        : isArabic ? 'بطاقة ائتمانية / مدى' : 'Credit / Debit Card';

  if (cartItems.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center px-6">
        <Text className="text-slate-600 text-center mb-4">{isArabic ? 'سلتك فارغة' : 'Your cart is empty'}</Text>
        <TouchableOpacity onPress={() => router.back()} className="px-6 py-3 rounded-2xl" style={{ backgroundColor: primaryColor }}>
          <Text className="text-white font-bold">{isArabic ? 'العودة إلى السلة' : 'Back to Cart'}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center px-5 py-4 border-b border-slate-100 bg-white">
        <TouchableOpacity onPress={() => router.back()} className="bg-slate-100 p-2 rounded-full">
          <ArrowLeft size={22} color="#334155" />
        </TouchableOpacity>
        <Text className="flex-1 text-center text-lg font-bold text-slate-900">{isArabic ? 'الدفع' : 'Checkout'}</Text>
        <View className="w-10" />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 200 }}
      >
        <View className="px-5 pt-5">
          {/* Delivery & Order Details (display only, no change) */}
          <View className="bg-slate-50 rounded-[28px] border border-slate-100 overflow-hidden">
            <View className="flex-row items-center px-4 py-4">
              <View className="w-11 h-11 rounded-2xl items-center justify-center" style={{ backgroundColor: `${primaryColor}18` }}>
                <MapPin size={20} color={primaryColor} />
              </View>
              <View className="flex-1 ml-3">
                <Text className="text-slate-500 text-xs font-bold uppercase tracking-widest">{orderType === 'delivery' ? (isArabic ? 'التوصيل إلى' : 'Delivery to') : (isArabic ? 'الاستلام من' : 'Pickup from')}</Text>
                <Text className="text-slate-900 font-bold text-base" numberOfLines={1}>
                  {orderType === 'delivery' ? deliveryAddress?.address || '—' : selectedBranch?.name || '—'}
                </Text>
              </View>
            </View>
            <View className="h-px bg-slate-200 ml-[70px]" />
            <View className="flex-row items-center px-4 py-4">
              <View className="w-11 h-11 rounded-2xl items-center justify-center bg-white border border-slate-200">
                <Clock size={20} color="#64748b" />
              </View>
              <View className="flex-1 ml-3">
                <Text className="text-slate-500 text-xs font-bold uppercase tracking-widest">{isArabic ? 'الوقت المتوقع' : 'Expected time'}</Text>
                <Text className="text-slate-900 font-bold text-base">{isArabic ? 'حوالي 30 دقيقة' : '~ 30 minutes'}</Text>
              </View>
            </View>
            <View className="h-px bg-slate-200 ml-[70px]" />
            <TouchableOpacity
              onPress={openNoteModal}
              className="flex-row items-center px-4 py-4"
            >
              <View className="w-11 h-11 rounded-2xl items-center justify-center bg-white border border-slate-200">
                <Pencil size={20} color="#64748b" />
              </View>
              <View className="flex-1 ml-3">
                <Text className="text-slate-900 font-bold">{orderNote || (isArabic ? 'اكتب ملاحظة' : 'Write a note')}</Text>
                <Text className="text-slate-400 text-xs mt-0.5">
                  {isArabic ? 'أضف تعليمات للطلب إن لزم' : 'Add instructions for your order if needed'}
                </Text>
              </View>
              <ChevronRight size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Delivery Options Picker */}
          {orderType === 'delivery' && deliveryAddress && (
            <View className="mt-4">
              <DeliveryOptionsPicker accentColor={primaryColor} />
            </View>
          )}

          {/* Curbside / Drive-thru Car Details */}
          {orderType === 'drivethru' && (
            <View className="mt-4 bg-slate-50 rounded-[28px] border border-slate-100 p-4">
              <View className="flex-row items-center mb-3">
                <Car size={20} color={primaryColor} />
                <Text className="font-bold text-slate-900 ml-2">{isArabic ? 'تفاصيل السيارة' : 'Car Details'}</Text>
              </View>
              <TextInput
                className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm mb-2"
                placeholder={isArabic ? 'نوع السيارة (مثل: تويوتا كامري)' : 'Car make (e.g. Toyota Camry)'}
                value={carMake}
                onChangeText={setCarMake}
              />
              <TextInput
                className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm mb-2"
                placeholder={isArabic ? 'لون السيارة' : 'Car color'}
                value={carColor}
                onChangeText={setCarColor}
              />
              <TextInput
                className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm"
                placeholder={isArabic ? 'رقم اللوحة' : 'Plate number'}
                value={carPlate}
                onChangeText={setCarPlate}
              />
            </View>
          )}

          {/* Promo / Coupon */}
          <View className="mt-5">
            {showCouponInput ? (
              <View className="rounded-[28px] border border-slate-100 bg-slate-50 p-4">
                <View className="flex-row items-center border-2 border-dashed border-slate-200 rounded-2xl px-4 py-3">
                  <Percent size={18} color="#94a3b8" />
                <TextInput
                  placeholder={isArabic ? 'أدخل كود الخصم' : 'Enter promo code'}
                  value={couponInput}
                  onChangeText={setCouponInput}
                  className="flex-1 text-slate-900 font-medium ml-3"
                  autoCapitalize="characters"
                />
                </View>
                <View className="flex-row mt-3">
                  <TouchableOpacity
                    onPress={applyCoupon}
                    disabled={promoValidating}
                    className="flex-1 items-center py-3 rounded-2xl mr-3 disabled:opacity-60"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {promoValidating ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text className="text-white font-bold">{isArabic ? 'تطبيق' : 'Apply'}</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setShowCouponInput(false); setCouponInput(''); }} className="px-5 justify-center rounded-2xl bg-white border border-slate-200">
                    <Text className="text-slate-500 font-bold">{isArabic ? 'إلغاء' : 'Cancel'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : promoApplied ? (
              <TouchableOpacity
                onPress={removeCoupon}
                className="rounded-[28px] p-4 flex-row items-center justify-between border"
                style={{ borderColor: `${primaryColor}30`, backgroundColor: `${primaryColor}08` }}
              >
                <View className="flex-row items-center">
                  <View className="w-11 h-11 rounded-2xl items-center justify-center bg-white">
                    <Percent size={20} color={primaryColor} />
                  </View>
                  <View className="ml-3">
                    <Text className="font-bold" style={{ color: primaryColor }}>{isArabic ? `تم تطبيق ${promoCode}` : `${promoCode} applied`}</Text>
                    <Text className="text-slate-400 text-xs">{isArabic ? 'اضغط لإزالة الكود' : 'Tap to remove code'}</Text>
                  </View>
                </View>
                <View className="flex-row items-center"><Text className="text-slate-500 text-sm">−</Text><PriceWithSymbol amount={promoDiscount} iconSize={14} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 14 }} /></View>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={() => setShowCouponInput(true)}
                className="border-2 border-dashed border-slate-200 rounded-[28px] p-5 flex-row items-center justify-center bg-slate-50"
              >
                <Percent size={18} color="#94a3b8" />
                <Text className="text-slate-500 font-medium ml-2">{isArabic ? 'إضافة كود خصم أو كوبون' : 'Add promo code or coupon'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Loyalty Redemption Toggle (points or cashback) */}
          {user?.id && loyaltyBalance && loyaltyType !== 'stamps' && (
            (loyaltyType === 'cashback' ? (loyaltyBalance.cashbackBalance ?? 0) > 0 : loyaltyBalance.points > 0) && (
            <TouchableOpacity
              onPress={() => setUsePoints(!usePoints)}
              className="mt-5 rounded-[28px] p-4 flex-row items-center justify-between"
              style={{
                borderWidth: 1,
                borderColor: usePoints ? primaryColor : '#e2e8f0',
                backgroundColor: usePoints ? `${primaryColor}08` : '#f8fafc',
              }}
              activeOpacity={0.7}
            >
              <View className="flex-row items-center flex-1">
                <View
                  style={{
                    width: 36, height: 36, borderRadius: 18,
                    backgroundColor: usePoints ? primaryColor : '#f1f5f9',
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Star size={18} color={usePoints ? '#fff' : '#94a3b8'} fill={usePoints ? '#fff' : 'none'} />
                </View>
                <View className="ml-3 flex-1">
                  <Text className="font-bold text-slate-900">
                    {loyaltyType === 'cashback'
                      ? (isArabic ? `استخدم ${(loyaltyBalance.cashbackBalance ?? 0).toFixed(2)} ر.س كاش باك` : `Use ${(loyaltyBalance.cashbackBalance ?? 0).toFixed(2)} SAR cashback`)
                      : (isArabic ? `استخدم ${loyaltyBalance.points} نقطة` : `Use ${loyaltyBalance.points} points`)
                    }
                  </Text>
                  <View className="flex-row items-center flex-wrap mt-0.5">
                    <Text className="text-slate-500 text-xs">{isArabic ? 'وفّر حتى ' : 'Save up to '}</Text>
                    <PriceWithSymbol amount={Math.min(maxPointsDiscountSar, itemsAfterPromo)} iconSize={12} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 12 }} />
                  </View>
                </View>
              </View>
              <View
                style={{
                  width: 44, height: 26, borderRadius: 13,
                  backgroundColor: usePoints ? primaryColor : '#cbd5e1',
                  justifyContent: 'center',
                  paddingHorizontal: 2,
                }}
              >
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 11,
                    backgroundColor: '#fff',
                    alignSelf: usePoints ? 'flex-end' : 'flex-start',
                    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15, shadowRadius: 2, elevation: 2,
                  }}
                />
              </View>
            </TouchableOpacity>
          ))}

          {/* Order Summary */}
          <View className="mt-6 rounded-[28px] bg-slate-50 border border-slate-100 p-5">
            <Text className="text-slate-900 text-lg font-bold mb-4">{isArabic ? 'ملخص الدفع' : 'Payment Summary'}</Text>
            <View className="flex-row justify-between">
              <Text className="text-slate-900 font-medium">{isArabic ? 'المبلغ بدون الضريبة' : 'Amount excl. VAT'}</Text>
              <PriceWithSymbol amount={itemsExclVAT} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
            </View>
            <View className="flex-row justify-between mt-1">
              <Text className="text-slate-900 font-medium">{isArabic ? 'رسوم التوصيل بدون الضريبة' : 'Delivery fee excl. VAT'}</Text>
              <PriceWithSymbol amount={deliveryExclVAT} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
            </View>
            <View className="flex-row justify-between mt-1">
              <Text className="text-slate-900 font-medium">VAT</Text>
              <PriceWithSymbol amount={vatAmount} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
            </View>
            {promoApplied && discount > 0 && (
              <View className="flex-row justify-between mt-1">
                <Text className="text-slate-900 font-medium">{isArabic ? 'خصم العرض' : 'Promo discount'}</Text>
                <PriceWithSymbol amount={discount} prefix="- " iconSize={16} iconColor="#059669" textStyle={{ color: '#059669', fontWeight: '700' }} />
              </View>
            )}
            {usePoints && pointsDiscount > 0 && (
              <View className="flex-row justify-between mt-1">
                <Text className="text-slate-900 font-medium">{isArabic ? `النقاط (${pointsToRedeem} نقطة)` : `Points (${pointsToRedeem} pts)`}</Text>
                <PriceWithSymbol amount={pointsDiscount} prefix="- " iconSize={16} iconColor="#059669" textStyle={{ color: '#059669', fontWeight: '700' }} />
              </View>
            )}
            <View className="flex-row justify-between mt-4 pt-4 border-t border-slate-200">
              <Text className="text-slate-900 font-bold">{isArabic ? 'الإجمالي شامل الضريبة' : 'Total VAT included'}</Text>
              <PriceWithSymbol amount={finalTotal} iconSize={18} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 18 }} />
            </View>
          </View>

          {/* Payment Method */}
          <View className="mt-8">
            <Text className="text-slate-500 text-sm mb-2">{isArabic ? 'طريقة الدفع المختارة' : 'Selected payment method'}</Text>
            <TouchableOpacity
              onPress={() => setShowPaymentPicker(true)}
              className="flex-row items-center bg-slate-50 rounded-[28px] p-4 border border-slate-100"
            >
              {paymentMethod === 'apple_pay' ? (
                <View className="w-12 h-8 bg-black rounded" style={{ justifyContent: 'center', alignItems: 'center' }}>
                  <Text className="text-white font-bold text-xs">{'\uF8FF'} Pay</Text>
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
        <View className="rounded-[28px] bg-slate-50 border border-slate-100 p-4">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-slate-400 text-xs font-bold uppercase tracking-widest">
                {isArabic ? 'الإجمالي' : 'Total'}
              </Text>
              <PriceWithSymbol amount={finalTotal} iconSize={24} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 24 }} />
            </View>
          {paymentMethod === 'apple_pay' && resolvedApplePayEnabled && paymentConfig ? (
            <View style={{ width: 180, height: 50 }}>
              <ApplePayButton
                paymentConfig={paymentConfig}
                onPaymentResult={handlePaymentResult}
                style={{ buttonType: 'buy', buttonStyle: 'black', height: 50, width: '100%', cornerRadius: 16 }}
              />
            </View>
          ) : (
            <TouchableOpacity
              onPress={handlePay}
              disabled={submitting}
              className="px-6 py-4 rounded-[24px] min-w-[190px] items-center flex-row justify-center"
              style={{ backgroundColor: primaryColor }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : paymentMethod === 'samsung_pay' ? (
                <Text className="text-white font-bold text-base">{isArabic ? 'الدفع عبر Samsung Pay' : 'Pay with Samsung Pay'}</Text>
              ) : (
                <View className="flex-row items-center">
                  <Text className="text-white font-bold text-base mr-2">{isArabic ? 'إتمام الطلب' : 'Complete Order'}</Text>
                  <ChevronRight size={18} color="white" />
                </View>
              )}
            </TouchableOpacity>
          )}
          </View>
        </View>
        <TouchableOpacity onPress={() => router.push('/terms-modal')} className="self-center">
          <Text className="text-slate-500 text-sm underline">{isArabic ? 'سياسة الإلغاء' : 'Cancellation Policy'}</Text>
        </TouchableOpacity>
      </View>

      {/* Note Modal */}
      <Modal visible={showNoteModal} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setShowNoteModal(false)}
          className="flex-1 bg-black/50 justify-end"
        >
          <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} className="bg-white rounded-t-[32px] p-6 pb-10">
            <Text className="text-lg font-bold text-slate-900 mb-2">{isArabic ? 'ملاحظة الطلب' : 'Order Note'}</Text>
            <Text className="text-slate-500 mb-4">{isArabic ? 'أضف تعليمات للطلب إن لزم' : 'Add special instructions if needed'}</Text>
            <View className="rounded-[24px] border border-slate-200 bg-slate-50 p-4">
              <TextInput
                value={draftOrderNote}
                onChangeText={setDraftOrderNote}
                placeholder={isArabic ? 'اكتب ملاحظتك هنا' : 'Write your note here'}
                multiline
                textAlignVertical="top"
                style={{ minHeight: 120, color: '#0f172a' }}
              />
            </View>
            <View className="flex-row mt-4">
              <TouchableOpacity
                onPress={() => setShowNoteModal(false)}
                className="flex-1 py-3 rounded-2xl bg-slate-100 items-center mr-3"
              >
                <Text className="font-bold text-slate-600">{isArabic ? 'إلغاء' : 'Cancel'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveOrderNote}
                className="flex-1 py-3 rounded-2xl items-center"
                style={{ backgroundColor: primaryColor }}
              >
                <Text className="font-bold text-white">{isArabic ? 'حفظ' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Payment Method Picker Modal */}
      <Modal visible={showPaymentPicker} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setShowPaymentPicker(false)}
          className="flex-1 bg-black/50 justify-end"
        >
          <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} className="bg-white rounded-t-[32px] p-6 pb-10">
            <Text className="text-lg font-bold text-slate-900 mb-4">{isArabic ? 'اختر طريقة الدفع' : 'Select payment method'}</Text>
            {resolvedApplePayEnabled && (
              <TouchableOpacity
                onPress={() => { setPaymentMethod('apple_pay'); setShowPaymentPicker(false); }}
                className="flex-row items-center py-4 px-4 mb-3 rounded-[24px] bg-slate-50 border border-slate-100"
              >
                <View className="w-12 h-8 bg-black rounded items-center justify-center">
                  <Text className="text-white font-bold text-xs">{'\uF8FF'} Pay</Text>
                </View>
                <Text className="ml-3 font-bold text-slate-900">{'\uF8FF'} Apple Pay</Text>
              </TouchableOpacity>
            )}
            {Platform.OS === 'android' && SAMSUNG_PAY_ENABLED && (
              <TouchableOpacity
                onPress={() => { setPaymentMethod('samsung_pay'); setShowPaymentPicker(false); }}
                className="flex-row items-center py-4 px-4 mb-3 rounded-[24px] bg-slate-50 border border-slate-100"
              >
                <View className="w-12 h-8 bg-blue-900 rounded items-center justify-center">
                  <Text className="text-white font-bold text-xs">S Pay</Text>
                </View>
                <Text className="ml-3 font-bold text-slate-900">Samsung Pay</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => {
                setPaymentMethod('credit_card');
                setShowPaymentPicker(false);
                setShowPaymentModal(true);
              }}
              className="flex-row items-center py-4 px-4 rounded-[24px] bg-slate-50 border border-slate-100"
            >
              <View className="w-12 h-10 bg-white rounded-xl items-center justify-center border border-slate-200">
                <Text className="text-slate-600 font-bold text-xs">••••</Text>
              </View>
              <View className="ml-3 flex-1">
                <Text className="font-bold text-slate-900">{isArabic ? 'بطاقة ائتمانية / مدى' : 'Credit / Debit Card'}</Text>
                <Text className="text-slate-400 text-sm">{isArabic ? 'أدخل البطاقة أو استخدم المحفوظ' : 'Enter card or use saved'}</Text>
              </View>
              <ChevronRight size={18} color="#94a3b8" />
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

      {/* Moyasar Web Page - Samsung Pay (opens hosted checkout) */}
      <Modal visible={!!moyasarWebUrl} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView className="flex-1 bg-white">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
            <Text className="text-lg font-bold text-slate-800">الدفع عبر Samsung Pay</Text>
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
                  createOrderAfterPayment(samsungPayInvoiceIdRef.current || undefined);
                  return false;
                }
                return true;
              }}
              onNavigationStateChange={(navState) => {
                const url = navState?.url ?? '';
                if ((url.includes('alsdraft0://') || url.includes('/api/payment/redirect')) && !paymentSuccessHandled.current) {
                  paymentSuccessHandled.current = true;
                  setMoyasarWebUrl(null);
                  createOrderAfterPayment(samsungPayInvoiceIdRef.current || undefined);
                  return;
                }
                if (url.includes('moyasar') && (url.includes('callback') || url.includes('return') || url.includes('status=paid'))) {
                  if (!paymentSuccessHandled.current) {
                    paymentSuccessHandled.current = true;
                    setMoyasarWebUrl(null);
                    createOrderAfterPayment(samsungPayInvoiceIdRef.current || undefined);
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
                  createOrderAfterPayment(samsungPayInvoiceIdRef.current || undefined);
                }
              }}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
