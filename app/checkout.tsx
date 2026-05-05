import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Car,
  ChevronRight,
  Clock,
  CreditCard,
  MapPin,
  Percent,
  Pencil,
  Plus,
  Smartphone,
  Star,
  Trash2,
  Wallet,
  X } from 'lucide-react-native';
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
  View } from 'react-native';
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
  isMoyasarError } from 'react-native-moyasar-sdk';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY, APPLE_PAY_MERCHANT_ID, SAMSUNG_PAY_ENABLED } from '../src/api/config';
import { paymentApi, type SavedCard } from '../src/api/payment';
import { walletApi } from '../src/api/wallet';
import { getDeliveryQuote } from '../src/api/deliveryQuote';
import { calculateNooksPromoDiscount, consumeNooksPromo, fetchNooksPromos } from '../src/api/nooksPromos';
import { validatePromoCode } from '../src/api/promo';

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
import { useMenu } from '../src/hooks/useMenu';
import { readCache, writeCache } from '../src/lib/persistentCache';

// Wallet is no longer one of these — it's a redeemable credit
// applied via the useWallet toggle (see the cashback-style row in
// render). Card / Apple Pay handles the post-wallet remainder.
export type PaymentMethod = 'apple_pay' | 'samsung_pay' | 'credit_card' | 'stcpay' | 'saved_card';

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
    clearCart } = useCart();
  const { merchantId } = useMerchant();
  const { addOrder } = useOrders();
  const { profile } = useProfile();
  const { isClosed, isBusy, isPickupOnly } = useOperations();
  const {
    primaryColor,
    appName,
    moyasarPublishableKey,
    customerPaymentsEnabled,
    applePayEnabled,
    applePayMerchantId: brandingApplePayMerchantId } = useMerchantBranding();
  const { user } = useAuth();
  const isArabic = i18n.language === 'ar';
  const resolvedPublishableKey = (moyasarPublishableKey || MOYASAR_PUBLISHABLE_KEY || '').trim();
  const resolvedApplePayMerchantId = (APPLE_PAY_MERCHANT_ID || brandingApplePayMerchantId || '').trim();
  const resolvedApplePayEnabled = Platform.OS === 'ios' && applePayEnabled && Boolean(resolvedApplePayMerchantId);

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
  // Where the discount applies — drives both the UI ("delivery free!"
  // vs "10 off your subtotal") and the Foodics order body (delivery
  // promos shrink charges[].amount, subtotal promos scale the line
  // unit_prices).
  const [promoScope, setPromoScope] = useState<'total' | 'delivery'>('total');
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

  // STC Pay flow state
  const [showStcPaySheet, setShowStcPaySheet] = useState(false);
  const [stcPayMobile, setStcPayMobile] = useState('');
  const [stcPayStep, setStcPayStep] = useState<'mobile' | 'otp'>('mobile');
  const [stcPayOtp, setStcPayOtp] = useState('');
  const [stcPayPaymentId, setStcPayPaymentId] = useState<string | null>(null);
  const [stcPayLoading, setStcPayLoading] = useState(false);
  const [stcPayCountdown, setStcPayCountdown] = useState(0);
  const stcPayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Saved cards (tokenization)
  const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
  const [selectedSavedCardId, setSelectedSavedCardId] = useState<string | null>(null);
  const [saveCardChecked, setSaveCardChecked] = useState(false);
  const [tokenPayLoading, setTokenPayLoading] = useState(false);

  // Fetch saved cards on mount AND whenever this screen regains focus
  // (the user returns from /add-card-modal after saving a new card).
  // We always promote the most-recently-saved card to selected so the
  // Pay button's "current" payment method matches what the user just
  // added.
  const loadSavedCards = useCallback(async () => {
    if (!user?.id || !merchantId) return;
    const cacheKey = `@als_saved_cards_${merchantId}_${user.id}`;
    // Hydrate saved cards from disk so the "•••• 4242" row paints
    // instantly when the customer opens the checkout — no half-second
    // gap where the Pay button briefly says "credit card" and then
    // flips to "saved card".
    const cached = await readCache<SavedCard[]>(cacheKey);
    if (cached?.length) {
      setSavedCards(cached);
      setSelectedSavedCardId((prev) => {
        if (prev && cached.some((c) => c.id === prev)) return prev;
        return cached[0].id;
      });
      setPaymentMethod((prev) => (prev === 'apple_pay' || prev === 'samsung_pay' ? prev : 'saved_card'));
    }
    try {
      const cards = await paymentApi.getSavedCards(merchantId);
      setSavedCards(cards);
      writeCache<SavedCard[]>(cacheKey, cards);
      if (cards.length > 0) {
        setSelectedSavedCardId((prev) => {
          // Keep the prior selection if it's still in the list,
          // otherwise jump to the most recent card.
          if (prev && cards.some((c) => c.id === prev)) return prev;
          return cards[0].id;
        });
        setPaymentMethod((prev) => (prev === 'apple_pay' || prev === 'samsung_pay' ? prev : 'saved_card'));
      }
    } catch {
      /* network blip — keep prior list */
    }
  }, [user?.id, merchantId]);

  useEffect(() => {
    loadSavedCards();
  }, [loadSavedCards]);

  useFocusEffect(
    useCallback(() => {
      loadSavedCards();
    }, [loadSavedCards]),
  );

  // Loyalty redemption (points, cashback, or stamps)
  const [usePoints, setUsePoints] = useState(false);
  const [loyaltyBalance, setLoyaltyBalance] = useState<LoyaltyBalance | null>(null);
  const [pointsLoading, setPointsLoading] = useState(false);
  const loyaltyType = loyaltyBalance?.loyaltyType ?? 'points';

  // Stamp milestone redemptions selected by the customer (free reward items added to the order)
  const [selectedMilestoneIds, setSelectedMilestoneIds] = useState<Set<string>>(new Set());

  // Delivery fee quote from Foodics. Re-runs whenever the branch or
  // delivery coordinates change. `withinServiceArea === false` blocks
  // the Pay button because the customer's address falls outside every
  // zone the merchant configured inside Foodics — letting them pay
  // anyway would produce an order the kitchen can't fulfil.
  const [deliveryQuoteLoading, setDeliveryQuoteLoading] = useState(false);
  const [deliveryQuoteFee, setDeliveryQuoteFee] = useState<number | null>(null);
  // Start as `false` so the Pay button is disabled until either (a) the
  // /delivery-quote API confirms the address is in zone for delivery
  // orders, or (b) the order-type effect flips it to true for pickup.
  // Previous default of `true` was racy — a fast tap before the quote
  // resolved sailed past the Pay-disabled check.
  const [deliveryQuoteWithin, setDeliveryQuoteWithin] = useState<boolean>(false);
  const [deliveryQuoteReason, setDeliveryQuoteReason] = useState<'out_of_zone' | 'error' | null>(null);
  const toggleMilestone = useCallback((milestoneId: string) => {
    setSelectedMilestoneIds((prev) => {
      const next = new Set(prev);
      if (next.has(milestoneId)) next.delete(milestoneId);
      else next.add(milestoneId);
      return next;
    });
  }, []);

  // Menu products — used to look up Foodics reward items and add them as free line items
  const { products: menuProducts } = useMenu();

  /**
   * Filtered list of redemptions the customer can ACTUALLY use in this
   * order. The server pre-creates a redemption row whenever stamps cross
   * a milestone, but doesn't delete the row when stamps drop back below
   * (e.g. after redeeming a higher-tier milestone first). Without this
   * filter the UI shows "stamp 2 reward available" to a customer who
   * only has 1 stamp left and lets them try to redeem — server then
   * rejects but the order goes through with the free item. We close
   * that path by hiding any redemption whose milestone the customer
   * can't currently afford.
   */
  const eligibleRedemptions = useMemo(() => {
    if (!loyaltyBalance) return [];
    return loyaltyBalance.availableRedemptions.filter((r) => {
      const milestone = loyaltyBalance.stampMilestones.find((m) => m.id === r.milestone_id);
      return milestone != null && loyaltyBalance.stamps >= milestone.stamp_number;
    });
  }, [loyaltyBalance]);

  /**
   * Free line items to attach to the order for each selected stamp milestone.
   * Skips milestones the customer can no longer afford — defense in depth
   * against a stale UI letting them select something the eligibleRedemptions
   * filter would have hidden.
   */
  const rewardItemsForOrder = useMemo(() => {
    if (!loyaltyBalance || selectedMilestoneIds.size === 0) return [];
    const out: Array<{ id: string; name: string; price: number; quantity: number; image: string; customizations: null; uniqueId: string }> = [];
    // Aggregate stamps required across every selected milestone so a
    // customer with 5 stamps can't claim milestone-2 + milestone-4
    // simultaneously (sum = 6, exceeds balance) — server-side atomic
    // deduction would catch the second one but we'd rather refuse here.
    let stampsBudget = loyaltyBalance.stamps;
    for (const milestoneId of selectedMilestoneIds) {
      const milestone = loyaltyBalance.stampMilestones.find((m) => m.id === milestoneId);
      if (!milestone) continue;
      if (stampsBudget < milestone.stamp_number) continue;
      stampsBudget -= milestone.stamp_number;
      for (const foodicsId of milestone.foodics_product_ids ?? []) {
        const product = menuProducts.find((p) => p.foodicsProductId === foodicsId);
        if (!product) continue;
        out.push({
          id: product.id,
          name: `🎁 ${product.name}`,
          price: 0,
          quantity: 1,
          image: product.image ?? '',
          customizations: null,
          uniqueId: `reward-${milestone.id}-${foodicsId}` });
      }
    }
    return out;
  }, [loyaltyBalance, selectedMilestoneIds, menuProducts]);

  useEffect(() => {
    if (!user?.id || !merchantId) return;
    let cancelled = false;
    const cacheKey = `@als_loyalty_balance_${merchantId}_${user.id}`;
    // SWR: paint cached balance + stamps + cashback IMMEDIATELY so
    // the "Use cashback" / "Use stamps" rows on checkout don't sit
    // empty for 500-1500 ms while the network call resolves. Same
    // cache key is shared with the offers screen via readCache so a
    // recent open of /(tabs)/offers warms checkout for free.
    readCache<LoyaltyBalance>(cacheKey).then((cached) => {
      if (cancelled || !cached) return;
      setLoyaltyBalance(cached);
      setPointsLoading(false);
    });
    setPointsLoading(true);
    loyaltyApi.getBalance(user.id, merchantId)
      .then((bal) => {
        if (cancelled) return;
        setLoyaltyBalance(bal);
        if (bal) writeCache<LoyaltyBalance>(cacheKey, bal);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPointsLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id, merchantId]);

  // Wallet balance — drives the "Use wallet credit" toggle (mirrors
  // the cashback redemption pattern). The wallet is no longer a
  // payment method on its own; instead, toggling it on applies the
  // smaller of (balance, final total) as a discount, and the chosen
  // card / Apple Pay covers the remainder.
  const [walletBalanceSar, setWalletBalanceSar] = useState<number | null>(null);
  const [useWallet, setUseWallet] = useState(false);
  const reloadWalletBalance = useCallback(async () => {
    if (!user?.id || !merchantId) {
      setWalletBalanceSar(null);
      return;
    }
    const cacheKey = `@als_wallet_balance_${merchantId}_${user.id}`;
    // SWR: cached wallet balance paints instantly so the "Use wallet
    // credit" row shows the SAR amount the moment the screen opens.
    // Stale-by-a-few-seconds is acceptable here because the toggle is
    // a hint — the server re-validates the actual debit on order
    // submission, so a stale-display can never overspend.
    const cached = await readCache<number>(cacheKey);
    if (cached != null) setWalletBalanceSar(cached);
    try {
      const b = await walletApi.getBalance(merchantId);
      setWalletBalanceSar(b.balance_sar);
      writeCache<number>(cacheKey, b.balance_sar);
    } catch {
      // Best-effort — keep prior value on transient errors.
    }
  }, [user?.id, merchantId]);
  useEffect(() => { void reloadWalletBalance(); }, [reloadWalletBalance]);
  // Refresh on focus so a top-up done in /wallet-modal lands here as
  // soon as the customer comes back to checkout.
  useFocusEffect(useCallback(() => { void reloadWalletBalance(); }, [reloadWalletBalance]));

  // Pre-fill STC Pay mobile from profile
  useEffect(() => {
    if (profile.phone && !stcPayMobile) {
      const cleaned = profile.phone.replace(/\D/g, '');
      // Convert +966XXXXXXXXX or 966XXXXXXXXX to 05XXXXXXXX
      if (cleaned.startsWith('966') && cleaned.length >= 12) {
        setStcPayMobile('0' + cleaned.slice(3));
      } else if (cleaned.startsWith('05') && cleaned.length === 10) {
        setStcPayMobile(cleaned);
      }
    }
  }, [profile.phone]);

  // Cleanup STC Pay countdown timer
  useEffect(() => {
    return () => {
      if (stcPayTimerRef.current) clearInterval(stcPayTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (paymentMethod === 'apple_pay' && !resolvedApplePayEnabled) {
      setPaymentMethod('credit_card');
    }
  }, [paymentMethod, resolvedApplePayEnabled]);

  // Fetch the delivery fee from Foodics whenever the customer's address
  // or branch changes. Cart items don't affect the fee (it's zone-keyed)
  // so they're intentionally left out of the dep array to avoid
  // re-quoting on every + / − tap. For pickup orders we clear the quote
  // state so a previous delivery quote doesn't leak into the UI.
  useEffect(() => {
    if (orderType !== 'delivery') {
      setDeliveryQuoteFee(null);
      setDeliveryQuoteWithin(true);
      setDeliveryQuoteReason(null);
      setDeliveryQuoteLoading(false);
      return;
    }
    if (!merchantId || !selectedBranch?.id || !deliveryAddress?.lat || !deliveryAddress?.lng) {
      setDeliveryQuoteFee(null);
      setDeliveryQuoteWithin(true);
      setDeliveryQuoteReason(null);
      setDeliveryQuoteLoading(false);
      return;
    }
    let cancelled = false;
    setDeliveryQuoteLoading(true);
    (async () => {
      const quote = await getDeliveryQuote({
        merchantId,
        branchId: selectedBranch.id,
        items: cartItems.map((i) => ({
          product_id: i.id,
          quantity: i.quantity,
          price_sar: i.basePrice ?? i.price })),
        lat: deliveryAddress.lat!,
        lng: deliveryAddress.lng!,
        address: deliveryAddress.address });
      if (cancelled) return;
      if (quote.withinServiceArea) {
        setDeliveryQuoteFee(quote.feeSar);
        setDeliveryQuoteWithin(true);
        setDeliveryQuoteReason(null);
      } else {
        setDeliveryQuoteFee(null);
        setDeliveryQuoteWithin(false);
        setDeliveryQuoteReason(quote.reason);
      }
      setDeliveryQuoteLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderType, merchantId, selectedBranch?.id, deliveryAddress?.lat, deliveryAddress?.lng]);

  // Delivery fee resolution order:
  //   1. Nooksweb delivery-quote response (merchant's per-branch override
  //      set in Live Operations, falling back to Foodics zone pricing).
  //   2. Legacy cart fee (kept for any stale carts mid-migration).
  //   3. Zero — merchants who haven't configured a fee get free delivery
  //      until they pick one in Live Operations. No silent "15 SAR"
  //      charge the customer never agreed to.
  const deliveryFee =
    orderType === 'delivery'
      ? (deliveryQuoteFee != null ? deliveryQuoteFee : cartDeliveryFee > 0 ? cartDeliveryFee : 0)
      : 0;
  const subtotalBeforePromo = totalPrice + deliveryFee;
  const discount = promoApplied ? promoDiscount : 0;
  const subtotalAfterPromo = Math.max(0, subtotalBeforePromo - discount);

  // Loyalty discount: applies to items only (not delivery), after promo
  const itemsAfterPromo = Math.max(0, totalPrice - discount);
  const maxCashbackCap = loyaltyBalance?.maxCashbackPerOrderSar ?? null;
  const maxPointsDiscountSar = loyaltyBalance
    ? loyaltyType === 'cashback'
      ? Math.min(
          +(loyaltyBalance.cashbackBalance ?? 0),
          ...(maxCashbackCap != null ? [maxCashbackCap] : []),
        )
      : +(loyaltyBalance.points * loyaltyBalance.pointValueSar).toFixed(2)
    : 0;
  const pointsDiscount = usePoints ? Math.min(maxPointsDiscountSar, itemsAfterPromo) : 0;
  const pointsToRedeem = usePoints && loyaltyBalance
    ? loyaltyType === 'cashback'
      ? 0 // cashback is SAR-based, no points to redeem
      : Math.min(loyaltyBalance.points, Math.ceil(pointsDiscount / loyaltyBalance.pointValueSar))
    : 0;

  // Foodics Order Calculation Formulas (tax-inclusive pricing — Saudi standard)
  // See: https://developers.foodics.com/guides/order-calculation-formulas.html
  //
  // product tax exclusive unit price = unit_price / (1 + tax_rate)
  // order subtotal = sum(product tax exclusive total prices)
  // order discount = discount_percent × order subtotal
  // order taxes = taxable_amounts × tax_rate
  // order total = subtotal + charges + taxes - discount + rounding
  const subtotalAfterDiscount = Math.max(0, subtotalAfterPromo - pointsDiscount);

  // Tax-inclusive: extract VAT from the total (prices already include VAT)
  const taxRate = VAT_RATE; // 0.15
  const taxDivisor = 1 + taxRate;

  // Items exclusive of VAT
  const itemsInclVAT = Math.max(0, totalPrice - discount - pointsDiscount);
  const itemsExclVAT = +(itemsInclVAT / taxDivisor).toFixed(2);

  // Delivery fee exclusive of VAT (delivery charges are also tax-inclusive in Saudi)
  const deliveryExclVAT = +(deliveryFee / taxDivisor).toFixed(2);

  // Total exclusive of VAT
  const amountExclVAT = +(itemsExclVAT + deliveryExclVAT).toFixed(2);

  // VAT amount
  const vatAmount = +(subtotalAfterDiscount - amountExclVAT).toFixed(2);

  // Rounding: Foodics uses configurable rounding (default: 0.01 SAR, average/half-up)
  // We round to nearest halala (0.01 SAR) using standard rounding
  const finalTotal = +subtotalAfterDiscount.toFixed(2);

  // Wallet credit applied AFTER everything else (it's a payment-side
  // credit, not a price discount, so it doesn't change subtotal/VAT).
  // Capped to the chosen total so the customer can't accidentally
  // create a negative charge.
  const walletApplied = useWallet
    ? Math.min(Number((walletBalanceSar ?? 0).toFixed(2)), finalTotal)
    : 0;
  const chargeAmount = Math.max(0, +(finalTotal - walletApplied).toFixed(2));
  const walletCoversAll = useWallet && walletApplied > 0 && chargeAmount === 0;
  const amountHalals = Math.round(chargeAmount * 100);

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
          ...(user?.id ? { customer_id: user.id } : {}) },
        supportedNetworks: ['mada', 'visa', 'mastercard', 'amex'],
        creditCard: new CreditCardConfig({ saveCard: saveCardChecked, manual: false }),
        applePay: resolvedApplePayEnabled
          ? new ApplePayConfig({
              merchantId: resolvedApplePayMerchantId,
              label: appName || 'Nooks',
              manual: false,
              saveCard: false })
          : undefined,
        createSaveOnlyToken: false });
    } catch {
      return null;
    }
  }, [amountHalals, appName, customerPaymentsEnabled, merchantId, resolvedApplePayEnabled, resolvedPublishableKey, saveCardChecked, user?.id]);

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
              Alert.alert(
                isArabic ? 'انتهى الكود' : 'Expired Code',
                isArabic ? 'صلاحية هذا الكود انتهت.' : 'This promo code has expired.',
              );
              setPromoValidating(false);
              return;
            }
          }
          // Scope-aware: 'delivery' applies to deliveryFee only; 'total' (default) to items only.
          if (matched.scope === 'delivery' && deliveryFee <= 0) {
            Alert.alert(
              isArabic ? 'كود توصيل فقط' : 'Delivery-only code',
              isArabic
                ? 'هذا الكود يخصم رسوم التوصيل فقط. اختر التوصيل لاستخدامه.'
                : 'This code only discounts the delivery fee. Switch to delivery to use it.',
            );
            setPromoValidating(false);
            return;
          }
          const discountAmount = calculateNooksPromoDiscount(matched, totalPrice, deliveryFee);
          if (discountAmount > 0) {
            setPromoDiscount(discountAmount);
            setPromoApplied(true);
            setPromoCode(matched.code);
            setPromoScope(matched.scope === 'delivery' ? 'delivery' : 'total');
            setShowCouponInput(false);
            setCouponInput('');
            return;
          }
        }
      }
      const result = await validatePromoCode(code, totalPrice);
      if (result.valid) {
        setPromoDiscount(result.discountAmount);
        setPromoApplied(true);
        setPromoCode(result.code);
        // Server-validated promos default to subtotal scope — the
        // /api/promo/validate response doesn't expose scope today.
        setPromoScope('total');
        setShowCouponInput(false);
        setCouponInput('');
      } else {
        Alert.alert(
          isArabic ? 'كود غير صالح' : 'Invalid Code',
          isArabic ? 'هذا الكود غير صالح أو منتهي.' : 'This promo code is not valid or has expired.',
        );
      }
    } catch {
      Alert.alert(
        isArabic ? 'خطأ' : 'Error',
        isArabic ? 'ما قدرنا نتحقق من الكود. حاول مرة ثانية.' : 'Could not validate promo code. Please try again.',
      );
    } finally {
      setPromoValidating(false);
    }
  };

  const removeCoupon = () => {
    setPromoApplied(false);
    setPromoDiscount(0);
    setPromoCode('');
    setPromoScope('total');
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
      Alert.alert(
        isArabic ? 'خطأ في الإعدادات' : 'Configuration Error',
        isArabic ? 'إعدادات المتجر ناقصة. أعد تشغيل التطبيق وحاول مرة ثانية.' : 'Merchant configuration is missing. Please restart the app and try again.',
      );
      return;
    }
    setSubmitting(true);
    const orderId = orderIdRef.current;
    try {
      const resolvedPaymentId = moyasarPaymentId || orderId;

      // Lock in stamp-milestone redemptions BEFORE the order ships, so
      // the customer can't get free reward items for a milestone they
      // haven't actually paid the stamps for. Server-side atomic
      // deduction will reject (409 / 400) if the balance moved
      // underneath us — we drop the corresponding reward items from
      // the order body when that happens. The customer still pays for
      // their cart but doesn't get the un-redeemable freebie.
      //
      // This used to be a fire-and-forget call AFTER the order shipped
      // (`void loyaltyApi.redeemStampMilestone(...).catch(...)`) — that
      // pattern let the order ship with the freebie even when the
      // server rejected the redeem, and the unredeemed redemption row
      // stayed available so the customer could repeat the trick on
      // the next order indefinitely.
      const redeemedRewardItems: typeof rewardItemsForOrder = [];
      const failedRedemptionIds: string[] = [];
      if (selectedMilestoneIds.size > 0 && user?.id && merchantId) {
        for (const milestoneId of selectedMilestoneIds) {
          try {
            await loyaltyApi.redeemStampMilestone(user.id, merchantId, milestoneId);
            for (const item of rewardItemsForOrder) {
              if (item.uniqueId.startsWith(`reward-${milestoneId}-`)) {
                redeemedRewardItems.push(item);
              }
            }
          } catch (err: any) {
            console.warn('[Checkout] Stamp milestone redeem failed:', milestoneId, err?.message);
            failedRedemptionIds.push(milestoneId);
          }
        }
      }
      if (failedRedemptionIds.length > 0) {
        Alert.alert(
          isArabic ? 'بعض المكافآت غير متاحة' : 'Some rewards unavailable',
          isArabic
            ? 'تعذّر استبدال بعض المكافآت — تم إرسال طلبك بدون المكافآت غير المتاحة.'
            : "Couldn't redeem one or more rewards — your order was placed without the unavailable freebies.",
        );
      }

      if (user?.id) {
        await commitOrder({
          id: orderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Placed',
          items: [...cartItems, ...redeemedRewardItems].map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price, basePrice: item.basePrice ?? item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId })),
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
          promoDiscountSar: promoApplied ? promoDiscount : null,
          promoScope: promoApplied ? promoScope : null,
          customerNote: orderNote.trim() || null,
          carDetails: orderType === 'drivethru' ? { make: carMake, color: carColor, plate: carPlate } : null,
          // Apple Pay / Samsung Pay charged the post-wallet
          // chargeAmount via paymentConfig.amount; this debits the
          // wallet so the ledger matches the customer's outlay.
          walletAmountSar: walletApplied > 0 ? Number(walletApplied.toFixed(2)) : null,
          relayToNooks: false });
      }

      // Server-side commit creates the Foodics order synchronously via
      // the relay, which takes 2-5 seconds talking to Foodics. Firing
      // it in the BACKGROUND so the customer sees the order-confirmed
      // screen the moment their payment clears instead of staring at a
      // spinner. If commit fails, the optimistic local order already
      // rendered keeps the UX sane; we surface the error via Alert so
      // the user can contact support and we can reconcile against the
      // Moyasar payment id.
      if (user?.id) {
        void commitOrder({
          id: orderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Placed',
          items: [...cartItems, ...redeemedRewardItems].map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price, basePrice: item.basePrice ?? item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId })),
          orderType,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
          deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
          deliveryFee,
          paymentId: resolvedPaymentId,
          paymentMethod,
          otoId: null, // Set later by Foodics webhook when cashier accepts
          customerName: profile.fullName || null,
          customerPhone: profile.phone || null,
          customerEmail: profile.email || null,
          promoCode: promoApplied ? promoCode : null,
          promoDiscountSar: promoApplied ? promoDiscount : null,
          promoScope: promoApplied ? promoScope : null,
          customerNote: orderNote.trim() || null,
          loyaltyDiscountSar: pointsDiscount > 0 ? pointsDiscount : null,
          walletAmountSar: walletApplied > 0 ? Number(walletApplied.toFixed(2)) : null,
          relayToNooks: true }).catch((err) => {
          console.warn('[Checkout] Background commit failed:', err?.message);
          Alert.alert(
            isArabic ? 'خطأ في المزامنة' : 'Sync issue',
            isArabic
              ? `طلبك ${orderId.slice(-8)} مدفوع لكن ما قدرنا نرسله للمطعم. تواصل مع الدعم.`
              : `Your order ${orderId.slice(-8)} is paid but couldn't reach the store. Please contact support.`,
          );
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
          otoId: undefined,
          otoDispatchStatus: undefined,
          otoDispatchError: undefined,
          deliveryFee,
          paymentId: resolvedPaymentId,
          paymentMethod: paymentMethod,
          promoCode: promoApplied ? promoCode : undefined,
          promoDiscountSar: promoApplied ? promoDiscount : undefined,
          promoScope: promoApplied ? promoScope : undefined,
          customerNote: orderNote.trim() || undefined,
          customerName: profile.fullName || undefined,
          customerPhone: profile.phone || undefined,
          customerEmail: profile.email || undefined,
          serverPersisted: Boolean(user?.id) },
        orderId,
        // Match what we actually wrote to DB. Using 'Preparing' here
        // flashed the wrong badge until the Realtime UPDATE arrived.
        'Placed'
      );
      // Promo + loyalty redemption run in the background too — the
      // user doesn't need to wait for these before seeing their order
      // confirmed. Idempotency is enforced server-side so retries are
      // safe. Failures only log; the order is already placed.
      if (promoApplied && promoCode) {
        void consumeNooksPromo(merchantId, promoCode).catch((e) =>
          console.warn('[Checkout] Promo consume failed:', e?.message),
        );
      }
      if (usePoints && user?.id && merchantId) {
        if (loyaltyType === 'cashback' && pointsDiscount > 0) {
          void loyaltyApi
            .redeemCashback(user.id, pointsDiscount, orderId, merchantId)
            .catch((e) => console.warn('[Checkout] Cashback redeem failed:', e?.message));
        } else if (pointsToRedeem > 0) {
          void loyaltyApi
            .redeem(user.id, pointsToRedeem, orderId, merchantId)
            .catch((e) => console.warn('[Checkout] Points redeem failed:', e?.message));
        }
      }
      // Stamp-milestone redemptions were already locked server-side in
      // commitOrderWithRedemptions before the Foodics order shipped —
      // see the redeem-then-commit block above this callback. Nothing
      // more to do here; just clear the selection from the UI.
      setSelectedMilestoneIds(new Set());
      clearCart();
      setShowPaymentModal(false);
      setMoyasarWebUrl(null);
      setShowPaymentPicker(false);
      orderIdRef.current = `order-${Date.now()}`;
      router.dismissAll();
      // Immediate navigation — no setTimeout. Commit/loyalty/promo are
      // all firing in the background now, so there's nothing to wait for.
      router.replace({ pathname: '/order-confirmed', params: { orderId } });
    } catch (err: any) {
      Alert.alert(
        isArabic ? 'فشل الطلب' : 'Order Failed',
        err?.message || (isArabic ? 'ما قدرنا ننشئ طلبك. تواصل مع الدعم لو سمحت.' : 'Order could not be created. Please contact support.'),
      );
    } finally {
      setSubmitting(false);
    }
  }, [cartItems, rewardItemsForOrder, selectedMilestoneIds, finalTotal, orderType, merchantId, selectedBranch, deliveryAddress, deliveryFee, paymentMethod, addOrder, promoApplied, promoCode, profile.fullName, profile.phone, profile.email, clearCart, usePoints, pointsToRedeem, pointsDiscount, loyaltyType, router, user?.id, walletApplied]);

  const handlePaymentResult = useCallback(
    (result: unknown) => {
      setShowPaymentModal(false);
      if (isMoyasarError(result)) {
        Alert.alert(
          isArabic ? 'فشل الدفع' : 'Payment Failed',
          result.message || (isArabic ? 'ما اكتملت عملية الدفع.' : 'Payment could not be completed.'),
        );
        return;
      }
      if (result instanceof PaymentResponse && result.status === PaymentStatus.paid) {
        createOrderAfterPayment(result.id);
      } else if (result instanceof PaymentResponse && result.status === PaymentStatus.failed) {
        Alert.alert(
          isArabic ? 'فشل الدفع' : 'Payment Failed',
          isArabic ? 'ما قُبلت عملية الدفع. حاول مرة ثانية.' : 'Your payment was declined. Please try again.',
        );
      } else {
        Alert.alert(
          isArabic ? 'الدفع' : 'Payment',
          isArabic ? 'ما اكتملت عملية الدفع.' : 'Payment was not completed.',
        );
      }
    },
    [createOrderAfterPayment]
  );

  // STC Pay: Send OTP to mobile
  const handleStcPaySendOtp = async () => {
    const mobile = stcPayMobile.trim();
    if (!/^05\d{8}$/.test(mobile)) {
      Alert.alert(isArabic ? 'رقم غير صالح' : 'Invalid Number', isArabic ? 'يرجى إدخال رقم سعودي صالح (05XXXXXXXX)' : 'Please enter a valid Saudi mobile (05XXXXXXXX)');
      return;
    }
    if (!merchantId || !selectedBranch?.id) return;

    setStcPayLoading(true);
    try {
      const stcOrderId = orderIdRef.current;
      // Pre-create the order in Pending status before payment
      if (user?.id) {
        await commitOrder({
          id: stcOrderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Placed',
          items: [...cartItems, ...rewardItemsForOrder].map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price, basePrice: item.basePrice ?? item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId })),
          orderType,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
          deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
          deliveryFee,
          paymentMethod: 'stcpay',
          customerName: profile.fullName || null,
          customerPhone: profile.phone || null,
          customerEmail: profile.email || null,
          promoCode: promoApplied ? promoCode : null,
          promoDiscountSar: promoApplied ? promoDiscount : null,
          promoScope: promoApplied ? promoScope : null,
          customerNote: orderNote.trim() || null,
          relayToNooks: false });
      }

      const result = await paymentApi.initiateStcPay(stcOrderId, merchantId, mobile, finalTotal);
      setStcPayPaymentId(result.paymentId);
      setStcPayStep('otp');
      setStcPayOtp('');

      // Start 60-second countdown for resend
      setStcPayCountdown(60);
      if (stcPayTimerRef.current) clearInterval(stcPayTimerRef.current);
      stcPayTimerRef.current = setInterval(() => {
        setStcPayCountdown((prev) => {
          if (prev <= 1) {
            if (stcPayTimerRef.current) clearInterval(stcPayTimerRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: unknown) {
      Alert.alert(
        isArabic ? 'خطأ في STC Pay' : 'STC Pay Error',
        err instanceof Error ? err.message : (isArabic ? 'تعذر بدء عملية الدفع' : 'Failed to initiate payment'),
      );
    } finally {
      setStcPayLoading(false);
    }
  };

  // STC Pay: Verify OTP
  const handleStcPayVerifyOtp = async (otpValue?: string) => {
    const otp = (otpValue || stcPayOtp).trim();
    if (otp.length !== 6 || !stcPayPaymentId) return;

    setStcPayLoading(true);
    try {
      const result = await paymentApi.verifyStcPayOtp(stcPayPaymentId, otp);
      if (result.status === 'paid') {
        setShowStcPaySheet(false);
        setStcPayStep('mobile');
        setStcPayOtp('');
        if (stcPayTimerRef.current) clearInterval(stcPayTimerRef.current);
        createOrderAfterPayment(result.paymentId);
      } else {
        Alert.alert(
          isArabic ? 'فشل التحقق' : 'Verification Failed',
          isArabic ? 'لم يتم التحقق من الدفع. يرجى المحاولة مرة أخرى.' : 'Payment verification failed. Please try again.',
        );
      }
    } catch (err: unknown) {
      Alert.alert(
        isArabic ? 'خطأ في التحقق' : 'Verification Error',
        err instanceof Error ? err.message : (isArabic ? 'تعذر التحقق من الرمز' : 'Failed to verify OTP'),
      );
    } finally {
      setStcPayLoading(false);
    }
  };

  const handleDeleteSavedCard = async (cardId: string) => {
    try {
      await paymentApi.deleteSavedCard(cardId);
      const next = savedCards.filter((c) => c.id !== cardId);
      setSavedCards(next);
      if (selectedSavedCardId === cardId) {
        if (next.length > 0) {
          setSelectedSavedCardId(next[0].id);
        } else {
          setSelectedSavedCardId(null);
          setPaymentMethod('credit_card');
        }
      }
    } catch {
      Alert.alert(
        isArabic ? 'خطأ' : 'Error',
        isArabic ? 'تعذر حذف البطاقة.' : 'Could not delete card.',
      );
    }
  };

  const handlePay = async () => {
    const branchName = selectedBranch?.name
      ?? (isArabic ? 'هذا الفرع' : 'This branch');
    if (isClosed || isBusy) {
      Alert.alert(
        isArabic ? 'الطلب غير متاح' : 'Ordering Unavailable',
        isClosed
          ? (isArabic
              ? `${branchName} مغلق حالياً.`
              : `${branchName} is currently closed.`)
          : (isArabic
              ? `${branchName} مشغول حالياً ولا يستقبل طلبات جديدة.`
              : `${branchName} is currently busy and not accepting new orders.`),
      );
      return;
    }
    if (orderType === 'delivery' && isPickupOnly) {
      Alert.alert(
        isArabic ? 'التوصيل غير متاح' : 'Delivery Unavailable',
        isArabic
          ? `${branchName} للاستلام فقط. يرجى التبديل إلى الاستلام أو استخدام عنوان توصيل أقرب لفرع يوفر التوصيل.`
          : `${branchName} is pickup-only. Switch to Pickup or use a delivery address closer to a delivery-capable branch.`,
      );
      return;
    }
    if (orderType === 'delivery' && !deliveryAddress?.address) {
      Alert.alert(
        isArabic ? 'العنوان مطلوب' : 'Address Required',
        isArabic ? 'عنوان التوصيل مطلوب. ارجع وأضف عنوان.' : 'Delivery address is required. Go back to add one.',
      );
      return;
    }
    if (orderType === 'delivery' && selectedBranch?.id && deliveryAddress?.address) {
      const customerCity = deliveryAddress.city;

      // Coordinate-based check using branch lat/lon from nooksweb
      const branchLat = selectedBranch.latitude;
      const branchLon = selectedBranch.longitude;
      const delLat = deliveryAddress.lat;
      const delLng = deliveryAddress.lng;
      if (branchLat != null && branchLon != null && delLat != null && delLng != null) {
        const dist = distanceKm(branchLat, branchLon, delLat, delLng);
        if (dist > 50) {
          Alert.alert(
            'Delivery Not Available',
            `Your address is too far from this branch (${Math.round(dist)} km).${customerCity ? ` Your address is in ${customerCity}.` : ''} Please select a branch near your location or choose pickup.`
          );
          return;
        }
      }
    }
    if (!selectedBranch?.id) {
      Alert.alert(
        isArabic ? 'اختر الفرع' : 'Branch Required',
        isArabic ? 'اختر فرع لإكمال الطلب.' : 'Please select a branch.',
      );
      return;
    }
    if (!merchantId) {
      Alert.alert(
        isArabic ? 'خطأ في الإعدادات' : 'Configuration Error',
        isArabic ? 'إعدادات المتجر ناقصة. أعد تشغيل التطبيق وحاول مرة ثانية.' : 'Merchant configuration is missing. Please restart the app and try again.',
      );
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
      Alert.alert(
        'Apple Pay',
        isArabic ? 'آبل باي متاح على أجهزة iOS فقط.' : 'Apple Pay is only available on iOS.',
      );
      return;
    }
    if (paymentMethod === 'apple_pay' && !resolvedApplePayEnabled) {
      Alert.alert(
        'Apple Pay',
        isArabic ? 'آبل باي لسه ما جاهز لهذا المتجر. استخدم البطاقة.' : 'Apple Pay is not ready for this merchant yet. Please use card payment.',
      );
      return;
    }
    if (paymentMethod === 'samsung_pay' && Platform.OS !== 'android') {
      Alert.alert(
        'Samsung Pay',
        isArabic ? 'سامسونج باي متاح على أجهزة Android فقط.' : 'Samsung Pay is only available on Android.',
      );
      return;
    }
    if (paymentMethod === 'samsung_pay' && !SAMSUNG_PAY_ENABLED) {
      Alert.alert(
        'Samsung Pay',
        isArabic ? 'سامسونج باي لسه ما معد لهذا المتجر. استخدم البطاقة.' : 'Samsung Pay is not configured for this merchant yet. Please use card payment.',
      );
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
            status: 'Placed',
            items: [...cartItems, ...rewardItemsForOrder].map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price, basePrice: item.basePrice ?? item.price,
              quantity: item.quantity,
              image: item.image,
              customizations: item.customizations ?? null,
              uniqueId: item.uniqueId })),
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
            promoDiscountSar: promoApplied ? promoDiscount : null,
            promoScope: promoApplied ? promoScope : null,
            customerNote: orderNote.trim() || null,
            relayToNooks: false });
        }
        const session = await paymentApi.initiate({
          amount: finalTotal,
          currency: 'SAR',
          orderId: samsungOrderId,
          merchantId,
          successUrl: 'alsdraft0://payment/success' });
        samsungPayInvoiceIdRef.current = session.id;
        if (session.url) {
          setMoyasarWebUrl(session.url);
        } else {
          Alert.alert(
            isArabic ? 'خطأ في الدفع' : 'Payment Error',
            isArabic ? 'ما قدرنا نفتح صفحة الدفع. حاول مرة ثانية.' : 'Could not open payment page. Please try again.',
          );
        }
      } catch (err: unknown) {
        Alert.alert(isArabic ? 'خطأ في الدفع' : 'Payment Error', err instanceof Error ? err.message : (isArabic ? 'تعذر بدء عملية الدفع.' : 'Failed to start payment.'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (paymentMethod === 'stcpay') {
      setStcPayStep('mobile');
      setStcPayOtp('');
      setStcPayPaymentId(null);
      setShowStcPaySheet(true);
      return;
    }

    // Wallet covers the FULL order total — short-circuit to the
    // wallet-only path regardless of whatever method the customer
    // had selected before flipping the toggle, since there's nothing
    // left to charge a card for. The legacy 'wallet' paymentMethod
    // case (from the old picker shape) also routes here so old code
    // paths still resolve cleanly.
    if (walletCoversAll || (paymentMethod as any) === 'wallet') {
      if (!user?.id) {
        Alert.alert(
          isArabic ? 'سجّل الدخول' : 'Sign in',
          isArabic ? 'سجّل الدخول لاستخدام المحفظة.' : 'Please sign in to pay with the wallet.',
        );
        return;
      }
      setSubmitting(true);
      const walletOrderId = orderIdRef.current;
      try {
        const redeemedRewardItems: typeof rewardItemsForOrder = [];
        const failedRedemptionIds: string[] = [];
        if (selectedMilestoneIds.size > 0 && merchantId) {
          for (const milestoneId of selectedMilestoneIds) {
            try {
              await loyaltyApi.redeemStampMilestone(user.id, merchantId, milestoneId);
              for (const item of rewardItemsForOrder) {
                if (item.uniqueId.startsWith(`reward-${milestoneId}-`)) redeemedRewardItems.push(item);
              }
            } catch {
              failedRedemptionIds.push(milestoneId);
            }
          }
        }
        if (failedRedemptionIds.length > 0) {
          Alert.alert(
            isArabic ? 'بعض المكافآت غير متاحة' : 'Some rewards unavailable',
            isArabic
              ? 'تعذّر استبدال بعض المكافآت — تم إرسال طلبك بدون المكافآت غير المتاحة.'
              : "Couldn't redeem one or more rewards — your order was placed without the unavailable freebies.",
          );
        }

        await commitOrder({
          id: walletOrderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Placed',
          items: [...cartItems, ...redeemedRewardItems].map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price, basePrice: item.basePrice ?? item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId })),
          orderType,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
          deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
          deliveryFee,
          paymentMethod: 'wallet',
          customerName: profile.fullName || null,
          customerPhone: profile.phone || null,
          customerEmail: profile.email || null,
          promoCode: promoApplied ? promoCode : null,
          promoDiscountSar: promoApplied ? promoDiscount : null,
          promoScope: promoApplied ? promoScope : null,
          customerNote: orderNote.trim() || null,
          // Server reads paymentMethod === 'wallet' and debits the
          // full totalSar via the wallet legacy path. We send the
          // explicit walletAmountSar too so the new code path is
          // also satisfied — defence in depth.
          walletAmountSar: Number(finalTotal.toFixed(2)),
          relayToNooks: true });

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
            otoId: undefined,
            otoDispatchStatus: undefined,
            otoDispatchError: undefined,
            deliveryFee,
            paymentId: walletOrderId,
            paymentMethod: 'wallet',
            promoCode: promoApplied ? promoCode : undefined,
            promoDiscountSar: promoApplied ? promoDiscount : undefined,
            promoScope: promoApplied ? promoScope : undefined,
            customerNote: orderNote.trim() || undefined,
            customerName: profile.fullName || undefined,
            customerPhone: profile.phone || undefined,
            customerEmail: profile.email || undefined,
            serverPersisted: true },
          walletOrderId,
        );

        setSelectedMilestoneIds(new Set());
        clearCart();
        orderIdRef.current = `order-${Date.now()}`;
        router.replace({ pathname: '/order-confirmed', params: { orderId: walletOrderId } });
      } catch (err: any) {
        const msg = err?.message ?? '';
        if (msg.includes('INSUFFICIENT_WALLET_BALANCE')) {
          Alert.alert(
            isArabic ? 'الرصيد غير كاف' : 'Insufficient balance',
            isArabic
              ? 'رصيد محفظتك أقل من إجمالي الطلب. اختر طريقة دفع أخرى.'
              : 'Your wallet balance is below the order total. Pick another payment method.',
          );
        } else {
          Alert.alert(
            isArabic ? 'فشل الطلب' : 'Order Failed',
            msg || (isArabic ? 'ما قدرنا ننشئ طلبك.' : 'Order could not be created.'),
          );
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Saved card (token) payment
    if (paymentMethod === 'saved_card' && selectedSavedCardId) {
      setTokenPayLoading(true);
      setSubmitting(true);
      try {
        const tokenOrderId = orderIdRef.current;
        if (user?.id) {
          await commitOrder({
            id: tokenOrderId,
            merchantId,
            branchId: selectedBranch.id,
            branchName: selectedBranch.name ?? null,
            totalSar: Number(finalTotal.toFixed(2)),
            status: 'Placed',
            items: [...cartItems, ...rewardItemsForOrder].map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price, basePrice: item.basePrice ?? item.price,
              quantity: item.quantity,
              image: item.image,
              customizations: item.customizations ?? null,
              uniqueId: item.uniqueId })),
            orderType,
            deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
            deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
            deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
            deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
            deliveryFee,
            paymentMethod: 'credit_card',
            customerName: profile.fullName || null,
            customerPhone: profile.phone || null,
            customerEmail: profile.email || null,
            promoCode: promoApplied ? promoCode : null,
            promoDiscountSar: promoApplied ? promoDiscount : null,
            promoScope: promoApplied ? promoScope : null,
            customerNote: orderNote.trim() || null,
            // Wallet credit applied as a partial payment. Server
            // debits this from the wallet during commit, then
            // /token-pay below subtracts the same amount from
            // total_sar so the card only charges the remainder.
            walletAmountSar: walletApplied > 0 ? Number(walletApplied.toFixed(2)) : null,
            relayToNooks: false });
        }
        const session = await paymentApi.payWithSavedCard(tokenOrderId, merchantId, selectedSavedCardId);
        if (session.status === 'paid' || session.status === 'captured') {
          createOrderAfterPayment(session.id);
        } else if (session.url) {
          // 3DS redirect required
          paymentSuccessHandled.current = false;
          samsungPayInvoiceIdRef.current = session.id;
          setMoyasarWebUrl(session.url);
        } else {
          Alert.alert(
            isArabic ? 'فشل الدفع' : 'Payment Failed',
            isArabic ? 'تعذر إتمام الدفع ببطاقتك المحفوظة.' : 'Could not complete payment with saved card.',
          );
        }
      } catch (err: any) {
        const msg = String(err?.message ?? '');
        // Server returned 409 SAVED_CARD_INVALID — the bad row is
        // already deleted server-side. Drop it from local state,
        // unselect, switch back to the credit_card method so the
        // 'Add new card' tile shows up, and tell the customer in
        // plain language to add a new card.
        if (msg.includes('SAVED_CARD_INVALID') || msg.toLowerCase().includes('no longer accepted')) {
          setSavedCards((prev) => prev.filter((c) => c.id !== selectedSavedCardId));
          setSelectedSavedCardId(null);
          setPaymentMethod('credit_card');
          Alert.alert(
            isArabic ? 'البطاقة لم تعد صالحة' : 'Card no longer valid',
            isArabic
              ? 'البطاقة المحفوظة لم تعد مقبولة لدى Moyasar. أضف بطاقة جديدة وأعد المحاولة.'
              : 'Your saved card is no longer accepted by Moyasar. Please add a new card and try again.',
          );
        } else {
          Alert.alert(
            isArabic ? 'خطأ في الدفع' : 'Payment Error',
            err instanceof Error ? err.message : (isArabic ? 'تعذر بدء عملية الدفع.' : 'Failed to start payment.'),
          );
        }
      } finally {
        setTokenPayLoading(false);
        setSubmitting(false);
      }
      return;
    }

    // No card on file (or somehow paymentMethod === 'credit_card'
    // without a selected saved card). Open the custom add-card form
    // — once the user saves a card and returns, this same Pay button
    // will route to the saved-card branch above.
    router.push('/add-card-modal');
  };

  const selectedSavedCard = savedCards.find((c) => c.id === selectedSavedCardId) ?? null;

  const paymentLabel =
    paymentMethod === 'apple_pay'
      ? '\uF8FF Apple Pay'
      : paymentMethod === 'samsung_pay'
        ? 'Samsung Pay'
        : paymentMethod === 'stcpay'
          ? 'STC Pay'
          : paymentMethod === 'saved_card' && selectedSavedCard
            ? `${(selectedSavedCard.brand || 'Card').toUpperCase()} •••• ${selectedSavedCard.last_four || '****'}`
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
          {/* Delivery-chosen-but-branch-is-pickup-only: block with a clear
              message. We do NOT silently pick a different branch (merchant
              policy — the next-closest branch could be in a different
              city). Customer must switch order type to Pickup or change
              their delivery address to one closer to a delivery-capable
              branch. */}
          {orderType === 'delivery' && isPickupOnly && !isClosed && !isBusy && (
            <View
              className="mb-4 rounded-2xl p-4 flex-row items-start"
              style={{ backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fde68a' }}
            >
              <View style={{ marginTop: 2 }}>
                <X size={20} color="#d97706" />
              </View>
              <View className="ms-3 flex-1">
                <Text style={{ color: '#92400e', fontWeight: '700', fontSize: 14 }}>
                  {isArabic
                    ? `${selectedBranch?.name ?? 'هذا الفرع'} لا يوفر خدمة التوصيل`
                    : `${selectedBranch?.name ?? 'This branch'} does not offer delivery`}
                </Text>
                <Text style={{ color: '#a16207', fontSize: 12, marginTop: 4 }}>
                  {isArabic
                    ? 'هذا هو الفرع الأقرب لعنوانك وهو للاستلام فقط. يرجى التبديل إلى الاستلام أو استخدام عنوان آخر قريب من فرع يوفر التوصيل.'
                    : "This is the branch closest to your address and it's pickup-only. Switch to Pickup, or use a delivery address near a delivery-capable branch."}
                </Text>
              </View>
            </View>
          )}

          {/* Branch-specific status banner. Only shown when the customer's
              selected (pickup) or nearest (delivery) branch is closed or
              busy, so they know before filling out the rest of checkout.
              We deliberately don't reroute to a different branch — some
              merchants' next-closest branch is in a different city. */}
          {(isClosed || isBusy) && (
            <View
              className="mb-4 rounded-2xl p-4 flex-row items-start"
              style={{
                backgroundColor: isClosed ? '#fef2f2' : '#fffbeb',
                borderWidth: 1,
                borderColor: isClosed ? '#fecaca' : '#fde68a' }}
            >
              <View style={{ marginTop: 2 }}>
                {isClosed ? (
                  <X size={20} color="#dc2626" />
                ) : (
                  <Clock size={20} color="#d97706" />
                )}
              </View>
              <View className="ms-3 flex-1">
                <Text
                  style={{
                    color: isClosed ? '#991b1b' : '#92400e',
                    fontWeight: '700',
                    fontSize: 14 }}
                >
                  {isClosed
                    ? (isArabic
                        ? `${selectedBranch?.name ?? 'هذا الفرع'} مغلق حالياً`
                        : `${selectedBranch?.name ?? 'This branch'} is currently closed`)
                    : (isArabic
                        ? `${selectedBranch?.name ?? 'هذا الفرع'} مشغول حالياً`
                        : `${selectedBranch?.name ?? 'This branch'} is currently busy`)}
                </Text>
                <Text
                  style={{
                    color: isClosed ? '#b91c1c' : '#a16207',
                    fontSize: 12,
                    marginTop: 4 }}
                >
                  {orderType === 'delivery'
                    ? (isArabic
                        ? 'هذا هو الفرع الأقرب لعنوانك. لا يمكن استقبال الطلبات الآن.'
                        : "This is the branch closest to your address. Orders can't be placed right now.")
                    : (isArabic
                        ? 'لا يمكن استقبال الطلبات من هذا الفرع الآن.'
                        : "Orders can't be placed at this branch right now.")}
                </Text>
              </View>
            </View>
          )}

          {/* Delivery & Order Details (display only, no change) */}
          <View className="bg-slate-50 rounded-[28px] border border-slate-100 overflow-hidden">
            <View className="flex-row items-center px-4 py-4">
              <View className="w-11 h-11 rounded-2xl items-center justify-center" style={{ backgroundColor: `${primaryColor}18` }}>
                <MapPin size={20} color={primaryColor} />
              </View>
              <View className="flex-1 ms-3">
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
              <View className="flex-1 ms-3">
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
              <View className="flex-1 ms-3">
                <Text className="text-slate-900 font-bold">{orderNote || (isArabic ? 'اكتب ملاحظة' : 'Write a note')}</Text>
                <Text className="text-slate-400 text-xs mt-0.5">
                  {isArabic ? 'أضف تعليمات للطلب إن لزم' : 'Add instructions for your order if needed'}
                </Text>
              </View>
              <ChevronRight size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Curbside / Drive-thru Car Details */}
          {orderType === 'drivethru' && (
            <View className="mt-4 bg-slate-50 rounded-[28px] border border-slate-100 p-4">
              <View className="flex-row items-center mb-3">
                <Car size={20} color={primaryColor} />
                <Text className="font-bold text-slate-900 ms-2">{isArabic ? 'تفاصيل السيارة' : 'Car Details'}</Text>
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
                  className="flex-1 text-slate-900 font-medium ms-3"
                  autoCapitalize="characters"
                />
                </View>
                <View className="flex-row mt-3">
                  <TouchableOpacity
                    onPress={applyCoupon}
                    disabled={promoValidating}
                    className="flex-1 items-center py-3 rounded-2xl me-3 disabled:opacity-60"
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
                  <View className="ms-3">
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
                <Text className="text-slate-500 font-medium ms-2">{isArabic ? 'إضافة كود خصم أو كوبون' : 'Add promo code or coupon'}</Text>
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
                backgroundColor: usePoints ? `${primaryColor}08` : '#f8fafc' }}
              activeOpacity={0.7}
            >
              <View className="flex-row items-center flex-1">
                <View
                  style={{
                    width: 36, height: 36, borderRadius: 18,
                    backgroundColor: usePoints ? primaryColor : '#f1f5f9',
                    alignItems: 'center', justifyContent: 'center' }}
                >
                  <Star size={18} color={usePoints ? '#fff' : '#94a3b8'} fill={usePoints ? '#fff' : 'none'} />
                </View>
                <View className="ms-3 flex-1">
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
                  {loyaltyType === 'cashback' && maxCashbackCap != null && (
                    <Text className="text-amber-600 text-xs mt-0.5">
                      {isArabic ? `الحد الأقصى ${maxCashbackCap} ر.س لكل طلب` : `Max ${maxCashbackCap} SAR per order`}
                    </Text>
                  )}
                </View>
              </View>
              <View
                style={{
                  width: 44, height: 26, borderRadius: 13,
                  backgroundColor: usePoints ? primaryColor : '#cbd5e1',
                  justifyContent: 'center',
                  paddingHorizontal: 2 }}
              >
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 11,
                    backgroundColor: '#fff',
                    alignSelf: usePoints ? 'flex-end' : 'flex-start',
                    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15, shadowRadius: 2, elevation: 2 }}
                />
              </View>
            </TouchableOpacity>
          ))}

          {/* Wallet credit toggle — mirrors the cashback redemption row.
              Wallet is NOT a payment method on its own; toggling this
              applies min(balance, total) as a credit and the chosen
              card / Apple Pay covers what's left. */}
          {user?.id && walletBalanceSar !== null && walletBalanceSar > 0 && (
            <TouchableOpacity
              onPress={() => setUseWallet(!useWallet)}
              className="mt-5 rounded-[28px] p-4 flex-row items-center justify-between"
              style={{
                borderWidth: 1,
                borderColor: useWallet ? primaryColor : '#e2e8f0',
                backgroundColor: useWallet ? `${primaryColor}08` : '#f8fafc' }}
              activeOpacity={0.7}
            >
              <View className="flex-row items-center flex-1">
                <View
                  style={{
                    width: 36, height: 36, borderRadius: 18,
                    backgroundColor: useWallet ? primaryColor : '#f1f5f9',
                    alignItems: 'center', justifyContent: 'center' }}
                >
                  <Wallet size={18} color={useWallet ? '#fff' : '#94a3b8'} />
                </View>
                <View className="ms-3 flex-1">
                  <Text className="font-bold text-slate-900" style={{ }}>
                    {isArabic
                      ? `استخدم ${walletBalanceSar.toFixed(2)} ر.س من المحفظة`
                      : `Use ${walletBalanceSar.toFixed(2)} SAR from wallet`}
                  </Text>
                  <View className="flex-row items-center flex-wrap mt-0.5">
                    <Text className="text-slate-500 text-xs">
                      {isArabic ? 'وفّر حتى ' : 'Save up to '}
                    </Text>
                    <PriceWithSymbol
                      amount={Math.min(walletBalanceSar, finalTotal)}
                      iconSize={12}
                      iconColor="#64748b"
                      textStyle={{ color: '#64748b', fontSize: 12 }}
                    />
                  </View>
                </View>
              </View>
              <View
                style={{
                  width: 44, height: 26, borderRadius: 13,
                  backgroundColor: useWallet ? primaryColor : '#cbd5e1',
                  justifyContent: 'center',
                  paddingHorizontal: 2 }}
              >
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 11,
                    backgroundColor: '#fff',
                    alignSelf: useWallet ? 'flex-end' : 'flex-start',
                    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15, shadowRadius: 2, elevation: 2 }}
                />
              </View>
            </TouchableOpacity>
          )}

          {/* Stamp Rewards Redemption — customer has hit one or more milestones and can add the reward items free to this order */}
          {user?.id && loyaltyBalance && loyaltyType === 'stamps' && eligibleRedemptions.length > 0 && (
            <View className="mt-5 rounded-[28px] p-4" style={{ borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' }}>
              <View className="flex-row items-center mb-2">
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' }}>
                  <Star size={18} color="#94a3b8" fill="#94a3b8" />
                </View>
                <View className="ms-3 flex-1">
                  <Text className="font-bold text-slate-900">
                    {isArabic ? 'مكافآت الختم المتاحة' : 'Available stamp rewards'}
                  </Text>
                  <Text className="text-slate-500 text-xs mt-0.5">
                    {isArabic ? 'اختر المكافأة لإضافتها مجانًا إلى طلبك' : 'Tap to add the reward free to your order'}
                  </Text>
                </View>
              </View>
              {eligibleRedemptions.map((redemption) => {
                const milestone = loyaltyBalance.stampMilestones.find((m) => m.id === redemption.milestone_id);
                if (!milestone) return null;
                const selected = selectedMilestoneIds.has(milestone.id);
                return (
                  <TouchableOpacity
                    key={redemption.id}
                    onPress={() => toggleMilestone(milestone.id)}
                    className="flex-row items-center justify-between rounded-2xl px-3 py-3 mt-2"
                    style={{
                      borderWidth: 1,
                      borderColor: selected ? primaryColor : '#e2e8f0',
                      backgroundColor: selected ? `${primaryColor}10` : '#fff' }}
                    activeOpacity={0.7}
                  >
                    <View className="flex-1 pe-3">
                      <Text className="font-semibold text-slate-900">
                        {milestone.reward_name || (isArabic ? 'مكافأة' : 'Reward')}
                      </Text>
                      <Text className="text-xs text-slate-500 mt-0.5">
                        {isArabic ? `عند الختم رقم ${milestone.stamp_number}` : `At stamp ${milestone.stamp_number}`}
                      </Text>
                    </View>
                    <View
                      style={{
                        width: 22, height: 22, borderRadius: 11,
                        borderWidth: 2,
                        borderColor: selected ? primaryColor : '#cbd5e1',
                        backgroundColor: selected ? primaryColor : '#fff',
                        alignItems: 'center', justifyContent: 'center' }}
                    >
                      {selected && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Order Summary — VAT-inclusive prices, discount called out
              under the line it applies to. The previous layout split
              subtotal-excl-VAT / delivery-excl-VAT / VAT into three
              rows which read like a tax-receipt and confused customers
              who just wanted to know what they paid. */}
          <View className="mt-6 rounded-[28px] bg-slate-50 border border-slate-100 p-5">
            <Text className="text-slate-900 text-lg font-bold mb-4">{isArabic ? 'ملخص الدفع' : 'Payment Summary'}</Text>
            <View className="flex-row justify-between items-baseline">
              <Text className="text-slate-900 font-medium">{isArabic ? 'المجموع الفرعي' : 'Subtotal'}</Text>
              {promoApplied && promoScope === 'total' && discount > 0 ? (
                <View className="items-end">
                  <PriceWithSymbol amount={Math.max(0, totalPrice - discount)} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
                  <Text className="text-emerald-600 text-[10px] mt-0.5">
                    {isArabic ? `وفّرت ${discount.toFixed(2)} ر.س بالكود` : `Saved ${discount.toFixed(2)} SAR`}
                  </Text>
                </View>
              ) : (
                <PriceWithSymbol amount={totalPrice} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
              )}
            </View>
            {orderType === 'delivery' && (
              <View className="flex-row justify-between items-baseline mt-2">
                <Text className="text-slate-900 font-medium">{isArabic ? 'رسوم التوصيل' : 'Delivery'}</Text>
                {promoApplied && promoScope === 'delivery' && discount > 0 ? (
                  <View className="items-end">
                    <PriceWithSymbol amount={Math.max(0, deliveryFee - discount)} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
                    <Text className="text-emerald-600 text-[10px] mt-0.5">
                      {isArabic ? `وفّرت ${discount.toFixed(2)} ر.س على التوصيل` : `Saved ${discount.toFixed(2)} SAR off delivery`}
                    </Text>
                  </View>
                ) : (
                  <PriceWithSymbol amount={deliveryFee} iconSize={16} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700' }} />
                )}
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
            {/* Wallet credit applied — shown as a separate line under
                the total (mirrors how a deposit/credit shows on a
                receipt: it doesn't change the order amount, just what
                the customer pays now). */}
            {useWallet && walletApplied > 0 && (
              <>
                <View className="flex-row justify-between mt-2">
                  <Text className="text-slate-900 font-medium">
                    {isArabic ? 'رصيد المحفظة' : 'Wallet credit'}
                  </Text>
                  <PriceWithSymbol
                    amount={walletApplied}
                    prefix="- "
                    iconSize={16}
                    iconColor="#059669"
                    textStyle={{ color: '#059669', fontWeight: '700' }}
                  />
                </View>
                <View className="flex-row justify-between mt-2 pt-2 border-t border-dashed border-slate-200">
                  <Text className="text-slate-900 font-bold">
                    {isArabic ? 'المتبقي على البطاقة' : 'Charged to card'}
                  </Text>
                  <PriceWithSymbol
                    amount={chargeAmount}
                    iconSize={16}
                    iconColor={primaryColor}
                    textStyle={{ color: primaryColor, fontWeight: '700' }}
                  />
                </View>
              </>
            )}
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
              ) : paymentMethod === 'stcpay' ? (
                <View className="w-12 h-8 rounded" style={{ justifyContent: 'center', alignItems: 'center', backgroundColor: '#4F3B8E' }}>
                  <Smartphone size={16} color="#fff" />
                </View>
              ) : paymentMethod === 'saved_card' ? (
                <View className="w-12 h-10 rounded-lg items-center justify-center" style={{ backgroundColor: `${primaryColor}18` }}>
                  <CreditCard size={20} color={primaryColor} />
                </View>
              ) : (
                <View className="w-12 h-10 bg-slate-200 rounded-lg items-center justify-center">
                  <Text className="text-slate-600 font-bold text-xs">••••</Text>
                </View>
              )}
              <Text className="flex-1 ms-3 font-bold text-slate-900">{paymentLabel}</Text>
              <ChevronRight size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Footer */}
      <View className="absolute bottom-0 left-0 right-0 bg-white border-t border-slate-100 px-5 pt-4 pb-10">
        {/* Out-of-delivery-area banner. The Pay button stays disabled
            while this is showing — customer has to pick a different
            address or switch to pickup. */}
        {orderType === 'delivery' && !deliveryQuoteWithin && !deliveryQuoteLoading && (
          <View className="mb-3 rounded-2xl bg-red-50 border border-red-100 p-3">
            <Text className="text-red-700 text-sm font-bold" style={{ }}>
              {deliveryQuoteReason === 'out_of_zone'
                ? (isArabic
                    ? 'عنوانك خارج منطقة التوصيل للمتجر'
                    : "This address is outside the store's delivery area")
                : (isArabic
                    ? 'تعذر حساب رسوم التوصيل — حاول مرة أخرى أو اختر الاستلام'
                    : "Couldn't get a delivery quote — try again or switch to pickup")}
            </Text>
            <Text className="text-red-600 text-xs mt-1" style={{ }}>
              {isArabic ? 'اختر عنواناً آخر أو غيّر نوع الطلب إلى الاستلام' : 'Pick a different address or switch order type to pickup'}
            </Text>
          </View>
        )}
        <View className="rounded-[28px] bg-slate-50 border border-slate-100 p-4">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-slate-400 text-xs font-bold uppercase tracking-widest">
                {isArabic ? 'الإجمالي' : 'Total'}
              </Text>
              <PriceWithSymbol amount={chargeAmount} iconSize={24} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 24 }} />
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
              disabled={submitting || deliveryQuoteLoading || !deliveryQuoteWithin}
              className="px-6 py-4 rounded-[24px] min-w-[190px] items-center flex-row justify-center"
              style={{ backgroundColor: primaryColor, opacity: (submitting || deliveryQuoteLoading || !deliveryQuoteWithin) ? 0.5 : 1 }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : paymentMethod === 'samsung_pay' ? (
                <Text className="text-white font-bold text-base">{isArabic ? 'الدفع عبر Samsung Pay' : 'Pay with Samsung Pay'}</Text>
              ) : paymentMethod === 'stcpay' ? (
                <View className="flex-row items-center">
                  <Smartphone size={18} color="white" />
                  <Text className="text-white font-bold text-base ms-2">{isArabic ? 'الدفع عبر STC Pay' : 'Pay with STC Pay'}</Text>
                </View>
              ) : walletCoversAll ? (
                <View className="flex-row items-center">
                  <Wallet size={18} color="white" />
                  <Text className="text-white font-bold text-base ms-2">
                    {isArabic ? 'إتمام الطلب من المحفظة' : 'Complete with wallet'}
                  </Text>
                </View>
              ) : (
                <View className="flex-row items-center" style={{ flexDirection: 'row' }}>
                  <Text className="text-white font-bold text-base">
                    {isArabic ? 'ادفع' : 'Pay'}
                  </Text>
                  <View style={{ marginStart: 8 }}>
                    <PriceWithSymbol
                      amount={chargeAmount}
                      iconSize={16}
                      iconColor="#ffffff"
                      textStyle={{ color: '#ffffff', fontWeight: '700', fontSize: 16 }}
                    />
                  </View>
                  <ChevronRight
                    size={18}
                    color="white"
                    style={{
                      marginStart: 8,
                      transform: [{ scaleX: isArabic ? -1 : 1 }] }}
                  />
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
                className="flex-1 py-3 rounded-2xl bg-slate-100 items-center me-3"
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
            {/* Saved cards — shown above other methods */}
            {savedCards.length > 0 && (
              <>
                {savedCards.map((card) => (
                  <TouchableOpacity
                    key={card.id}
                    onPress={() => {
                      setSelectedSavedCardId(card.id);
                      setPaymentMethod('saved_card');
                      setShowPaymentPicker(false);
                    }}
                    className="flex-row items-center p-4 mb-3 rounded-2xl bg-white"
                    style={{
                      borderWidth: 1,
                      borderColor: selectedSavedCardId === card.id && paymentMethod === 'saved_card' ? primaryColor : '#f1f5f9' }}
                  >
                    <View className="bg-slate-100 p-3 rounded-xl">
                      <CreditCard size={20} color="#64748b" />
                    </View>
                    <View className="flex-1 ms-3">
                      <Text className="font-bold text-slate-800">
                        {(card.brand || 'Card').toUpperCase()} •••• {card.last_four || '****'}
                      </Text>
                      {card.name ? <Text className="text-slate-400 text-xs">{card.name}</Text> : null}
                    </View>
                    <TouchableOpacity
                      onPress={(e) => { e.stopPropagation(); handleDeleteSavedCard(card.id); }}
                      className="p-2"
                    >
                      <Trash2 size={16} color="#ef4444" />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  onPress={() => {
                    // Save-card-first flow: open our custom card form,
                    // tokenize via Moyasar /v1/tokens save_only, persist
                    // it, then return here. The picker re-loads on focus
                    // and auto-selects the new card.
                    setShowPaymentPicker(false);
                    router.push('/add-card-modal');
                  }}
                  className="flex-row items-center justify-center p-3 mb-4 border-2 border-dashed border-slate-200 rounded-2xl"
                >
                  <Plus size={18} color={primaryColor} />
                  <Text className="font-bold ms-2" style={{ color: primaryColor }}>
                    {isArabic ? 'إضافة بطاقة جديدة' : 'Add new card'}
                  </Text>
                </TouchableOpacity>
                <View className="h-px bg-slate-100 mb-3" />
              </>
            )}
            {resolvedApplePayEnabled && (
              <TouchableOpacity
                onPress={() => { setPaymentMethod('apple_pay'); setShowPaymentPicker(false); }}
                className="flex-row items-center py-4 px-4 mb-3 rounded-[24px] bg-slate-50 border border-slate-100"
              >
                <View className="w-12 h-8 bg-black rounded items-center justify-center">
                  <Text className="text-white font-bold text-xs">{'\uF8FF'} Pay</Text>
                </View>
                <Text className="ms-3 font-bold text-slate-900">{'\uF8FF'} Apple Pay</Text>
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
                <Text className="ms-3 font-bold text-slate-900">Samsung Pay</Text>
              </TouchableOpacity>
            )}
            {/* Wallet is no longer a payment method — it's a redeemable
                credit applied via a toggle outside this picker (same UX
                as the cashback loyalty redemption row). */}
            {/* No saved card yet → tap to open our custom add-card
                form. After save, the user lands back on checkout with
                the new card auto-selected and just taps Pay. */}
            {savedCards.length === 0 && (
              <TouchableOpacity
                onPress={() => {
                  setShowPaymentPicker(false);
                  router.push('/add-card-modal');
                }}
                className="flex-row items-center py-4 px-4 rounded-[24px] bg-slate-50 border border-slate-100"
              >
                <View className="w-12 h-10 rounded-xl items-center justify-center" style={{ backgroundColor: `${primaryColor}18` }}>
                  <CreditCard size={20} color={primaryColor} />
                </View>
                <View className="ms-3 flex-1">
                  <Text className="font-bold text-slate-900">{isArabic ? 'بطاقة ائتمانية / مدى' : 'Credit / Debit Card'}</Text>
                  <Text className="text-slate-400 text-sm">
                    {isArabic ? 'أضف بطاقتك واحفظها للاستخدام السريع' : 'Add and save your card for quick checkout'}
                  </Text>
                </View>
                <ChevronRight size={18} color="#94a3b8" />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
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

      {/* STC Pay Bottom Sheet */}
      <Modal visible={showStcPaySheet} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {
            setShowStcPaySheet(false);
            setStcPayStep('mobile');
            setStcPayOtp('');
            if (stcPayTimerRef.current) clearInterval(stcPayTimerRef.current);
          }}
          className="flex-1 bg-black/50 justify-end"
        >
          <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} className="bg-white rounded-t-[32px] p-6 pb-10">
            {/* Header */}
            <View className="flex-row items-center justify-between mb-5">
              <View className="flex-row items-center">
                <View className="w-10 h-10 rounded-2xl items-center justify-center" style={{ backgroundColor: '#4F3B8E' }}>
                  <Smartphone size={20} color="#fff" />
                </View>
                <Text className="ms-3 text-lg font-bold text-slate-900">STC Pay</Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setShowStcPaySheet(false);
                  setStcPayStep('mobile');
                  setStcPayOtp('');
                  if (stcPayTimerRef.current) clearInterval(stcPayTimerRef.current);
                }}
                className="p-2"
              >
                <X size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            {stcPayStep === 'mobile' ? (
              /* Step 1: Phone Number Input */
              <View>
                <Text className="text-slate-600 mb-3">
                  {isArabic ? 'أدخل رقم الجوال المسجل في STC Pay' : 'Enter your STC Pay registered mobile number'}
                </Text>
                <View className="flex-row items-center bg-slate-50 rounded-2xl border border-slate-200 px-4 py-3 mb-4">
                  <Text className="text-slate-400 font-bold me-2">+966</Text>
                  <TextInput
                    value={stcPayMobile}
                    onChangeText={(text) => setStcPayMobile(text.replace(/[^0-9]/g, '').slice(0, 10))}
                    placeholder="05XXXXXXXX"
                    placeholderTextColor="#94a3b8"
                    keyboardType="phone-pad"
                    maxLength={10}
                    className="flex-1 text-slate-900 font-medium text-base"
                    style={{ }}
                  />
                </View>
                <TouchableOpacity
                  onPress={handleStcPaySendOtp}
                  disabled={stcPayLoading || stcPayMobile.length !== 10}
                  className="py-4 rounded-2xl items-center"
                  style={{
                    backgroundColor: stcPayMobile.length === 10 ? '#4F3B8E' : '#cbd5e1' }}
                >
                  {stcPayLoading ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <Text className="text-white font-bold text-base">
                      {isArabic ? 'إرسال رمز التحقق' : 'Send OTP'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              /* Step 2: OTP Input */
              <View>
                <Text className="text-slate-600 mb-1">
                  {isArabic ? 'أدخل رمز التحقق المرسل إلى' : 'Enter the OTP sent to'}
                </Text>
                <Text className="text-slate-900 font-bold mb-4">{stcPayMobile}</Text>
                <View className="bg-slate-50 rounded-2xl border border-slate-200 px-4 py-3 mb-3">
                  <TextInput
                    value={stcPayOtp}
                    onChangeText={(text) => {
                      const digits = text.replace(/[^0-9]/g, '').slice(0, 6);
                      setStcPayOtp(digits);
                      // Auto-submit when 6 digits entered
                      if (digits.length === 6) {
                        handleStcPayVerifyOtp(digits);
                      }
                    }}
                    placeholder="000000"
                    placeholderTextColor="#94a3b8"
                    keyboardType="number-pad"
                    maxLength={6}
                    autoFocus
                    className="text-center text-slate-900 font-bold text-2xl tracking-[12px]"
                  />
                </View>
                {stcPayCountdown > 0 && (
                  <Text className="text-slate-400 text-sm text-center mb-3">
                    {isArabic ? `إعادة الإرسال خلال ${stcPayCountdown} ثانية` : `Resend in ${stcPayCountdown}s`}
                  </Text>
                )}
                {stcPayCountdown === 0 && (
                  <TouchableOpacity
                    onPress={() => {
                      setStcPayStep('mobile');
                      setStcPayOtp('');
                    }}
                    className="mb-3"
                  >
                    <Text className="text-center font-bold" style={{ color: '#4F3B8E' }}>
                      {isArabic ? 'إعادة الإرسال' : 'Resend OTP'}
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => handleStcPayVerifyOtp()}
                  disabled={stcPayLoading || stcPayOtp.length !== 6}
                  className="py-4 rounded-2xl items-center"
                  style={{
                    backgroundColor: stcPayOtp.length === 6 ? '#4F3B8E' : '#cbd5e1' }}
                >
                  {stcPayLoading ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <Text className="text-white font-bold text-base">
                      {isArabic ? 'تأكيد الدفع' : 'Verify & Pay'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}
