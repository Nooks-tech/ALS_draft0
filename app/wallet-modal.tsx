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
  Plus,
  RotateCcw,
  ShoppingBag,
  Wallet,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CreditCard as CreditCardPayment,
  CreditCardConfig,
  PaymentConfig,
  PaymentResponse,
  PaymentStatus,
  isMoyasarError,
} from 'react-native-moyasar-sdk';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { MOYASAR_BASE_URL, MOYASAR_PUBLISHABLE_KEY } from '../src/api/config';
import { walletApi, type WalletBalance, type WalletEntry } from '../src/api/wallet';
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
    timeStyle: 'short',
  }).format(d);
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
        <View className="px-5 py-4 border-b border-slate-100 flex-row items-center justify-between" style={{ flexDirection: isArabic ? 'row-reverse' : 'row' }}>
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
      <View className="px-5 py-4 border-b border-slate-100 flex-row items-center justify-between" style={{ flexDirection: isArabic ? 'row-reverse' : 'row' }}>
        <TouchableOpacity onPress={() => router.back()} className="p-2 rounded-full bg-slate-100">
          <BackIcon size={20} color="#334155" />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-slate-900">{isArabic ? 'محفظتي' : 'My Wallet'}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Balance card */}
        <View className="mx-5 mt-5 rounded-[28px] p-6" style={{ backgroundColor: primaryColor }}>
          <Text className="text-white/80 text-xs uppercase tracking-wider" style={{ textAlign: isArabic ? 'right' : 'left' }}>
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
          <View className="mt-5" style={{ flexDirection: isArabic ? 'row-reverse' : 'row' }}>
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
              <Text className="text-xs text-slate-500 uppercase tracking-wider" style={{ textAlign: isArabic ? 'right' : 'left' }}>
                {isArabic ? 'مجموع الإضافات' : 'Total topped up'}
              </Text>
              <View className="mt-1.5" style={{ alignItems: isArabic ? 'flex-end' : 'flex-start' }}>
                <PriceWithSymbol amount={balance.total_topup_sar} iconSize={14} iconColor="#0f172a" textStyle={{ color: '#0f172a', fontWeight: '700', fontSize: 16 }} />
              </View>
            </View>
            <View className="flex-1 rounded-2xl bg-slate-50 border border-slate-100 p-4">
              <Text className="text-xs text-slate-500 uppercase tracking-wider" style={{ textAlign: isArabic ? 'right' : 'left' }}>
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
          <Text className="text-slate-900 text-lg font-bold mb-3" style={{ textAlign: isArabic ? 'right' : 'left' }}>
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
                  style={{ flexDirection: isArabic ? 'row-reverse' : 'row', alignItems: 'center' }}
                >
                  <View className="rounded-full p-2.5" style={{ backgroundColor: bg }}>
                    <Icon size={18} color={tint} />
                  </View>
                  <View className="flex-1" style={{ marginLeft: isArabic ? 0 : 12, marginRight: isArabic ? 12 : 0 }}>
                    <Text className="font-semibold text-slate-900" style={{ textAlign: isArabic ? 'right' : 'left' }}>
                      {entry.entry_type === 'topup'
                        ? (isArabic ? 'تعبئة رصيد' : 'Top-up')
                        : entry.entry_type === 'refund'
                          ? (isArabic ? 'استرداد' : 'Refund')
                          : entry.entry_type === 'spend'
                            ? (isArabic ? 'دفع' : 'Spend')
                            : (isArabic ? 'تسوية' : 'Adjustment')}
                    </Text>
                    <Text className="text-xs text-slate-400 mt-0.5" style={{ textAlign: isArabic ? 'right' : 'left' }}>
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
 * Two stages:
 *   1. amount picker (presets + custom field)
 *   2. Moyasar credit-card form rendered inside the same modal so the
 *      customer never leaves the wallet screen.
 * ============================================================ */
function TopupSheet({
  merchantId,
  customerName,
  customerEmail,
  customerPhone,
  onClose,
  onSuccess,
}: {
  merchantId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';
  const { primaryColor } = useMerchantBranding();
  const [amountText, setAmountText] = useState('100');
  const [stage, setStage] = useState<'pick' | 'pay'>('pick');
  const [paymentSessionId, setPaymentSessionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const amountNum = useMemo(() => Number(amountText), [amountText]);
  const amountValid = Number.isFinite(amountNum) && amountNum >= TOPUP_MIN && amountNum <= TOPUP_MAX;

  const startPayment = useCallback(async () => {
    if (!amountValid) return;
    setSubmitting(true);
    try {
      const session = await walletApi.topupInitiate({
        amount_sar: amountNum,
        merchantId,
        customer: { name: customerName || 'Customer', email: customerEmail, phone: customerPhone },
      });
      setPaymentSessionId(session.id);
      setStage('pay');
    } catch (e: any) {
      Alert.alert(
        isArabic ? 'تعذّر بدء الدفع' : 'Could not start payment',
        e?.message || 'Try again in a moment.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [amountNum, amountValid, customerName, customerEmail, customerPhone, isArabic, merchantId]);

  const handleResult = useCallback(
    async (result: PaymentResponse) => {
      if (!paymentSessionId) return;
      const status = (result as any)?.status as PaymentStatus | undefined;
      const id = (result as any)?.id as string | undefined;
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
          e?.message || 'Pull to refresh in a moment.',
        );
      }
    },
    [merchantId, onSuccess, paymentSessionId, isArabic],
  );

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-white">
        <View className="px-5 py-4 border-b border-slate-100 flex-row items-center justify-between">
          <Text className="text-lg font-bold text-slate-800">
            {stage === 'pick' ? (isArabic ? 'إضافة رصيد' : 'Add money') : (isArabic ? 'الدفع' : 'Payment')}
          </Text>
          <TouchableOpacity onPress={onClose} className="p-2"><X size={22} color="#64748b" /></TouchableOpacity>
        </View>

        {stage === 'pick' ? (
          <ScrollView className="flex-1 px-5 py-6">
            <Text className="text-sm text-slate-500 mb-3">
              {isArabic ? `الحد الأدنى ${TOPUP_MIN} ر.س — الأعلى ${TOPUP_MAX}` : `Minimum ${TOPUP_MIN} SAR — Maximum ${TOPUP_MAX}`}
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
                      backgroundColor: selected ? `${primaryColor}10` : '#fff',
                    }}
                  >
                    <Text className="font-semibold" style={{ color: selected ? primaryColor : '#0f172a' }}>
                      {preset} {isArabic ? 'ر.س' : 'SAR'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text className="mt-6 text-xs text-slate-500 uppercase tracking-wider">
              {isArabic ? 'مبلغ مخصص' : 'Custom amount'}
            </Text>
            <View className="mt-2 flex-row items-center border border-slate-200 rounded-2xl px-4 py-3">
              <TextInput
                value={amountText}
                onChangeText={setAmountText}
                keyboardType="numeric"
                inputMode="decimal"
                className="flex-1 text-slate-900 text-lg font-semibold"
                placeholder="100"
              />
              <Text className="ml-2 text-slate-500">{isArabic ? 'ر.س' : 'SAR'}</Text>
            </View>
            <TouchableOpacity
              onPress={startPayment}
              disabled={!amountValid || submitting}
              className="mt-8 rounded-[28px] py-4 items-center"
              style={{ backgroundColor: amountValid ? primaryColor : '#cbd5e1' }}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : (
                <Text className="text-white font-bold text-lg">{isArabic ? 'متابعة' : 'Continue'}</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <ScrollView className="flex-1 px-5 py-6" keyboardShouldPersistTaps="handled">
            {paymentSessionId && (
              <CreditCardPayment
                amount={Math.round(amountNum * 100)}
                paymentConfig={
                  new PaymentConfig({
                    publishableApiKey: MOYASAR_PUBLISHABLE_KEY,
                    amount: Math.round(amountNum * 100),
                    description: `Wallet top-up — ${amountNum} SAR`,
                    metadata: { type: 'wallet_topup' },
                    creditCard: new CreditCardConfig({ saveCard: false, manual: false }),
                  })
                }
                baseUrl={MOYASAR_BASE_URL}
                onPaymentResult={(result) => {
                  if (isMoyasarError(result)) {
                    Alert.alert(
                      isArabic ? 'الدفع فشل' : 'Payment failed',
                      (result as any)?.message ?? '',
                    );
                    return;
                  }
                  void handleResult(result as PaymentResponse);
                }}
              />
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}
