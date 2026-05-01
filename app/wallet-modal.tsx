/**
 * Customer wallet screen.
 *
 * Lives at /wallet-modal — opened from the More tab. Shows the current
 * (per-merchant) balance, history of credits / debits, and a "Add
 * money" sheet that drops the customer into the Moyasar credit-card
 * form. After the card is charged we call /api/wallet/topup-finalize
 * to credit the wallet idempotently and refresh the displayed balance.
 *
 * Refunds from approved complaints land here as 'refund' entries.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CreditCard,
  Plus,
  RotateCcw,
  ShoppingBag,
  Wallet,
  X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import {
  ApplePay as ApplePayButton,
  ApplePayConfig,
  CreditCardConfig,
  PaymentConfig,
  PaymentResponse,
  PaymentStatus,
  isMoyasarError } from 'react-native-moyasar-sdk';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { APPLE_PAY_MERCHANT_ID, MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY } from '../src/api/config';
import { walletApi, type WalletBalance, type WalletEntry } from '../src/api/wallet';
import { paymentApi, type SavedCard } from '../src/api/payment';
import { useAuth } from '../src/context/AuthContext';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useProfile } from '../src/context/ProfileContext';

const TOPUP_PRESETS_SAR = [50, 100, 200, 500];
const TOPUP_MIN = 5;
const TOPUP_MAX = 5000;

function formatDate(iso: string | null | undefined, locale: 'ar' | 'en'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short' }).format(d);
}

function entryAccent(entry: WalletEntry): { tint: string; bg: string; Icon: typeof Plus } {
  switch (entry.entry_type) {
    case 'topup':
      return { tint: '#059669', bg: '#ecfdf5', Icon: Plus };
    case 'refund':
      return { tint: '#0284c7', bg: '#eff6ff', Icon: RotateCcw };
    case 'spend':
      return { tint: '#0f172a', bg: '#f1f5f9', Icon: ShoppingBag };
    default:
      return { tint: '#6b7280', bg: '#f3f4f6', Icon: Plus };
  }
}

export default function WalletModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, cafeName } = useMerchantBranding();
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  const { profile } = useProfile();
  const isArabic = i18n.language === 'ar';
  const BackIcon = isArabic ? ArrowRight : ArrowLeft;

  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [topupOpen, setTopupOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!user?.id || !merchantId) {
      setBalance(null);
      setLoading(false);
      return;
    }
    try {
      const next = await walletApi.getBalance(merchantId);
      setBalance(next);
    } catch (e) {
      // best-effort — keep last known balance
    } finally {
      setLoading(false);
    }
  }, [user?.id, merchantId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  if (!user?.id || !merchantId) {
    return (
      <SafeAreaView className="flex-1 bg-white" edges={['top']}>
        <View className="px-5 py-4 border-b border-slate-100 flex-row items-center justify-between" style={{ flexDirection: 'row' }}>
          <TouchableOpacity onPress={() => router.back()} className="p-2 rounded-full bg-slate-100">
            <BackIcon size={20} color="#334155" />
          </TouchableOpacity>
          <Text className="text-lg font-bold text-slate-900">{isArabic ? 'محفظتي' : 'My Wallet'}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View className="flex-1 items-center justify-center px-8">
          <Wallet size={40} color="#94a3b8" />
          <Text className="mt-4 text-center text-slate-500">
            {isArabic ? 'سجّل دخول لاستخدام المحفظة.' : 'Sign in to use your wallet.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['top']}>
      <View className="px-5 py-4 border-b border-slate-100 flex-row items-center justify-between" style={{ flexDirection: 'row' }}>
        <TouchableOpacity onPress={() => router.back()} className="p-2 rounded-full bg-slate-100">
          <BackIcon size={20} color="#334155" />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-slate-900">{isArabic ? 'محفظتي' : 'My Wallet'}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Balance card */}
        <View className="mx-5 mt-5 rounded-[28px] p-6" style={{ backgroundColor: primaryColor }}>
          <Text className="text-white/80 text-xs uppercase tracking-wider" style={{ }}>
            {isArabic ? `رصيد ${cafeName ?? 'المحفظة'}` : `${cafeName ?? 'Wallet'} balance`}
          </Text>
          <View className="mt-2" style={{ alignItems: isArabic ? 'flex-end' : 'flex-start' }}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <PriceWithSymbol
                amount={balance?.balance_sar ?? 0}
                iconSize={28}
                iconColor="#fff"
                textStyle={{ color: '#fff', fontWeight: '700', fontSize: 36 }}
              />
            )}
          </View>
          <View className="mt-5" style={{ flexDirection: 'row' }}>
            <TouchableOpacity
              onPress={() => setTopupOpen(true)}
              className="flex-1 bg-white/15 rounded-2xl py-3 px-4 flex-row items-center justify-center"
            >
              <Plus size={18} color="#fff" />
              <Text className="text-white font-bold ml-2">{isArabic ? 'إضافة رصيد' : 'Add money'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats */}
        {balance && !loading && (
          <View className="mx-5 mt-5 flex-row gap-3">
            <View className="flex-1 rounded-2xl bg-slate-50 border border-slate-100 p-4">
              <Text className="text-xs text-slate-500 uppercase tracking-wider" style={{ }}>
                {isArabic ? 'مجموع الإضافات' : 'Total topped up'}
              </Text>
              <View className="mt-1.5" style={{ alignItems: isArabic ? 'flex-end' : 'flex-start' }}>
                <PriceWithSymbol amount={balance.total_topup_sar} iconSize={14} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 16 }} />
              </View>
            </View>
            <View className="flex-1 rounded-2xl bg-slate-50 border border-slate-100 p-4">
              <Text className="text-xs text-slate-500 uppercase tracking-wider" style={{ }}>
                {isArabic ? 'مسترد' : 'Refunded'}
              </Text>
              <View className="mt-1.5" style={{ alignItems: isArabic ? 'flex-end' : 'flex-start' }}>
                <PriceWithSymbol amount={balance.total_refunded_sar} iconSize={14} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 16 }} />
              </View>
            </View>
          </View>
        )}

        {/* History */}
        <View className="mx-5 mt-6">
          <Text className="text-slate-900 text-lg font-bold mb-3" style={{ }}>
            {isArabic ? 'سجل المعاملات' : 'Transactions'}
          </Text>
          {loading ? (
            <ActivityIndicator color={primaryColor} />
          ) : !balance || balance.entries.length === 0 ? (
            <View className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 items-center">
              <Wallet size={28} color="#94a3b8" />
              <Text className="mt-3 text-slate-500 text-sm text-center">
                {isArabic ? 'لا توجد معاملات بعد. اضغط "إضافة رصيد" لتعبئة محفظتك.' : 'No transactions yet. Tap "Add money" to top up.'}
              </Text>
            </View>
          ) : (
            balance.entries.map((entry) => {
              const { tint, bg, Icon } = entryAccent(entry);
              const credit = entry.amount_sar > 0;
              return (
                <View
                  key={entry.id}
                  className="rounded-2xl border border-slate-100 bg-white p-4 mb-2"
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                >
                  <View className="rounded-full p-2.5" style={{ backgroundColor: bg }}>
                    <Icon size={18} color={tint} />
                  </View>
                  <View className="flex-1" style={{ marginStart: 12 }}>
                    <Text className="font-semibold text-slate-900" style={{ }}>
                      {entry.entry_type === 'topup'
                        ? (isArabic ? 'تعبئة رصيد' : 'Top-up')
                        : entry.entry_type === 'refund'
                          ? (isArabic ? 'استرداد' : 'Refund')
                          : entry.entry_type === 'spend'
                            ? (isArabic ? 'دفع' : 'Spend')
                            : (isArabic ? 'تسوية' : 'Adjustment')}
                    </Text>
                    <Text className="text-xs text-slate-400 mt-0.5" style={{ }}>
                      {formatDate(entry.created_at, isArabic ? 'ar' : 'en')}
                      {entry.note ? ` · ${entry.note}` : ''}
                    </Text>
                  </View>
                  <View style={{ alignItems: isArabic ? 'flex-start' : 'flex-end' }}>
                    <PriceWithSymbol
                      amount={Math.abs(entry.amount_sar)}
                      prefix={credit ? '+ ' : '- '}
                      iconSize={14}
                      iconColor={credit ? '#059669' : '#0f172a'}
                      textStyle={{ color: credit ? '#059669' : '#0f172a', fontWeight: '700', fontSize: 15 }}
                    />
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {topupOpen && (
        <TopupSheet
          merchantId={merchantId}
          customerName={profile.fullName || ''}
          customerEmail={profile.email || undefined}
          customerPhone={profile.phone || undefined}
          onClose={() => setTopupOpen(false)}
          onSuccess={async () => {
            setTopupOpen(false);
            await reload();
            Alert.alert(
              isArabic ? 'تم!' : 'Done!',
              isArabic ? 'تم تعبئة محفظتك.' : 'Your wallet was topped up.',
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

/* ============================================================
 * TopupSheet
 *
 * Three-stage flow:
 *   1. Amount picker (presets + custom field)
 *   2. Payment-method picker — Apple Pay (when supported) and any
 *      saved cards. Tap a method to select it; tap Pay at the bottom
 *      to charge. There's also an "Add new card" row that opens
 *      /add-card-modal so the customer can add one without leaving
 *      the wallet flow.
 *   3. 3DS WebView — only opens when Moyasar requires the issuer
 *      step. Lands back on sdk.moyasar.com/return → we call
 *      /topup-finalize and refresh.
 *
 * No more Moyasar SDK card form: cards are added via the same custom
 * /add-card-modal screen the checkout uses, then charged via the
 * server-side /topup-with-saved-card endpoint.
 * ============================================================ */

type WalletPaymentChoice =
  | { kind: 'saved_card'; cardId: string }
  | { kind: 'apple_pay' };

const TOKEN_RETURN_HOSTNAME = 'sdk.moyasar.com';

function TopupSheet({
  merchantId,
  customerName,
  customerEmail,
  customerPhone,
  onClose,
  onSuccess }: {
  merchantId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const isArabic = i18n.language === 'ar';
  const rowDirection: 'row' | 'row-reverse' = isArabic ? 'row-reverse' : 'row';
  const textAlign: 'left' | 'right' = isArabic ? 'right' : 'left';
  const {
    primaryColor,
    applePayEnabled,
    applePayMerchantId,
    cafeName,
    appName } = useMerchantBranding();

  const resolvedApplePayMerchantId = (applePayMerchantId || APPLE_PAY_MERCHANT_ID || '').trim();
  const resolvedApplePayEnabled =
    applePayEnabled && Platform.OS === 'ios' && !!resolvedApplePayMerchantId && !!MOYASAR_PUBLISHABLE_KEY;

  const [amountText, setAmountText] = useState('100');
  const [stage, setStage] = useState<'pick' | 'pay'>('pick');
  const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [choice, setChoice] = useState<WalletPaymentChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [pendingPaymentId, setPendingPaymentId] = useState<string | null>(null);

  const amountNum = useMemo(() => Number(amountText), [amountText]);
  const amountValid = Number.isFinite(amountNum) && amountNum >= TOPUP_MIN && amountNum <= TOPUP_MAX;
  const amountHalalas = useMemo(() => Math.round(amountNum * 100), [amountNum]);

  // Refresh cards on mount AND on focus (we may have come back from
  // /add-card-modal). Auto-pick the first saved card on first load
  // so the customer doesn't have to make a redundant choice.
  const loadCards = useCallback(async () => {
    if (!merchantId) return;
    try {
      setCardsLoading(true);
      const list = await paymentApi.getSavedCards(merchantId);
      setSavedCards(list);
      if (list.length > 0 && !choice) {
        setChoice({ kind: 'saved_card', cardId: list[0].id });
      }
    } catch {
      /* keep prior list */
    } finally {
      setCardsLoading(false);
    }
  }, [merchantId, choice]);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  useFocusEffect(
    useCallback(() => {
      void loadCards();
    }, [loadCards]),
  );

  // Apple Pay paymentConfig — only built when Apple Pay is supported
  // for this merchant. metadata.type='wallet_topup' is what the
  // /topup-finalize endpoint requires to credit the wallet.
  const applePayConfig = useMemo(() => {
    if (!resolvedApplePayEnabled) return null;
    if (!user?.id) return null; // server validates this too
    try {
      return new PaymentConfig({
        publishableApiKey: MOYASAR_PUBLISHABLE_KEY,
        baseUrl: MOYASAR_BASE_URL,
        amount: Math.max(amountHalalas, 100),
        currency: 'SAR',
        merchantCountryCode: 'SA',
        description: `${cafeName ?? appName ?? 'Wallet'} top-up`,
        metadata: {
          type: 'wallet_topup',
          merchant_id: merchantId,
          ...(user?.id ? { customer_id: user.id } : {}) },
        supportedNetworks: ['mada', 'visa', 'mastercard', 'amex'],
        creditCard: new CreditCardConfig({ saveCard: false, manual: false }),
        applePay: new ApplePayConfig({
          merchantId: resolvedApplePayMerchantId,
          label: appName || cafeName || 'Wallet',
          manual: false,
          saveCard: false }),
        createSaveOnlyToken: false });
    } catch {
      return null;
    }
  // user.id is read above — pull in via closure on render. We don't
  // strictly need to add it to deps since it doesn't change between
  // renders for an authed wallet session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountHalalas, appName, cafeName, merchantId, resolvedApplePayEnabled, resolvedApplePayMerchantId]);

  const goToPaymentStage = () => {
    if (!amountValid) return;
    setStage('pay');
  };

  const onApplePayResult = useCallback(
    async (result: any) => {
      if (isMoyasarError(result)) {
        Alert.alert(
          isArabic ? 'الدفع فشل' : 'Payment failed',
          (result as any)?.message ?? '',
        );
        return;
      }
      const r = result as PaymentResponse;
      const status = (r as any)?.status as PaymentStatus | undefined;
      const id = (r as any)?.id as string | undefined;
      if (status !== 'paid' || !id) {
        Alert.alert(
          isArabic ? 'الدفع لم يكتمل' : 'Payment not completed',
          isArabic ? 'حاول مرة أخرى.' : 'Please try again.',
        );
        return;
      }
      try {
        await walletApi.topupFinalize({ paymentId: id, merchantId });
        await onSuccess();
      } catch (e: any) {
        Alert.alert(
          isArabic ? 'تأخّر تحديث الرصيد' : 'Balance update delayed',
          e?.message || (isArabic ? 'حاول السحب للتحديث بعد قليل.' : 'Pull to refresh in a moment.'),
        );
      }
    },
    [merchantId, onSuccess, isArabic],
  );

  const paySavedCard = useCallback(async () => {
    if (!amountValid || !choice || choice.kind !== 'saved_card') return;
    setSubmitting(true);
    try {
      const res = await walletApi.topupWithSavedCard({
        merchantId,
        savedCardId: choice.cardId,
        amount_sar: amountNum });

      // 3DS required — open verification URL in a WebView; finalize
      // once the bank lands back on sdk.moyasar.com/return.
      if (res.verification_url && res.payment_id) {
        setPendingPaymentId(res.payment_id);
        setVerifyUrl(res.verification_url);
        return;
      }

      if (res.success) {
        await onSuccess();
        return;
      }

      Alert.alert(
        isArabic ? 'الدفع لم يكتمل' : 'Payment not completed',
        res.status ? `Status: ${res.status}` : (isArabic ? 'حاول مرة أخرى.' : 'Please try again.'),
      );
    } catch (e: any) {
      Alert.alert(
        isArabic ? 'فشل الدفع' : 'Payment failed',
        e?.message || (isArabic ? 'حاول مرة أخرى.' : 'Please try again.'),
      );
    } finally {
      setSubmitting(false);
    }
  }, [amountNum, amountValid, choice, isArabic, merchantId, onSuccess]);

  const onVerifyNavigationChange = useCallback(
    async (url: string) => {
      if (!url || !pendingPaymentId) return;
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        host = url.includes(TOKEN_RETURN_HOSTNAME) ? TOKEN_RETURN_HOSTNAME : '';
      }
      if (host !== TOKEN_RETURN_HOSTNAME) return;
      const id = pendingPaymentId;
      setPendingPaymentId(null);
      setVerifyUrl(null);
      try {
        await walletApi.topupFinalize({ paymentId: id, merchantId });
        await onSuccess();
      } catch (e: any) {
        Alert.alert(
          isArabic ? 'فشل التحقق' : 'Verification failed',
          e?.message || (isArabic ? 'تعذر إكمال تعبئة الرصيد.' : 'Could not finish the top-up.'),
        );
      }
    },
    [merchantId, onSuccess, pendingPaymentId, isArabic],
  );

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-white">
        <View
          className="px-5 py-4 border-b border-slate-100 items-center justify-between"
          style={{ flexDirection: 'row' }}
        >
          <Text className="text-lg font-bold text-slate-800">
            {stage === 'pick' ? (isArabic ? 'إضافة رصيد' : 'Add money') : (isArabic ? 'الدفع' : 'Payment')}
          </Text>
          <TouchableOpacity onPress={onClose} className="p-2">
            <X size={22} color="#64748b" />
          </TouchableOpacity>
        </View>

        {stage === 'pick' ? (
          <ScrollView className="flex-1 px-5 py-6" keyboardShouldPersistTaps="handled">
            <Text className="text-sm text-slate-500 mb-3" style={{ textAlign }}>
              {isArabic
                ? `الحد الأدنى ${TOPUP_MIN} ر.س — الأعلى ${TOPUP_MAX}`
                : `Minimum ${TOPUP_MIN} SAR — Maximum ${TOPUP_MAX}`}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {TOPUP_PRESETS_SAR.map((preset) => {
                const selected = amountNum === preset;
                return (
                  <TouchableOpacity
                    key={preset}
                    onPress={() => setAmountText(String(preset))}
                    className="rounded-2xl px-5 py-3 border"
                    style={{
                      borderColor: selected ? primaryColor : '#e2e8f0',
                      backgroundColor: selected ? `${primaryColor}10` : '#fff' }}
                  >
                    <Text className="font-semibold" style={{ color: selected ? primaryColor : '#0f172a' }}>
                      {preset} {isArabic ? 'ر.س' : 'SAR'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text className="mt-6 text-xs text-slate-500 uppercase tracking-wider" style={{ textAlign }}>
              {isArabic ? 'مبلغ مخصص' : 'Custom amount'}
            </Text>
            <View
              className="mt-2 items-center border border-slate-200 rounded-2xl px-4 py-3"
              style={{ flexDirection: 'row' }}
            >
              <TextInput
                value={amountText}
                onChangeText={setAmountText}
                keyboardType="numeric"
                inputMode="decimal"
                className="flex-1 text-slate-900 text-lg font-semibold"
                style={{ textAlign }}
                placeholder="100"
              />
              <Text
                className="text-slate-500"
                style={{ marginStart: 8 }}
              >
                {isArabic ? 'ر.س' : 'SAR'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={goToPaymentStage}
              disabled={!amountValid}
              className="mt-8 rounded-[28px] py-4 items-center"
              style={{ backgroundColor: amountValid ? primaryColor : '#cbd5e1' }}
            >
              <Text className="text-white font-bold text-lg">
                {isArabic ? 'متابعة' : 'Continue'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <ScrollView className="flex-1 px-5 py-6" keyboardShouldPersistTaps="handled">
            <Text className="text-sm text-slate-500" style={{ textAlign }}>
              {isArabic ? 'المبلغ' : 'Amount'}
            </Text>
            <View
              className="mt-1 items-center"
              style={{ flexDirection: 'row' }}
            >
              <PriceWithSymbol
                amount={amountNum}
                iconSize={22}
                iconColor="#0f172a"
                textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 24 }}
              />
              <TouchableOpacity
                onPress={() => setStage('pick')}
                className="rounded-full px-3 py-1 bg-slate-100"
                style={{ marginStart: 12 }}
              >
                <Text className="text-slate-700 text-xs font-semibold">
                  {isArabic ? 'تعديل' : 'Edit'}
                </Text>
              </TouchableOpacity>
            </View>

            <Text
              className="mt-6 text-xs text-slate-500 uppercase tracking-wider"
              style={{ textAlign }}
            >
              {isArabic ? 'اختر طريقة الدفع' : 'Choose payment method'}
            </Text>

            {/* Apple Pay row */}
            {resolvedApplePayEnabled && (
              <TouchableOpacity
                onPress={() => setChoice({ kind: 'apple_pay' })}
                className="mt-3 items-center rounded-2xl border p-4"
                style={{
                  flexDirection: 'row',
                  borderColor: choice?.kind === 'apple_pay' ? primaryColor : '#e2e8f0',
                  backgroundColor: choice?.kind === 'apple_pay' ? `${primaryColor}08` : '#fff' }}
              >
                <View className="w-12 h-8 bg-black rounded items-center justify-center">
                  <Text className="text-white font-bold text-xs">{'\uF8FF'} Pay</Text>
                </View>
                <Text
                  className="font-bold text-slate-900"
                  style={{ marginStart: 12, flex: 1, textAlign }}
                >
                  {'\uF8FF'} Apple Pay
                </Text>
                {choice?.kind === 'apple_pay' && (
                  <View
                    className="w-5 h-5 rounded-full items-center justify-center"
                    style={{ backgroundColor: primaryColor }}
                  >
                    <Text className="text-white text-xs font-bold">✓</Text>
                  </View>
                )}
              </TouchableOpacity>
            )}

            {/* Saved cards */}
            {cardsLoading ? (
              <View className="mt-3"><ActivityIndicator color={primaryColor} /></View>
            ) : savedCards.length === 0 ? (
              <View
                className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 items-center"
                style={{ flexDirection: 'row' }}
              >
                <CreditCard size={20} color="#94a3b8" />
                <Text
                  className="text-slate-500 text-sm flex-1"
                  style={{ marginStart: 10, textAlign }}
                >
                  {isArabic
                    ? 'لا توجد بطاقات محفوظة. أضف بطاقة لاستخدامها هنا.'
                    : 'No saved cards yet. Add one to use it for top-ups.'}
                </Text>
              </View>
            ) : (
              savedCards.map((card) => {
                const selected = choice?.kind === 'saved_card' && choice.cardId === card.id;
                return (
                  <TouchableOpacity
                    key={card.id}
                    onPress={() => setChoice({ kind: 'saved_card', cardId: card.id })}
                    className="mt-3 items-center rounded-2xl border p-4"
                    style={{
                      flexDirection: 'row',
                      borderColor: selected ? primaryColor : '#e2e8f0',
                      backgroundColor: selected ? `${primaryColor}08` : '#fff' }}
                  >
                    <View
                      className="bg-slate-100 p-2.5 rounded-xl"
                      style={{ marginEnd: 12 }}
                    >
                      <CreditCard size={18} color={primaryColor} />
                    </View>
                    <View className="flex-1">
                      <Text className="font-bold text-slate-800" style={{ textAlign }}>
                        {(card.brand || 'Card').toUpperCase()} •••• {card.last_four || '****'}
                      </Text>
                      {card.name ? (
                        <Text className="text-slate-400 text-xs" style={{ textAlign }}>
                          {card.name}
                        </Text>
                      ) : null}
                    </View>
                    {selected && (
                      <View
                        className="w-5 h-5 rounded-full items-center justify-center"
                        style={{ backgroundColor: primaryColor }}
                      >
                        <Text className="text-white text-xs font-bold">✓</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })
            )}

            {/* Add new card row — opens our custom add-card modal so the
                customer never sees the Moyasar SDK form. After save,
                the focus effect refreshes the list. */}
            <TouchableOpacity
              onPress={() => router.push('/add-card-modal')}
              className="mt-3 items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 p-3"
              style={{ flexDirection: 'row' }}
            >
              <Plus size={18} color={primaryColor} />
              <Text
                className="font-bold"
                style={{
                  color: primaryColor,
                  marginStart: 8 }}
              >
                {isArabic ? 'إضافة بطاقة جديدة' : 'Add a new card'}
              </Text>
            </TouchableOpacity>

            {/* Pay button — for Apple Pay we render the SDK button
                inline (it triggers the native sheet). For saved cards
                we render our own primary CTA that calls the server. */}
            <View className="mt-8">
              {choice?.kind === 'apple_pay' && applePayConfig ? (
                <ApplePayButton
                  paymentConfig={applePayConfig}
                  onPaymentResult={(r: any) => { void onApplePayResult(r); }}
                  // SDK defaults to white-on-light-mode and white-on-
                  // dark-mode (which made the button invisible against
                  // our dark background). Pin the iOS-spec black style
                  // explicitly so it reads on any background.
                  style={{
                    buttonType: 'plain',
                    buttonStyle: 'black',
                    height: 50,
                    width: '100%',
                    cornerRadius: 28 }}
                />
              ) : (
                <TouchableOpacity
                  onPress={paySavedCard}
                  disabled={
                    submitting ||
                    !amountValid ||
                    !choice ||
                    choice.kind !== 'saved_card'
                  }
                  className="rounded-[28px] py-4 items-center"
                  style={{
                    backgroundColor:
                      submitting || !choice || choice.kind !== 'saved_card'
                        ? '#cbd5e1'
                        : primaryColor }}
                  activeOpacity={0.9}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text className="text-white font-bold text-lg">
                      {isArabic ? 'ادفع' : 'Pay'}
                    </Text>
                  )}
                </TouchableOpacity>
              )}
            </View>

            <Text className="mt-4 text-xs text-slate-400 text-center">
              {isArabic
                ? 'الدفع يتم عبر Moyasar — بياناتك محمية بمعيار PCI DSS.'
                : 'Payment goes through Moyasar — your card data is held under PCI DSS.'}
            </Text>
          </ScrollView>
        )}

        {/* 3DS WebView for saved-card top-ups when the issuer demands it */}
        <Modal
          visible={!!verifyUrl}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => {
            if (!submitting) {
              setVerifyUrl(null);
              setPendingPaymentId(null);
            }
          }}
        >
          <SafeAreaView className="flex-1 bg-white">
            <View
              className="items-center justify-between px-5 py-4 border-b border-slate-100"
              style={{ flexDirection: 'row' }}
            >
              <Text className="text-lg font-bold text-slate-800">
                {isArabic ? 'تحقق البطاقة' : 'Card Verification'}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setVerifyUrl(null);
                  setPendingPaymentId(null);
                }}
                className="p-2"
              >
                <X size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            {verifyUrl ? (
              <WebView
                source={{ uri: verifyUrl }}
                style={{ flex: 1 }}
                onShouldStartLoadWithRequest={(request) => {
                  onVerifyNavigationChange((request as any).url ?? '');
                  return true;
                }}
                onNavigationStateChange={(state) => onVerifyNavigationChange(state?.url ?? '')}
              />
            ) : null}
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}
