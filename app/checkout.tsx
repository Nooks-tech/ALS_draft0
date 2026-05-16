import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Car,
  ChevronRight,
  Clock,
  CreditCard,
  Gift,
  MapPin,
  Percent,
  Pencil,
  Plus,
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
import { MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY, APPLE_PAY_MERCHANT_ID } from '../src/api/config';
import { paymentApi, type SavedCard } from '../src/api/payment';
import { walletApi } from '../src/api/wallet';
import { getDeliveryQuote } from '../src/api/deliveryQuote';
import { validateNooksPromo } from '../src/api/nooksPromos';
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
import { reportCartEvent } from '../src/api/cartEvents';
import { useMenu } from '../src/hooks/useMenu';
import { readCache, writeCache } from '../src/lib/persistentCache';

// Wallet is no longer one of these — it's a redeemable credit
// applied via the useWallet toggle (see the cashback-style row in
// render). Card / Apple Pay handles the post-wallet remainder.
export type PaymentMethod = 'apple_pay' | 'credit_card' | 'saved_card';

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
    addToCart,
    removeFromCart,
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
    resolvedApplePayEnabled ? 'apple_pay' : 'credit_card'
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
  // Holds the Moyasar invoice/payment id for the saved-card 3DS redirect
  // flow so the WebView callback can pass it back to the order commit.
  const moyasarInvoiceIdRef = useRef<string | null>(null);
  const orderIdRef = useRef(`order-${Date.now()}`);

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
      setPaymentMethod((prev) => (prev === 'apple_pay' ? prev : 'saved_card'));
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
        setPaymentMethod((prev) => (prev === 'apple_pay' ? prev : 'saved_card'));
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

  // Stamp milestone redemptions selected by the customer. Source of
  // truth is now the cart itself — reward items in cartItems carry
  // a rewardMilestoneId tag, and the unique values of that tag form
  // the selected-milestones set. /rewards adds/removes the cart
  // items; checkout's milestone toggle below does the same via
  // toggleMilestone(). Cross-screen sync is automatic because the
  // cart is shared context.
  const selectedMilestoneIds = useMemo(() => {
    const s = new Set<string>();
    for (const ci of cartItems) {
      if (ci.rewardMilestoneId) s.add(ci.rewardMilestoneId);
    }
    return s;
  }, [cartItems]);

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
  // Menu products — used to look up Foodics reward items and add them as free line items
  const { products: menuProducts } = useMenu();

  // Toggle a milestone selection by adding or removing its reward
  // items from the cart. The /rewards screen and the checkout
  // milestone-toggle UI both call this; the cart is the single
  // source of truth for what's been selected.
  const toggleMilestone = useCallback((milestoneId: string) => {
    const milestone = loyaltyBalance?.stampMilestones.find((m) => m.id === milestoneId);
    if (!milestone) return;
    if (selectedMilestoneIds.has(milestoneId)) {
      for (const foodicsId of milestone.foodics_product_ids ?? []) {
        removeFromCart({ uniqueId: `reward-${milestoneId}-${foodicsId}` });
      }
    } else {
      for (const foodicsId of milestone.foodics_product_ids ?? []) {
        const product = menuProducts.find((p) => p.foodicsProductId === foodicsId);
        if (!product) continue;
        addToCart({
          id: product.id,
          name: `🎁 ${product.name}`,
          price: 0,
          basePrice: 0,
          image: product.image ?? '',
          customizations: null,
          uniqueId: `reward-${milestoneId}-${foodicsId}`,
          rewardMilestoneId: milestoneId,
        });
      }
    }
  }, [loyaltyBalance, menuProducts, selectedMilestoneIds, addToCart, removeFromCart]);

  /**
   * The merchant's defined milestones, ordered by stamp_number. We
   * intentionally derive from stampMilestones (the definition) NOT
   * availableRedemptions (the ticket queue). The ticket model created
   * duplicate "stamp 2 reward available" rows when the customer's
   * stamp count crossed the milestone repeatedly across card cycles,
   * even though the merchant only defined one stamp-2 reward.
   *
   * Each row carries `redeemable` (has the stamp count) + a computed
   * budget flag from the currently-selected set, so the UI can show
   * locked vs available vs budget-exceeded states cleanly.
   */
  const allMilestonesForUI = useMemo(() => {
    if (!loyaltyBalance) return [] as Array<{
      id: string;
      stamp_number: number;
      reward_name: string;
      foodics_product_ids: string[];
      redeemable: boolean;
    }>;
    return [...loyaltyBalance.stampMilestones]
      .sort((a, b) => a.stamp_number - b.stamp_number)
      .map((m) => ({
        id: m.id,
        stamp_number: m.stamp_number,
        reward_name: m.reward_name,
        foodics_product_ids: m.foodics_product_ids ?? [],
        redeemable: loyaltyBalance.stamps >= m.stamp_number,
      }));
  }, [loyaltyBalance]);

  /**
   * Stamps already committed to the currently-selected milestones.
   * Used to disable additional selections that would exceed the
   * customer's balance — e.g. with 4 stamps, picking the stamp-4
   * milestone leaves 0 budget, so stamp-2 must lock out.
   */
  const selectedStampsBudget = useMemo(() => {
    if (!loyaltyBalance) return 0;
    let used = 0;
    for (const id of selectedMilestoneIds) {
      const m = loyaltyBalance.stampMilestones.find((x) => x.id === id);
      if (m) used += m.stamp_number;
    }
    return used;
  }, [loyaltyBalance, selectedMilestoneIds]);

  // Items are now in the cart directly with rewardMilestoneId tags
  // (via /rewards or the checkout milestone-toggle helper above).
  // Kept as an empty array so the legacy `[...cartItems,
  // ...rewardItemsForOrder]` spreads below don't change shape during
  // the refactor; the no-longer-needed reward computation lived
  // here previously.
  const rewardItemsForOrder: Array<{ id: string; name: string; price: number; quantity: number; image: string; customizations: null; uniqueId: string }> = [];

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

  // Loyalty discount: caps at the entire post-promo total (items +
  // delivery) so cashback can absorb the same amount of bill that
  // wallet can. Previously this was `totalPrice - discount` (items
  // only) which silently capped cashback below the order total and
  // left the customer wondering why "Save up to X" was lower than
  // wallet's "Save up to Y" on the same cart.
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
  const pointsDiscount = usePoints ? Math.min(maxPointsDiscountSar, subtotalAfterPromo) : 0;
  const pointsToRedeem = usePoints && loyaltyBalance
    ? loyaltyType === 'cashback'
      ? 0 // cashback is SAR-based, no points to redeem
      : Math.min(loyaltyBalance.points, Math.ceil(pointsDiscount / loyaltyBalance.pointValueSar))
    : 0;

  // Payment composition snapshot for the server's customer_orders row.
  // Used at cancel time to "rewind time" — each source returns to where
  // it came from (card → Moyasar void, wallet → in-app wallet, cashback
  // → loyalty_cashback_balances, stamps → loyalty_stamps). Computed
  // once here and reused by every commitOrder call site below so the
  // four numbers stay consistent across card / wallet / saved-card
  // payment paths.
  const stampMilestoneIdsForOrder = useMemo(
    () => Array.from(selectedMilestoneIds),
    [selectedMilestoneIds],
  );
  const stampsConsumedForOrder = useMemo(() => {
    if (!loyaltyBalance || selectedMilestoneIds.size === 0) return 0;
    let total = 0;
    for (const id of selectedMilestoneIds) {
      const m = loyaltyBalance.stampMilestones.find((x) => x.id === id);
      if (m) total += m.stamp_number;
    }
    return total;
  }, [loyaltyBalance, selectedMilestoneIds]);
  const cashbackAmountForOrder =
    loyaltyType === 'cashback' && pointsDiscount > 0 ? Number(pointsDiscount.toFixed(2)) : 0;

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
  // True whenever there's nothing for the card / Apple Pay to charge —
  // covers every combination of wallet / cashback / stamp-milestone
  // freebies that lands at 0 SAR. We use it both to skip the Moyasar
  // / Apple Pay early-return guards (otherwise a stale 'apple_pay'
  // selection from a prior order silently no-ops the Pay button) and
  // to route the order through the zero-charge commit branch.
  const nothingToCharge = chargeAmount === 0;
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
        // PRIMARY path: hit the nooksweb /promos/validate endpoint
        // with the customer_id. The endpoint enforces:
        //   - expiry
        //   - global usage_limit (across all customers)
        //   - per-customer usage_limit_per_customer
        // so the customer gets immediate feedback at apply-time
        // when they've already used the code, when the merchant's
        // total cap is hit, or when the code expired. Without this
        // they'd see "WELCOME applied" + discount, only to get
        // rejected at the Pay step — false-hopes UX the user
        // explicitly called out.
        const validation = await validateNooksPromo({
          merchantId,
          code,
          subtotal: totalPrice,
          deliveryFee,
          customerId: user?.id ?? null,
        });
        if (validation.valid) {
          if (validation.scope === 'delivery' && deliveryFee <= 0) {
            Alert.alert(
              isArabic ? 'كود توصيل فقط' : 'Delivery-only code',
              isArabic
                ? 'هذا الكود يخصم رسوم التوصيل فقط. اختر التوصيل لاستخدامه.'
                : 'This code only discounts the delivery fee. Switch to delivery to use it.',
            );
            setPromoValidating(false);
            return;
          }
          if (validation.discountAmount > 0) {
            setPromoDiscount(validation.discountAmount);
            setPromoApplied(true);
            setPromoCode(validation.code);
            setPromoScope(validation.scope);
            setShowCouponInput(false);
            setCouponInput('');
            return;
          }
        } else {
          // Server said no. Surface the actual reason so the customer
          // knows whether it's expired, limit reached, already used, etc.
          Alert.alert(
            isArabic ? 'كود غير صالح' : 'Invalid Code',
            validation.error || (isArabic ? 'هذا الكود غير صالح أو منتهي.' : 'This promo code is not valid or has expired.'),
          );
          setPromoValidating(false);
          return;
        }
      }
      // Fallback: legacy als_promo_codes table (different namespace
      // from the nooksweb merchant promos). Only reached if no
      // merchantId or the nooks endpoint is unreachable.
      const result = await validatePromoCode(code, totalPrice);
      if (result.valid) {
        setPromoDiscount(result.discountAmount);
        setPromoApplied(true);
        setPromoCode(result.code);
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

      // Commit FIRST, then redeem stamps. If we redeemed before the
      // commit and the commit failed (server validation, network, etc.)
      // the stamps were burned with no order to show for it — exactly
      // the bug a customer hit on 2026-05-14. Inverting the order
      // means a commit failure leaves the stamp balance untouched and
      // the customer can retry. If the redeem fails AFTER a successful
      // commit, the customer keeps the freebie without paying stamps
      // (rare, low-cost, server-side reconciliation can clear
      // stamp_milestone_ids on the order row in a follow-up).
      if (user?.id) {
        await commitOrder({
          id: orderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Placed',
          items: cartItems.map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price, basePrice: item.basePrice ?? item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId,
            rewardOriginalPriceSar: item.rewardOriginalPriceSar })),
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
          // Apple Pay charged the post-wallet chargeAmount via
          // paymentConfig.amount; this debits the wallet so the
          // ledger matches the customer's outlay.
          walletAmountSar: walletApplied > 0 ? Number(walletApplied.toFixed(2)) : null,
          cashbackAmountSar: cashbackAmountForOrder > 0 ? cashbackAmountForOrder : null,
          stampMilestoneIds: stampMilestoneIdsForOrder.length > 0 ? stampMilestoneIdsForOrder : undefined,
          stampsConsumed: stampsConsumedForOrder > 0 ? stampsConsumedForOrder : null,
          relayToNooks: false });
      }

      // Second commit — AWAITED. This is where the server runs the
      // hardened post-delay Moyasar re-verify, fires the side effects
      // (wallet debit, promo redeem), and relays to Foodics. If the
      // hardened verify catches a 3DS-abandoned 'initiated' state or
      // the Foodics relay fails, the server reverses everything and
      // returns an error — and we must NOT redeem stamps / cashback /
      // wallet on the client side either. Previously this was
      // fire-and-forget which let stamps + cashback fire alongside a
      // commit that ultimately failed.
      let finalCommitOk = false;
      if (user?.id) {
        try {
          await commitOrder({
            id: orderId,
            merchantId,
            branchId: selectedBranch.id,
            branchName: selectedBranch.name ?? null,
            totalSar: Number(finalTotal.toFixed(2)),
            status: 'Placed',
            items: cartItems.map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price, basePrice: item.basePrice ?? item.price,
              quantity: item.quantity,
              image: item.image,
              customizations: item.customizations ?? null,
              uniqueId: item.uniqueId,
              rewardOriginalPriceSar: item.rewardOriginalPriceSar })),
            orderType,
            deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
            deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
            deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
            deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
            deliveryFee,
            paymentId: resolvedPaymentId,
            paymentMethod,
            otoId: null,
            customerName: profile.fullName || null,
            customerPhone: profile.phone || null,
            customerEmail: profile.email || null,
            promoCode: promoApplied ? promoCode : null,
            promoDiscountSar: promoApplied ? promoDiscount : null,
            promoScope: promoApplied ? promoScope : null,
            customerNote: orderNote.trim() || null,
            loyaltyDiscountSar: pointsDiscount > 0 ? pointsDiscount : null,
            walletAmountSar: walletApplied > 0 ? Number(walletApplied.toFixed(2)) : null,
            cashbackAmountSar: cashbackAmountForOrder > 0 ? cashbackAmountForOrder : null,
            stampMilestoneIds: stampMilestoneIdsForOrder.length > 0 ? stampMilestoneIdsForOrder : undefined,
            stampsConsumed: stampsConsumedForOrder > 0 ? stampsConsumedForOrder : null,
            relayToNooks: true });
          finalCommitOk = true;
        } catch (err: any) {
          console.warn('[Checkout] Final commit failed:', err?.message);
          Alert.alert(
            isArabic ? 'فشل إنشاء الطلب' : 'Order failed',
            isArabic
              ? `لم نقدر نأكد طلبك. لو خصمنا أي مبلغ راح يرجعك خلال دقائق.`
              : `We couldn't finalize your order. Any amount charged will be refunded within minutes.`,
          );
          return;
        }
      }
      if (!finalCommitOk && user?.id) {
        return;
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
      //
      // Promo redemption is NO LONGER done here — Express /commit now
      // calls the atomic redeem_promo RPC before INSERT. The RPC
      // enforces expiry + usage_limit and writes the
      // promo_redemptions row idempotently. Calling consumeNooksPromo
      // here would double-increment the usage_count.
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
      // Stamp-milestone redemption runs AFTER the await commitOrder
      // above. If commit failed it threw and we never got here, so
      // stamps stay intact. If the redeem call itself fails post-
      // commit, log it — the order already shipped with the freebie,
      // server-side reconciliation can clean up stamp_milestone_ids
      // if needed.
      if (selectedMilestoneIds.size > 0 && user?.id && merchantId) {
        for (const milestoneId of selectedMilestoneIds) {
          void loyaltyApi
            .redeemStampMilestone(user.id, merchantId, milestoneId)
            .catch((err: any) =>
              console.warn('[Checkout] Post-commit stamp redeem failed:', milestoneId, err?.message)
            );
        }
      }
      // Cart clear below also removes any reward items, which
      // automatically empties the milestone-selected set since
      // selection is now derived from cart contents.
      clearCart();
      setShowPaymentModal(false);
      setMoyasarWebUrl(null);
      setShowPaymentPicker(false);
      orderIdRef.current = `order-${Date.now()}`;
      // Phase 5 — pair with the cart.opened ping from CartScreen so the
      // dashboard can compute abandonment.
      if (merchantId) {
        reportCartEvent({
          event: 'cart.committed',
          merchantId,
          cartItemCount: cartItems.length,
          cartTotalSar: finalTotal,
        });
      }
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

    // Free-reward subset of nothingToCharge — still needed to pick
    // the right paymentMethod label / paymentId sentinel inside the
    // zero-charge branch below.
    const isFreeRewardOrder =
      finalTotal === 0 && selectedMilestoneIds.size > 0;

    // Apple Pay / Moyasar guards only apply when there IS actually a
    // card portion to charge. Without this `nothingToCharge` short-
    // circuit, a stale 'apple_pay' selection silently no-ops the Pay
    // button for any 0-SAR order (free reward, cashback-covers-all,
    // wallet-covers-all, or any combination).
    if (!nothingToCharge) {
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
      if (paymentMethod === 'apple_pay') {
        return;
      }
    }

    // Zero-charge commit branch. Captures every shape of order where
    // the card has nothing to charge: free reward, cashback covers
    // all, wallet covers all, or any combination. The legacy
    // 'wallet' paymentMethod case (from the old picker shape) also
    // routes here so old code paths still resolve cleanly.
    if (nothingToCharge || (paymentMethod as any) === 'wallet') {
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
        // Commit FIRST; redeem stamps AFTER. Reasoning at the equivalent
        // block in createOrderAfterPayment above. A commit failure here
        // (e.g. server validation, per-item floor) used to burn the
        // customer's stamps before the order existed — see incident
        // 2026-05-14 where 4 stamps vanished on a كوكيز freebie.
        await commitOrder({
          id: walletOrderId,
          merchantId,
          branchId: selectedBranch.id,
          branchName: selectedBranch.name ?? null,
          totalSar: Number(finalTotal.toFixed(2)),
          status: 'Placed',
          items: cartItems.map((item) => ({
            id: item.id,
            name: item.name,
            price: item.price, basePrice: item.basePrice ?? item.price,
            quantity: item.quantity,
            image: item.image,
            customizations: item.customizations ?? null,
            uniqueId: item.uniqueId,
            rewardOriginalPriceSar: item.rewardOriginalPriceSar })),
          orderType,
          deliveryAddress: orderType === 'delivery' ? deliveryAddress?.address ?? null : null,
          deliveryLat: orderType === 'delivery' ? deliveryAddress?.lat ?? null : null,
          deliveryLng: orderType === 'delivery' ? deliveryAddress?.lng ?? null : null,
          deliveryCity: orderType === 'delivery' ? deliveryAddress?.city ?? null : null,
          deliveryFee,
          // Free-reward orders use 'reward' paymentMethod + a
          // reward:<id> sentinel payment_id. Server allow-lists both
          // and skips Moyasar verification + wallet debit. Wallet-only
          // orders keep 'wallet' + walletAmountSar = full total.
          paymentMethod: isFreeRewardOrder ? 'reward' : 'wallet',
          paymentId: isFreeRewardOrder ? `reward:${walletOrderId}` : null,
          customerName: profile.fullName || null,
          customerPhone: profile.phone || null,
          customerEmail: profile.email || null,
          promoCode: promoApplied ? promoCode : null,
          promoDiscountSar: promoApplied ? promoDiscount : null,
          promoScope: promoApplied ? promoScope : null,
          customerNote: orderNote.trim() || null,
          // No wallet debit for free-reward orders. Wallet-only
          // orders debit the full total via the legacy 'wallet'
          // paymentMethod path the server still understands.
          walletAmountSar: isFreeRewardOrder ? null : Number(finalTotal.toFixed(2)),
          cashbackAmountSar: cashbackAmountForOrder > 0 ? cashbackAmountForOrder : null,
          stampMilestoneIds: stampMilestoneIdsForOrder.length > 0 ? stampMilestoneIdsForOrder : undefined,
          stampsConsumed: stampsConsumedForOrder > 0 ? stampsConsumedForOrder : null,
          loyaltyDiscountSar: pointsDiscount > 0 ? pointsDiscount : null,
          relayToNooks: true });

        // All loyalty deductions run AFTER commit succeeded — if the
        // commit threw, we never get here and balances stay intact.
        // Cashback / points were previously only deducted in the card
        // path (createOrderAfterPayment), so a wallet+cashback or
        // cashback-covers-all order skipped the deduction entirely and
        // any refund would have re-credited cashback the customer
        // never actually paid.
        if (usePoints && merchantId) {
          if (loyaltyType === 'cashback' && pointsDiscount > 0) {
            void loyaltyApi
              .redeemCashback(user.id, pointsDiscount, walletOrderId, merchantId)
              .catch((e) => console.warn('[Checkout] Cashback redeem failed:', e?.message));
          } else if (pointsToRedeem > 0) {
            void loyaltyApi
              .redeem(user.id, pointsToRedeem, walletOrderId, merchantId)
              .catch((e) => console.warn('[Checkout] Points redeem failed:', e?.message));
          }
        }
        if (selectedMilestoneIds.size > 0 && merchantId) {
          for (const milestoneId of selectedMilestoneIds) {
            void loyaltyApi
              .redeemStampMilestone(user.id, merchantId, milestoneId)
              .catch((err: any) =>
                console.warn('[Checkout] Post-commit stamp redeem failed:', milestoneId, err?.message)
              );
          }
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
            paymentId: isFreeRewardOrder ? `reward:${walletOrderId}` : walletOrderId,
            paymentMethod: isFreeRewardOrder ? 'reward' : 'wallet',
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

        // Cart clear below also removes any reward items, which
      // automatically empties the milestone-selected set since
      // selection is now derived from cart contents.
        clearCart();
        orderIdRef.current = `order-${Date.now()}`;
        if (merchantId) {
          reportCartEvent({
            event: 'cart.committed',
            merchantId,
            cartItemCount: cartItems.length,
            cartTotalSar: finalTotal,
          });
        }
        // Pop the checkout modal stack before navigating to the
        // confirmation screen. Without this the (tabs) bottom-nav
        // still routes through the checkout modal, so tapping "View
        // Orders" stacks the Orders screen on top of checkout
        // instead of switching to the Orders tab — same fix the card
        // path already has at the equivalent spot.
        router.dismissAll();
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
            items: cartItems.map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price, basePrice: item.basePrice ?? item.price,
              quantity: item.quantity,
              image: item.image,
              customizations: item.customizations ?? null,
              uniqueId: item.uniqueId,
              rewardOriginalPriceSar: item.rewardOriginalPriceSar })),
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
            cashbackAmountSar: cashbackAmountForOrder > 0 ? cashbackAmountForOrder : null,
            stampMilestoneIds: stampMilestoneIdsForOrder.length > 0 ? stampMilestoneIdsForOrder : undefined,
            stampsConsumed: stampsConsumedForOrder > 0 ? stampsConsumedForOrder : null,
            loyaltyDiscountSar: pointsDiscount > 0 ? pointsDiscount : null,
            relayToNooks: false });
        }
        const session = await paymentApi.payWithSavedCard(tokenOrderId, merchantId, selectedSavedCardId);
        if (session.status === 'paid' || session.status === 'captured') {
          createOrderAfterPayment(session.id);
        } else if (session.url) {
          // 3DS redirect required
          paymentSuccessHandled.current = false;
          moyasarInvoiceIdRef.current = session.id;
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

          {/* Stamp Rewards Redemption — list ALL of the merchant's
              defined milestones, marking each as redeemable / locked /
              budget-exceeded based on the customer's stamp count and
              currently-selected set. Sourced from stampMilestones not
              availableRedemptions to avoid the duplicate-row bug where
              a customer who crossed stamp-2 multiple times saw
              "stamp 2 reward" listed N times. */}
          {user?.id && loyaltyBalance && loyaltyType === 'stamps' && allMilestonesForUI.length > 0 && (
            <View className="mt-5 rounded-[28px] p-4" style={{ borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' }}>
              <View className="flex-row items-center mb-2">
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' }}>
                  <Star size={18} color="#94a3b8" fill="#94a3b8" />
                </View>
                <View className="ms-3 flex-1">
                  <Text className="font-bold text-slate-900">
                    {isArabic ? 'مكافآت الختم' : 'Stamp rewards'}
                  </Text>
                  <Text className="text-slate-500 text-xs mt-0.5">
                    {isArabic
                      ? `لديك ${loyaltyBalance.stamps} ختم — اختر المكافأة لإضافتها مجانًا`
                      : `You have ${loyaltyBalance.stamps} stamp${loyaltyBalance.stamps === 1 ? '' : 's'} — tap to redeem free`}
                  </Text>
                </View>
              </View>
              {allMilestonesForUI.map((milestone) => {
                const selected = selectedMilestoneIds.has(milestone.id);
                const remainingBudget = loyaltyBalance.stamps - selectedStampsBudget;
                // Budget exceeded only if NOT already selected and
                // remaining budget can't cover this milestone.
                const budgetBlocked = !selected && milestone.stamp_number > remainingBudget;
                const locked = !milestone.redeemable;
                const disabled = locked || budgetBlocked;
                const stampsShort = milestone.stamp_number - loyaltyBalance.stamps;
                return (
                  <TouchableOpacity
                    key={milestone.id}
                    onPress={() => { if (!disabled) toggleMilestone(milestone.id); }}
                    disabled={disabled}
                    className="flex-row items-center justify-between rounded-2xl px-3 py-3 mt-2"
                    style={{
                      borderWidth: 1,
                      borderColor: selected ? primaryColor : '#e2e8f0',
                      backgroundColor: selected ? `${primaryColor}10` : '#fff',
                      opacity: disabled ? 0.45 : 1 }}
                    activeOpacity={0.7}
                  >
                    <View className="flex-1 pe-3">
                      <Text className="font-semibold text-slate-900">
                        {milestone.reward_name || (isArabic ? 'مكافأة' : 'Reward')}
                      </Text>
                      <Text className="text-xs text-slate-500 mt-0.5">
                        {locked
                          ? (isArabic
                              ? `يلزم ${stampsShort} ختم إضافي`
                              : `Need ${stampsShort} more stamp${stampsShort === 1 ? '' : 's'}`)
                          : budgetBlocked
                            ? (isArabic
                                ? 'الرصيد المتبقي غير كافٍ مع المكافآت الأخرى المختارة'
                                : 'Not enough stamps left with other rewards selected')
                            : (isArabic
                                ? `يستهلك ${milestone.stamp_number} ختم`
                                : `Uses ${milestone.stamp_number} stamp${milestone.stamp_number === 1 ? '' : 's'}`)}
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
            <View className="flex-row justify-between mt-4 pt-4 border-t border-slate-200">
              <Text className="text-slate-900 font-bold">{isArabic ? 'الإجمالي شامل الضريبة' : 'Total VAT included'}</Text>
              <PriceWithSymbol amount={subtotalAfterPromo} iconSize={18} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 18 }} />
            </View>
            {/* Cashback / points credit — shown BELOW the Total VAT
                line so the row matches the wallet credit's layout
                (the customer reads: "Total 80 SAR, cashback −69,
                charged 11"). Previously the points line sat above
                Total and Total reflected the post-cashback amount,
                making cashback look like a discount on the subtotal
                while wallet was a credit on the total. */}
            {usePoints && pointsDiscount > 0 && (
              <View className="flex-row justify-between mt-2">
                <Text className="text-slate-900 font-medium">
                  {loyaltyType === 'cashback'
                    ? (isArabic ? 'رصيد الكاش باك' : 'Cashback credit')
                    : (isArabic ? `النقاط (${pointsToRedeem} نقطة)` : `Points (${pointsToRedeem} pts)`)}
                </Text>
                <PriceWithSymbol amount={pointsDiscount} prefix="- " iconSize={16} iconColor="#059669" textStyle={{ color: '#059669', fontWeight: '700' }} />
              </View>
            )}
            {/* Wallet credit applied — shown as a separate line under
                the total (mirrors how a deposit/credit shows on a
                receipt: it doesn't change the order amount, just what
                the customer pays now). */}
            {useWallet && walletApplied > 0 && (
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
            )}
            {/* "Charged to card" final line — shown whenever any
                credit (cashback OR wallet) reduces what the customer
                actually pays via card / Apple Pay. Without this the
                cashback-only flow ended at "Cashback credit −52" and
                the customer had to mentally compute the remainder. */}
            {((usePoints && pointsDiscount > 0) || (useWallet && walletApplied > 0)) && (
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
          {paymentMethod === 'apple_pay' && resolvedApplePayEnabled && paymentConfig && chargeAmount > 0 ? (
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
              ) : chargeAmount === 0 && selectedMilestoneIds.size > 0 ? (
                // Free-reward order: total is 0 + at least one
                // milestone selected. No card, no wallet — just
                // complete and ship the rewards to Foodics.
                <View className="flex-row items-center">
                  <Gift size={18} color="white" />
                  <Text className="text-white font-bold text-base ms-2">
                    {isArabic ? 'إتمام الطلب' : 'Complete order'}
                  </Text>
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

      {/* Moyasar 3DS hosted-checkout WebView (saved-card flow). */}
      <Modal visible={!!moyasarWebUrl} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView className="flex-1 bg-white">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
            <Text className="text-lg font-bold text-slate-800">{isArabic ? 'الدفع' : 'Payment'}</Text>
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
                  createOrderAfterPayment(moyasarInvoiceIdRef.current || undefined);
                  return false;
                }
                return true;
              }}
              onNavigationStateChange={(navState) => {
                const url = navState?.url ?? '';
                if ((url.includes('alsdraft0://') || url.includes('/api/payment/redirect')) && !paymentSuccessHandled.current) {
                  paymentSuccessHandled.current = true;
                  setMoyasarWebUrl(null);
                  createOrderAfterPayment(moyasarInvoiceIdRef.current || undefined);
                  return;
                }
                if (url.includes('moyasar') && (url.includes('callback') || url.includes('return') || url.includes('status=paid'))) {
                  if (!paymentSuccessHandled.current) {
                    paymentSuccessHandled.current = true;
                    setMoyasarWebUrl(null);
                    createOrderAfterPayment(moyasarInvoiceIdRef.current || undefined);
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
                  createOrderAfterPayment(moyasarInvoiceIdRef.current || undefined);
                }
              }}
            />
          )}
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
  );
}
