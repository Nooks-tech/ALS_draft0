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
  Image,
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
import { PaymentProcessingOverlay } from '../src/components/common/PaymentProcessingOverlay';
import { MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY, APPLE_PAY_MERCHANT_ID } from '../src/api/config';
import { paymentApi, type SavedCard } from '../src/api/payment';
import { walletApi } from '../src/api/wallet';
import { getDeliveryQuote } from '../src/api/deliveryQuote';
import { validateNooksPromo, calculateNooksPromoDiscount } from '../src/api/nooksPromos';

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
import { openMapToLocation } from '../src/lib/openMaps';
import { useQrLanding } from '../src/context/QrLandingContext';

// Wallet is no longer one of these — it's a redeemable credit
// applied via the useWallet toggle (see the cashback-style row in
// render). Card / Apple Pay handles the post-wallet remainder.
export type PaymentMethod = 'apple_pay' | 'credit_card' | 'saved_card';

const VAT_RATE = 0.15; // 15% Saudi VAT

/**
 * Reward-item rejections from POST /commit (server/routes/orders.ts)
 * used to read differently depending on payment path: Apple Pay showed a
 * hardcoded generic "Order failed" message while the saved-card path
 * showed the raw server string. Both catch sites now share this map so
 * the same server rejection code always shows the same friendly copy to
 * the customer, regardless of which payment method they used.
 *
 * REWARD_UNAUTHORIZED is intentionally NOT in this map — the server's own
 * `error` string for that code is already a friendly, reward-specific
 * reason (e.g. "Not enough points for this reward."), so callers should
 * show err.message directly instead of a generic mapped string.
 */
const REWARD_ERROR_COPY: Record<string, { en: string; ar: string }> = {
  REWARD_DUPLICATE_MILESTONE: {
    en: "You've already added this reward.",
    ar: 'لقد أضفت هذه المكافأة بالفعل.',
  },
  REWARD_DUPLICATE_LINE: {
    en: 'This reward is already in your cart.',
    ar: 'هذه المكافأة موجودة بالفعل في سلتك.',
  },
  REWARD_QTY_INVALID: {
    en: 'Reward items can only be redeemed one at a time.',
    ar: 'يمكن استبدال المكافآت بمقدار واحد فقط في كل مرة.',
  },
  REWARD_MALFORMED: {
    en: 'There was a problem with a reward item in your cart. Please remove it and try again.',
    ar: 'حدث خطأ في أحد عناصر المكافأة في سلتك. يرجى حذفه والمحاولة مرة أخرى.',
  },
  REWARD_MILESTONE_MISMATCH: {
    en: "Your rewards don't match your current points. Please refresh your cart and try again.",
    ar: 'مكافآتك لا تطابق رصيد نقاطك الحالي. يرجى تحديث السلة والمحاولة مرة أخرى.',
  },
  REWARD_TOO_MANY: {
    en: 'You can only redeem a limited number of rewards per order.',
    ar: 'يمكنك استبدال عدد محدود فقط من المكافآت في كل طلب.',
  },
};

/**
 * Resolve friendly copy for a /commit reward-rejection error, shared by
 * the Apple Pay and saved-card catch blocks. Returns null when `code`
 * isn't a recognized reward code, so callers fall back to their own
 * (payment-method-specific) default message.
 */
function friendlyRewardErrorMessage(
  code: string | undefined,
  serverMessage: string | undefined,
  isArabic: boolean,
): string | null {
  if (!code) return null;
  if (code === 'REWARD_UNAUTHORIZED') {
    return serverMessage || null;
  }
  const copy = REWARD_ERROR_COPY[code];
  if (!copy) return null;
  return isArabic ? copy.ar : copy.en;
}

/**
 * Deterministically turns a client-generated orderId into a UUID-shaped
 * string for Moyasar's `givenId` idempotency key (see the `paymentConfig`
 * useMemo below). Moyasar requires a well-formed UUID and treats two
 * payment attempts submitted with the same given_id as THE SAME payment —
 * it returns the original charge instead of creating a new one. That's
 * exactly what protects a retry after a settling timeout or a network
 * blip from minting a second Moyasar charge: same orderIdRef -> same
 * givenId -> Moyasar hands back the original payment.
 *
 * The server's mirror of this (server/services/payment.ts orderIdToUuid)
 * hashes with sha256 via Node's `crypto`. That module doesn't exist in
 * React Native, and this app has no sync hashing available at all —
 * `expo-crypto` (the natural replacement) isn't an installed dependency,
 * and its digestStringAsync is async besides, which doesn't fit the
 * synchronous useMemo that builds paymentConfig without turning it into
 * an effect that recomputes after an await (bigger surgery — flagged for
 * the humans, not done here). Adding expo-crypto pulls in native code,
 * which forces a new native build instead of an OTA — too big a lever for
 * this fix. So this uses a small NON-cryptographic string hash (cyrb128)
 * instead of sha256.
 *
 * That's safe here specifically because ONLY the client ever generates or
 * reads this value — Moyasar just needs *a* stable UUID per orderId, not
 * one that byte-matches the server's. The server computes its OWN
 * given_id independently (for STC Pay / invoice / saved-card flows) and
 * the two are never compared against each other, so the differing
 * algorithm is harmless.
 *
 * COUPLING WARNING — do not read this function's output without also
 * respecting the rotation rule: a givenId is only correct paired with
 * rotating orderIdRef.current on a *terminal* (reversed) commit failure,
 * and ONLY then. See the big comment in createOrderAfterPayment's catch
 * block before touching either half.
 */
function orderIdToClientGivenId(orderId: string): string {
  // cyrb128 (public-domain, bryc) — four independent 32-bit mixes of the
  // input string. Good avalanche/distribution for a short id, but NOT a
  // cryptographic hash — doesn't need to be, see the doc comment above.
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  const str = String(orderId);
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  const hex = [h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  // Lay out as 8-4-4-4-12 with the version (4) and variant (8) nibbles
  // pinned — same shape as the server's orderIdToUuid — so Moyasar
  // accepts it as a UUID.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    '8' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

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
  const { landing: qrLanding } = useQrLanding();
  const { addOrder } = useOrders();
  const { profile } = useProfile();
  const { isPickupOnly, effectivelyClosed, closedReason, reopensAt, reopenSecondsLeft } = useOperations();
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
  // promoType/promoValue are the promo's actual terms (percent-of-base
  // or fixed-amount), captured at apply-time. The discount AMOUNT is
  // never frozen — it's replayed against the LIVE cart on every render
  // via effectivePromoDiscount below, so it tracks cart edits made
  // after the code was applied (reward milestone toggles, going back
  // and changing quantities, etc.).
  const [promoType, setPromoType] = useState<'percent' | 'fixed'>('fixed');
  const [promoValue, setPromoValue] = useState(0);
  // Where the discount applies — drives both the UI ("delivery free!"
  // vs "10 off your subtotal") and the Foodics order body (delivery
  // promos shrink charges[].amount, subtotal promos scale the line
  // unit_prices).
  const [promoScope, setPromoScope] = useState<'total' | 'delivery' | 'order_total'>('total');
  const [showCouponInput, setShowCouponInput] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [draftOrderNote, setDraftOrderNote] = useState('');
  // Curbside ("Receive from your car") — Foodics has no curbside slot,
  // so the order ships as a pickup with these four fields appended to
  // customer_notes ("car:<letters> <numbers> | <model> | <color>"). All
  // four are required to enable Pay when orderType === 'drivethru'.
  const [carPlateLetters, setCarPlateLetters] = useState('');
  const [carPlateNumbers, setCarPlateNumbers] = useState('');
  const [carModel, setCarModel] = useState('');
  const [carColor, setCarColor] = useState('');
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
          // Carry the real menu price through so the Foodics relay
          // can ship the line at face value + a matching reward
          // discount (POS receipt then reads "Cookie 13 SAR · Discount
          // 13 SAR" instead of "Cookie 0 SAR · no discount"). Matches
          // the rewards.tsx path that already passes this. Mirror
          // here was missing — both screens add the same item type
          // to the cart, and Foodics needs the price either way.
          rewardOriginalPriceSar:
            typeof product.price === 'number' ? product.price : 0,
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
  // Recompute the discount from the LIVE cart on every render instead of
  // freezing a SAR amount at apply-time. The cart can change after a
  // promo is applied — reward milestones toggle cart items, and
  // the customer can navigate back and edit quantities — so a frozen SAR
  // amount can end up larger than the current subtotal supports. The
  // server now re-derives + enforces the same promo math at commit
  // (PRICE_RECONCILE_MODE=enforce), so a stale discount here gets the
  // whole order rejected as an under-charge. calculateNooksPromoDiscount
  // is the exact same pure function the server's cap logic mirrors.
  const effectivePromoDiscount = useMemo(
    () =>
      promoApplied
        ? calculateNooksPromoDiscount(
            { id: '', code: promoCode, name: promoCode, type: promoType, value: promoValue, scope: promoScope },
            totalPrice,
            deliveryFee,
          )
        : 0,
    [promoApplied, promoCode, promoType, promoValue, promoScope, totalPrice, deliveryFee],
  );
  const discount = effectivePromoDiscount;
  const subtotalAfterPromo = Math.max(0, subtotalBeforePromo - discount);

  // Loyalty discount: caps at the entire post-promo total (items +
  // delivery) so cashback can absorb the same amount of bill that
  // wallet can. Previously this was `totalPrice - discount` (items
  // only) which silently capped cashback below the order total and
  // left the customer wondering why "Save up to X" was lower than
  // wallet's "Save up to Y" on the same cart.
  const itemsAfterPromo = Math.max(0, totalPrice - discount);
  const maxCashbackCap = loyaltyBalance?.maxCashbackPerOrderSar ?? null;
  // Money discounts at checkout are a CASHBACK-ONLY feature. Points can
  // NEVER convert into a SAR discount — they are redeemed exclusively
  // for the reward items the merchant configured (the /rewards
  // milestones flow). The old points branch here multiplied
  // points × pointValueSar into a cash discount, which the server now
  // rejects (LOYALTY_CASH_DISCOUNT_NOT_ALLOWED).
  const maxPointsDiscountSar =
    loyaltyBalance && loyaltyType === 'cashback'
      ? Math.min(
          +(loyaltyBalance.cashbackBalance ?? 0),
          ...(maxCashbackCap != null ? [maxCashbackCap] : []),
        )
      : 0;
  const pointsDiscount =
    usePoints && loyaltyType === 'cashback' ? Math.min(maxPointsDiscountSar, subtotalAfterPromo) : 0;

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
  // Curbside / drivethru must carry all four car fields before Pay
  // becomes pressable — without them the cashier can't identify the
  // vehicle and the order is operationally useless. Server-side
  // validation duplicates the check, but blocking client-side avoids
  // the round trip + a confusing failure mid-Pay.
  const curbsideCarInfoMissing =
    orderType === 'drivethru' &&
    (!carPlateLetters.trim() || !carPlateNumbers.trim() || !carModel.trim() || !carColor.trim());
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
        // Idempotency key for Moyasar — see orderIdToClientGivenId's doc
        // comment above for why this is a non-crypto hash instead of the
        // server's sha256, and why that mismatch is harmless. This MUST
        // stay coupled to orderIdRef.current: it's read directly (not via
        // a dep-array-tracked state value) because orderIdRef is a ref, so
        // recomputation relies on SOME other dep changing on the next
        // render after a rotation — which always happens, because every
        // call site that rotates orderIdRef.current also calls
        // setSubmitting(false) in its surrounding finally block, forcing
        // a re-render that picks the new ref value back up here.
        givenId: orderIdToClientGivenId(orderIdRef.current),
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
    // orderIdRef.current is a ref read, not state — it's listed here so
    // React re-diffs it on the next render (see the givenId comment
    // above); mutating a ref alone does NOT trigger that render, only
    // the setSubmitting(false) that always accompanies a rotation does.
  }, [amountHalals, appName, customerPaymentsEnabled, merchantId, orderIdRef.current, resolvedApplePayEnabled, resolvedPublishableKey, saveCardChecked, user?.id]);

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
            setPromoType(validation.type);
            setPromoValue(validation.value);
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
      } else {
        Alert.alert(
          isArabic ? 'خطأ في الإعدادات' : 'Configuration Error',
          isArabic ? 'إعدادات المتجر ناقصة.' : 'Merchant configuration is missing.',
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
    setPromoType('fixed');
    setPromoValue(0);
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

      // SCAL-003: ONE commit for the direct-card path. The old redundant
      // first commit (relayToNooks:false) was removed — the single final
      // commit below upserts the order row itself, so nothing is lost.
      //
      // This final commit is AWAITED. The server verifies the Moyasar payment
      // exactly once (no 2s sleep), fires the side effects (wallet debit,
      // promo + cashback redeem, milestone consume) and relays to Foodics; if
      // the verify catches a 3DS-abandoned 'initiated'/'pending' it returns
      // 202 and commitOrder transparently retries the SAME commit (no new
      // charge) at 1s/2s/4s. If any of that ultimately fails the server
      // reverses everything and throws, and we must NOT surface the order or
      // redeem stamps/cashback/wallet on the client side.
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
            promoDiscountSar: promoApplied ? effectivePromoDiscount : null,
            promoScope: promoApplied ? promoScope : null,
            customerNote: orderNote.trim() || null,
          qrCodeId: qrLanding.qrCodeId,
          guests: orderType === 'dine_in' ? 1 : null,
            carDetails:
              orderType === 'drivethru'
                ? {
                    plate_letters: carPlateLetters.trim(),
                    plate_numbers: carPlateNumbers.trim(),
                    model: carModel.trim(),
                    color: carColor.trim(),
                  }
                : null,
            loyaltyDiscountSar: pointsDiscount > 0 ? pointsDiscount : null,
            walletAmountSar: walletApplied > 0 ? Number(walletApplied.toFixed(2)) : null,
            cashbackAmountSar: cashbackAmountForOrder > 0 ? cashbackAmountForOrder : null,
            stampMilestoneIds: stampMilestoneIdsForOrder.length > 0 ? stampMilestoneIdsForOrder : undefined,
            stampsConsumed: stampsConsumedForOrder > 0 ? stampsConsumedForOrder : null,
            relayToNooks: true });
          finalCommitOk = true;
        } catch (err: any) {
          console.warn('[Checkout] Final commit failed:', err?.message, {
            terminal: err?.terminal,
            reversal: err?.reversal,
          });
          // The charge has ALREADY happened at this point (Apple Pay /
          // saved-card session succeeded before this commit ran).
          //
          // ⚠️ ROTATION RULE — this is the other half of the givenId
          // coupling documented on orderIdToClientGivenId / paymentConfig
          // above. NEVER change one half without the other:
          //   - err.terminal === true means the server (server/routes/
          //     orders.ts /api/orders/commit, as of a3ac828) has ALREADY
          //     reversed or flagged this exact charge before rejecting the
          //     commit. Reusing the same orderId — and therefore the same
          //     givenId — on the next attempt would hand Moyasar back the
          //     now-VOIDED payment, verify would fail, and checkout would
          //     be permanently bricked (this is the same class of bug as
          //     the subscription-renewal given_id deadlock, fixed
          //     2026-07-02). So: rotate orderIdRef AND drop the stored
          //     saved-card invoice id so the next tap is a genuinely fresh
          //     order with a fresh givenId -> a fresh charge.
          //   - Anything else — the 202-settling retry budget exhausted
          //     (PaymentSettlingError, code 'PAYMENT_SETTLING') or an
          //     ambiguous network/timeout error with no structured
          //     `terminal` at all — means we do NOT know the charge was
          //     reversed. It may still be sitting there, still settling.
          //     Rotating here would let a retry mint a SECOND charge
          //     instead of Moyasar recognizing the unchanged givenId and
          //     handing back the first payment. So: touch NOTHING.
          if (err?.terminal === true) {
            orderIdRef.current = `order-${Date.now()}`;
            moyasarInvoiceIdRef.current = null;
            setMoyasarWebUrl(null);
          }
          // Copy driven off the server's reversal signal instead of a
          // blanket promise. "Refunded within minutes" was a lie — a card
          // reversal (especially mada) can take days to drop off a
          // statement — so it's gone from every branch below, not just
          // the happy one.
          const rewardMsg = friendlyRewardErrorMessage(err?.code, err?.message, isArabic);
          const reversal = err?.terminal === true ? err?.reversal : undefined;
          let fallbackMsg: string;
          if (reversal === 'completed' || reversal === 'no_charge') {
            fallbackMsg = isArabic
              ? 'ما تم تنفيذ طلبك، وتم إلغاء المبلغ المدفوع بالكامل — ما راح يتم خصم أي شيء منك. حسب البنك، قد يبقى ظاهر كحجز مؤقت لعدة أيام قبل ما يختفي من كشف حسابك. تقدر تحاول مرة ثانية.'
              : "Your order didn't go through, and your payment has been reversed — you have not been charged. Depending on your bank, a temporary hold may take a few days to disappear. You can try again.";
          } else if (reversal === 'pending_manual') {
            // Do NOT invite an immediate retry here — that would stack
            // more manual-review charges on top of this one.
            fallbackMsg = isArabic
              ? `ما تم تنفيذ طلبك. لو شفت أي مبلغ مخصوم من بطاقتك، لا تقلق — تم رصده من طرفنا وراح يتم إرجاعه لك. الرقم المرجعي: ${orderId}. تواصل مع الدعم لو تحتاج تحديث عن حالته.`
              : `Your order didn't go through. If you see a charge, don't worry — it's flagged on our side and will be returned. Reference: ${orderId}. Contact support if you'd like an update.`;
          } else if (err?.code === 'PAYMENT_SETTLING') {
            // Known-but-not-terminal: the settling retry budget ran out
            // client-side. The charge is likely fine and still
            // confirming — actively discourage an immediate re-tap since
            // (per the rotation rule above) we deliberately did NOT
            // rotate, so a same-givenId retry is safe but pointless if
            // the first attempt is still in flight.
            fallbackMsg = isArabic
              ? 'دفعتك لسه قيد التأكيد. تابع تبويب طلباتك بعد شوي قبل ما تحاول مرة ثانية — عشان ما نخصم بطاقتك مرتين.'
              : "Your payment is still confirming. Please check your Orders tab in a moment before trying again — we don't want to charge your card twice.";
          } else {
            // Ambiguous — network error/timeout, or a terminal:true whose
            // reversal value we don't recognize. Stay cautious in both
            // directions: don't claim the charge was reversed, don't
            // claim it's fine, don't promise a timeline.
            fallbackMsg = isArabic
              ? 'ما قدرنا نأكد حالة طلبك. لو انخصم أي مبلغ، تابع تبويب طلباتك بعد شوي، أو تواصل مع الدعم لو استمر الخصم.'
              : "We couldn't confirm your order. If any amount was charged, please check your Orders tab in a moment, or contact support if the charge doesn't clear.";
          }
          Alert.alert(
            isArabic ? 'فشل إنشاء الطلب' : 'Order failed',
            rewardMsg ?? fallbackMsg,
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
          promoDiscountSar: promoApplied ? effectivePromoDiscount : undefined,
          promoScope: promoApplied ? promoScope : undefined,
          customerNote: orderNote.trim() || undefined,
          qrCodeId: qrLanding.qrCodeId ?? undefined,
          guests: orderType === 'dine_in' ? 1 : undefined,
          customerName: profile.fullName || undefined,
          customerPhone: profile.phone || undefined,
          customerEmail: profile.email || undefined,
          serverPersisted: Boolean(user?.id) },
        orderId,
        // Match what we actually wrote to DB. Using 'Preparing' here
        // flashed the wrong badge until the Realtime UPDATE arrived.
        'Placed'
      );
      // Promo redemption is NO LONGER done here — Express /commit now
      // calls the atomic redeem_promo RPC before INSERT. The RPC
      // enforces expiry + usage_limit and writes the
      // promo_redemptions row idempotently. Calling consumeNooksPromo
      // here would double-increment the usage_count.
      //
      // Cashback redemption is ALSO server-side now: the final /commit
      // performs the atomic deduction itself (idempotent per order), so
      // the old post-commit redeemCashback call is gone — and the
      // points→cash redeem call with it (points are reward-items only;
      // the server rejects any points-as-discount claim).
      // LOY-2: milestone redemption is handled ATOMICALLY server-side during
      // commit (consumeOrderMilestones deducts the selected milestones and
      // dedups against any rewards-screen pre-redemption). The old post-commit
      // redeemStampMilestone loop was deprecated (it 400s without an
      // idempotencyKey) and is removed here so it can never be "fixed" into a
      // second deduction on top of the server-side consume.
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
      router.replace({ pathname: '/order-confirmed', params: { orderId, orderType } });
    } catch (err: any) {
      Alert.alert(
        isArabic ? 'فشل الطلب' : 'Order Failed',
        err?.message || (isArabic ? 'ما قدرنا ننشئ طلبك. تواصل مع الدعم لو سمحت.' : 'Order could not be created. Please contact support.'),
      );
    } finally {
      setSubmitting(false);
    }
  }, [cartItems, rewardItemsForOrder, selectedMilestoneIds, finalTotal, orderType, merchantId, selectedBranch, deliveryAddress, deliveryFee, paymentMethod, addOrder, promoApplied, promoCode, profile.fullName, profile.phone, profile.email, clearCart, usePoints, pointsDiscount, loyaltyType, router, user?.id, walletApplied]);

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
        // Show the overlay IMMEDIATELY — before createOrderAfterPayment
        // sets submitting itself — so there's no visual gap between the
        // Apple Pay sheet closing and the commit starting. Apple Pay
        // dismisses its own sheet on success and we get ~50-300ms before
        // the commit POST returns, which used to be a blank screen.
        setSubmitting(true);
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
    if (effectivelyClosed) {
      Alert.alert(
        isArabic ? 'الطلب غير متاح' : 'Ordering Unavailable',
        closedReason === 'busy'
          ? (isArabic
              ? `${branchName} مشغول حالياً — يفتح الطلب بعد حوالي ${Math.max(1, Math.ceil(reopenSecondsLeft / 60))} دقيقة.`
              : `${branchName} is temporarily busy — ordering reopens in about ${Math.max(1, Math.ceil(reopenSecondsLeft / 60))} min.`)
          : (isArabic
              ? `${branchName} مغلق حالياً.`
              : `${branchName} is currently closed.`),
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
          promoDiscountSar: promoApplied ? effectivePromoDiscount : null,
          promoScope: promoApplied ? promoScope : null,
          customerNote: orderNote.trim() || null,
          qrCodeId: qrLanding.qrCodeId,
          guests: orderType === 'dine_in' ? 1 : null,
          carDetails:
            orderType === 'drivethru'
              ? {
                  plate_letters: carPlateLetters.trim(),
                  plate_numbers: carPlateNumbers.trim(),
                  model: carModel.trim(),
                  color: carColor.trim(),
                }
              : null,
          // No wallet debit for free-reward orders. Wallet-only
          // orders debit the full total via the legacy 'wallet'
          // paymentMethod path the server still understands.
          walletAmountSar: isFreeRewardOrder ? null : Number(finalTotal.toFixed(2)),
          cashbackAmountSar: cashbackAmountForOrder > 0 ? cashbackAmountForOrder : null,
          stampMilestoneIds: stampMilestoneIdsForOrder.length > 0 ? stampMilestoneIdsForOrder : undefined,
          stampsConsumed: stampsConsumedForOrder > 0 ? stampsConsumedForOrder : null,
          loyaltyDiscountSar: pointsDiscount > 0 ? pointsDiscount : null,
          relayToNooks: true });

        // Cashback deduction is server-side now: the final /commit above
        // performed the atomic redemption itself (idempotent per order),
        // so no post-commit redeemCashback call. Points never deduct as
        // money — they only flow through reward items (milestones).
        // LOY-2: milestone consumption for this wallet order is handled
        // atomically server-side during commit (consumeOrderMilestones); the
        // deprecated post-commit redeemStampMilestone loop (which 400s without
        // an idempotencyKey) is removed to prevent any double-deduction.

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
            promoDiscountSar: promoApplied ? effectivePromoDiscount : undefined,
            promoScope: promoApplied ? promoScope : undefined,
            customerNote: orderNote.trim() || undefined,
          qrCodeId: qrLanding.qrCodeId ?? undefined,
          guests: orderType === 'dine_in' ? 1 : undefined,
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
        router.replace({ pathname: '/order-confirmed', params: { orderId: walletOrderId, orderType } });
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
            promoDiscountSar: promoApplied ? effectivePromoDiscount : null,
            promoScope: promoApplied ? promoScope : null,
            customerNote: orderNote.trim() || null,
          qrCodeId: qrLanding.qrCodeId,
          guests: orderType === 'dine_in' ? 1 : null,
            carDetails:
              orderType === 'drivethru'
                ? {
                    plate_letters: carPlateLetters.trim(),
                    plate_numbers: carPlateNumbers.trim(),
                    model: carModel.trim(),
                    color: carColor.trim(),
                  }
                : null,
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
          // Pre-charge path — no refund caveat needed here (unlike the
          // Apple Pay / final-commit catch). Reward-rejection codes get
          // the SAME mapped copy as the Apple Pay path so the wording is
          // identical regardless of payment method.
          const rewardMsg = friendlyRewardErrorMessage(err?.code, msg, isArabic);
          Alert.alert(
            isArabic ? 'خطأ في الدفع' : 'Payment Error',
            rewardMsg ?? (err instanceof Error ? err.message : (isArabic ? 'تعذر بدء عملية الدفع.' : 'Failed to start payment.')),
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
      {/* Full-screen payment-processing overlay. Mounts the moment
          submitting flips true (card / wallet / cashback / stamps /
          Apple Pay all set it during their commit path). Replaces the
          tiny ActivityIndicator that used to live inside the Pay
          button — easier to notice and consistent with Apple Pay
          where the native button has no spinner. */}
      <PaymentProcessingOverlay
        visible={submitting}
        isArabic={isArabic}
        primaryColor={primaryColor}
        orderSummary={{
          items: cartItems.map((it) => ({ name: it.name, quantity: it.quantity })),
          orderType,
          locationLabel:
            orderType === 'delivery'
              ? deliveryAddress?.address || '—'
              : selectedBranch?.name || '—',
        }}
      />
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
          {orderType === 'delivery' && isPickupOnly && !effectivelyClosed && (
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
          {effectivelyClosed && (() => {
            const isBusyReason = closedReason === 'busy';
            const opensAtClock = (() => {
              if (closedReason !== 'outside_hours' || !reopensAt) return null;
              const at = Date.parse(reopensAt);
              if (!Number.isFinite(at)) return null;
              return new Date(at).toLocaleTimeString(isArabic ? 'ar-SA' : 'en-US', { hour: 'numeric', minute: '2-digit' });
            })();
            return (
            <View
              className="mb-4 rounded-2xl p-4 flex-row items-start"
              style={{
                backgroundColor: isBusyReason ? '#fffbeb' : '#fef2f2',
                borderWidth: 1,
                borderColor: isBusyReason ? '#fde68a' : '#fecaca' }}
            >
              <View style={{ marginTop: 2 }}>
                {isBusyReason ? (
                  <Clock size={20} color="#d97706" />
                ) : (
                  <X size={20} color="#dc2626" />
                )}
              </View>
              <View className="ms-3 flex-1">
                <Text
                  style={{
                    color: isBusyReason ? '#92400e' : '#991b1b',
                    fontWeight: '700',
                    fontSize: 14 }}
                >
                  {isBusyReason
                    ? (isArabic
                        ? `${selectedBranch?.name ?? 'هذا الفرع'} مشغول حالياً`
                        : `${selectedBranch?.name ?? 'This branch'} is temporarily busy`)
                    : (isArabic
                        ? `${selectedBranch?.name ?? 'هذا الفرع'} مغلق حالياً`
                        : `${selectedBranch?.name ?? 'This branch'} is currently closed`)}
                </Text>
                <Text
                  style={{
                    color: isBusyReason ? '#a16207' : '#b91c1c',
                    fontSize: 12,
                    marginTop: 4 }}
                >
                  {isBusyReason && reopenSecondsLeft > 0
                    ? (isArabic
                        ? `يفتح الطلب تلقائياً بعد حوالي ${Math.max(1, Math.ceil(reopenSecondsLeft / 60))} دقيقة.`
                        : `Ordering reopens automatically in about ${Math.max(1, Math.ceil(reopenSecondsLeft / 60))} min.`)
                    : opensAtClock
                      ? (isArabic
                          ? `خارج ساعات العمل — يفتح الساعة ${opensAtClock}.`
                          : `Outside working hours — opens at ${opensAtClock}.`)
                      : orderType === 'delivery'
                        ? (isArabic
                            ? 'هذا هو الفرع الأقرب لعنوانك. لا يمكن استقبال الطلبات الآن.'
                            : "This is the branch closest to your address. Orders can't be placed right now.")
                        : (isArabic
                            ? 'لا يمكن استقبال الطلبات من هذا الفرع الآن.'
                            : "Orders can't be placed at this branch right now.")}
                </Text>
              </View>
            </View>
            );
          })()}

          {/* Delivery & Order Details (display only, no change) */}
          <View className="bg-slate-50 rounded-[28px] border border-slate-100 overflow-hidden">
            <View className="flex-row items-center px-4 py-4">
              {/* MapPin icon doubles as a tap target when the branch
                  has coords. Pickup + drivethru both need this — the
                  customer is physically driving to the branch. */}
              {(() => {
                const isPickupLike = orderType === 'pickup' || orderType === 'drivethru';
                const branchLat = (selectedBranch as { latitude?: number } | null)?.latitude;
                const branchLng = (selectedBranch as { longitude?: number } | null)?.longitude;
                const canOpenMap =
                  isPickupLike && typeof branchLat === 'number' && typeof branchLng === 'number';
                const inner = (
                  <View className="w-11 h-11 rounded-2xl items-center justify-center" style={{ backgroundColor: `${primaryColor}18` }}>
                    <MapPin size={20} color={primaryColor} />
                  </View>
                );
                if (!canOpenMap) return inner;
                return (
                  <TouchableOpacity
                    onPress={() => openMapToLocation(branchLat, branchLng, selectedBranch?.name, isArabic ? 'ar' : 'en')}
                    accessibilityLabel={isArabic ? 'افتح الخريطة' : 'Open map'}
                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                  >
                    {inner}
                  </TouchableOpacity>
                );
              })()}
              <View className="flex-1 ms-3">
                <Text className="text-slate-500 text-xs font-bold uppercase tracking-widest">
                  {orderType === 'delivery'
                    ? (isArabic ? 'التوصيل إلى' : 'Delivery to')
                    : orderType === 'drivethru'
                      ? (isArabic ? 'استلام من السيارة' : 'Car pickup at')
                      : (isArabic ? 'الاستلام من' : 'Pickup from')}
                </Text>
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

          {/* Read-only order items — lets the customer confirm exactly
              what they're paying for before they pay. Deliberately has
              NO quantity steppers, remove buttons, or edit navigation:
              this is a summary, not an editor. Styling matches the
              read-only item rows in order-detail-modal.tsx. To change
              the order the customer goes back to the Cart screen. */}
          <View className="mt-4 bg-slate-50 rounded-[28px] border border-slate-100 p-4">
            <Text className="text-slate-900 text-base font-bold mb-3">{isArabic ? 'عناصر طلبك' : 'Your Items'}</Text>
            {cartItems.map((item) => {
              const isReward = item.uniqueId.startsWith('reward-');
              return (
                <View key={item.uniqueId} className="flex-row items-center mb-3">
                  {item.image ? (
                    <Image source={{ uri: item.image }} className="w-12 h-12 rounded-xl bg-slate-200" />
                  ) : (
                    <View className="w-12 h-12 rounded-xl bg-slate-200 items-center justify-center">
                      <Gift size={18} color="#94a3b8" />
                    </View>
                  )}
                  <View className="flex-1 ms-3">
                    <Text className="text-slate-800 font-bold text-sm" numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text className="text-slate-400 text-xs mt-0.5">
                      {isArabic ? `الكمية ×${item.quantity}` : `Qty x${item.quantity}`}
                    </Text>
                  </View>
                  {isReward ? (
                    <Text style={{ color: primaryColor, fontWeight: '700', fontSize: 13 }}>
                      {isArabic ? 'مجاناً 🎁' : 'FREE 🎁'}
                    </Text>
                  ) : (
                    <PriceWithSymbol
                      amount={item.price * item.quantity}
                      iconSize={14}
                      iconColor="#0f172a"
                      textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 14 }}
                    />
                  )}
                </View>
              );
            })}
          </View>

          {/* Curbside — "Receive from your car". Four fields ride to
              Foodics in customer_notes (no native curbside slot). Plate
              is split into letters + numbers because Saudi plates are
              two separate panels and we want them legible on the POS
              receipt as "ABC 1234" rather than "ABC1234". */}
          {orderType === 'drivethru' && (
            <View className="mt-4 bg-slate-50 rounded-[28px] border border-slate-100 p-4">
              <View className="flex-row items-center mb-3">
                <Car size={20} color={primaryColor} />
                <Text className="font-bold text-slate-900 ms-2">{isArabic ? 'معلومات سيارتك' : 'Your car info'}</Text>
              </View>
              {/* Plate: letters + numbers side by side. autoCapitalize
                  on letters because plate letters are uppercase by
                  convention; keyboard='numeric' on numbers. */}
              {/* placeholderTextColor: the default iOS placeholder
                  rgba(0,0,0,0.22) is too faint against bg-white inside
                  the bg-slate-50 card — the form looked empty/disabled
                  in screenshots. Bump to slate-400 (#94a3b8) so the
                  hint is readable while still distinct from typed
                  values. */}
              <Text className="text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">{isArabic ? 'لوحة السيارة' : 'License Plate'}</Text>
              <View className="flex-row mb-3" style={{ gap: 8 }}>
                <TextInput
                  className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm text-center font-bold"
                  placeholder={isArabic ? 'الحروف' : 'Letters'}
                  placeholderTextColor="#94a3b8"
                  value={carPlateLetters}
                  onChangeText={(v) => setCarPlateLetters(v.toUpperCase())}
                  autoCapitalize="characters"
                  maxLength={10}
                />
                <TextInput
                  className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm text-center font-bold"
                  placeholder={isArabic ? 'الأرقام' : 'Numbers'}
                  placeholderTextColor="#94a3b8"
                  value={carPlateNumbers}
                  onChangeText={setCarPlateNumbers}
                  keyboardType="number-pad"
                  maxLength={10}
                />
              </View>
              <Text className="text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">{isArabic ? 'موديل السيارة' : 'Car Model'}</Text>
              <TextInput
                className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm mb-3"
                placeholder={isArabic ? 'مثل: كامري 2024' : 'e.g. Camry 2024'}
                placeholderTextColor="#94a3b8"
                value={carModel}
                onChangeText={setCarModel}
                maxLength={40}
              />
              <Text className="text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">{isArabic ? 'اللون' : 'Color'}</Text>
              <TextInput
                className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-slate-900 text-sm"
                placeholder={isArabic ? 'مثل: أبيض' : 'e.g. White'}
                placeholderTextColor="#94a3b8"
                value={carColor}
                onChangeText={setCarColor}
                maxLength={20}
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
                <View className="flex-row items-center"><Text className="text-slate-500 text-sm">−</Text><PriceWithSymbol amount={effectivePromoDiscount} iconSize={14} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 14 }} /></View>
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

          {/* Cashback Redemption Toggle — CASHBACK merchants only. A
              money discount at checkout is a cashback feature; points
              customers redeem their points for the merchant's reward
              items on the Rewards screen (hint card below), never as
              cash. The server enforces the same rule at /commit. */}
          {user?.id && loyaltyBalance && loyaltyType === 'cashback' && (loyaltyBalance.cashbackBalance ?? 0) > 0 && (
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
                    {isArabic ? `استخدم ${(loyaltyBalance.cashbackBalance ?? 0).toFixed(2)} ر.س كاش باك` : `Use ${(loyaltyBalance.cashbackBalance ?? 0).toFixed(2)} SAR cashback`}
                  </Text>
                  <View className="flex-row items-center flex-wrap mt-0.5">
                    <Text className="text-slate-500 text-xs">{isArabic ? 'وفّر حتى ' : 'Save up to '}</Text>
                    <PriceWithSymbol amount={Math.min(maxPointsDiscountSar, itemsAfterPromo)} iconSize={12} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 12 }} />
                  </View>
                  {maxCashbackCap != null && (
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
          )}

          {/* Points hint — points customers see WHERE their points are
              usable instead of a cash toggle. */}
          {user?.id && loyaltyBalance && loyaltyType === 'points' && loyaltyBalance.points > 0 && (
            <TouchableOpacity
              onPress={() => router.push('/rewards' as never)}
              className="mt-5 rounded-[28px] p-4 flex-row items-center"
              style={{ borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' }}
              activeOpacity={0.7}
            >
              <View
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: '#f1f5f9',
                  alignItems: 'center', justifyContent: 'center' }}
              >
                <Star size={18} color="#94a3b8" />
              </View>
              <View className="ms-3 flex-1">
                <Text className="font-bold text-slate-900">
                  {isArabic ? `لديك ${loyaltyBalance.points} نقطة` : `You have ${loyaltyBalance.points} points`}
                </Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  {isArabic
                    ? 'استبدل نقاطك بمكافآت من صفحة المكافآت — النقاط لا تُستخدم كخصم نقدي.'
                    : 'Redeem them for rewards on the Rewards page — points can’t be used as a cash discount.'}
                </Text>
              </View>
            </TouchableOpacity>
          )}

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
            {/* order_total promos discount the whole order (subtotal +
                delivery) — attribute the saving on its own line above
                Total instead of striking one component. */}
            {promoApplied && promoScope === 'order_total' && discount > 0 && (
              <View className="flex-row justify-between items-baseline mt-2">
                <Text className="text-emerald-600 font-medium">{isArabic ? 'خصم الكود' : 'Promo discount'}</Text>
                <Text className="text-emerald-600 font-bold">−{discount.toFixed(2)}</Text>
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
                  {isArabic ? 'رصيد الكاش باك' : 'Cashback credit'}
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
          {/* The native ApplePayButton opens the payment sheet directly
              and never runs handlePay — so it must NOT render while the
              store is effectively closed, or a customer could be charged
              at a closed branch. The fallback branch renders the regular
              (disabled) button + banner instead.
              Also gated on !submitting: the native button is a PassKit
              control the SDK doesn't expose a `disabled` prop for (unlike
              the fallback TouchableOpacity below, which already has
              `disabled={submitting || ...}`), so the only reliable way to
              stop a second tap from opening a second Apple Pay sheet
              while a commit is in flight is to unmount it outright rather
              than trust pointerEvents/disabled on a native view. NOTE
              this only closes the CONCURRENT double-tap window — it does
              NOT stop a SERIAL retry after this commit fails, because
              submitting flips back to false (createOrderAfterPayment's
              finally block, earlier in this file) before the failure
              Alert shows. Serial retries are made safe
              by the givenId + rotation-on-terminal-failure pair instead
              (see orderIdToClientGivenId and the catch block in
              createOrderAfterPayment). */}
          {paymentMethod === 'apple_pay' && resolvedApplePayEnabled && paymentConfig && chargeAmount > 0 && !curbsideCarInfoMissing && !effectivelyClosed && !submitting ? (
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
              disabled={submitting || deliveryQuoteLoading || !deliveryQuoteWithin || curbsideCarInfoMissing || effectivelyClosed}
              className="px-6 py-4 rounded-[24px] min-w-[190px] items-center flex-row justify-center"
              style={{ backgroundColor: primaryColor, opacity: (submitting || deliveryQuoteLoading || !deliveryQuoteWithin || curbsideCarInfoMissing || effectivelyClosed) ? 0.5 : 1 }}
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
