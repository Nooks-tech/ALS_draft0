import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CreditCard, Lock, ShieldCheck, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { WebView } from 'react-native-webview';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { paymentApi } from '../src/api/payment';
import {
  createMoyasarToken,
  type CreateTokenResponse,
  MoyasarTokenError,
} from '../src/api/moyasarTokenize';

/**
 * Add-a-card screen. Replaces the Moyasar SDK's hosted card form with
 * our own UI. Calling flow:
 *
 *   1. User types name / number / expiry / CVC and taps Save Card.
 *   2. We POST directly to Moyasar /v1/tokens with `save_only=true`
 *      using the merchant's publishable key. No payment is charged.
 *   3. If Moyasar requires 3DS verification, the response includes a
 *      `verification_url` — we open that in a webview, and the user's
 *      bank does its dance. Closing back to sdk.moyasar.com/return
 *      means the token is verified.
 *   4. We call /api/payment/saved-cards/attach so the server links the
 *      verified token to (customer, merchant) — server re-fetches the
 *      token with the secret key to read canonical brand/last_four.
 *   5. router.back() — caller refreshes its saved-card list.
 *
 * Pay button stays on the checkout screen. The user reviews their
 * order, then taps Pay, which uses the saved card via /token-pay.
 */

const TOKEN_RETURN_HOSTNAME = 'sdk.moyasar.com';

function formatCardNumber(s: string): string {
  const digits = s.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function formatExpiry(s: string): string {
  const digits = s.replace(/\D/g, '').slice(0, 4);
  if (digits.length < 3) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

function detectBrand(rawDigits: string): 'visa' | 'mastercard' | 'amex' | 'mada' | null {
  const s = rawDigits.replace(/\D/g, '');
  if (!s) return null;
  // mada BINs (subset — covers the most common mada-issuing banks).
  // mada cards happen to also pass the visa/mastercard prefix tests
  // since the network is co-branded — check mada FIRST.
  if (
    /^(4(40647|41327|432064|556746|492550|512893|513213)|5(2(1076|24514|29741|35825|37767|39931))|6(27780|36120))/.test(
      s,
    )
  ) {
    return 'mada';
  }
  if (/^4/.test(s)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(s)) return 'mastercard';
  if (/^3[47]/.test(s)) return 'amex';
  return null;
}

function brandLabel(brand: ReturnType<typeof detectBrand>, isArabic: boolean): string {
  if (!brand) return '';
  if (isArabic) {
    if (brand === 'mada') return 'مدى';
    if (brand === 'visa') return 'فيزا';
    if (brand === 'mastercard') return 'ماستركارد';
    if (brand === 'amex') return 'أمريكان إكسبريس';
  }
  return brand[0].toUpperCase() + brand.slice(1);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.charAt(i), 10);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum > 0 && sum % 10 === 0;
}

function parseExpiry(s: string): { month: string; year: string } | null {
  const m = s.match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const year2 = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  // 2-digit → 4-digit (assume 20xx).
  const year = 2000 + year2;
  // Reject already-expired cards. We compare against the LAST day of
  // the expiry month, which matches issuer behaviour.
  const now = new Date();
  const expEnd = new Date(year, month, 0, 23, 59, 59);
  if (expEnd < now) return null;
  return { month: String(month).padStart(2, '0'), year: String(year) };
}

export default function AddCardModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, moyasarPublishableKey } = useMerchantBranding();
  const { merchantId } = useMerchant();
  const isArabic = i18n.language === 'ar';
  const rowDirection: 'row' | 'row-reverse' = isArabic ? 'row-reverse' : 'row';
  const textAlign: 'left' | 'right' = isArabic ? 'right' : 'left';
  const modalHeight = Dimensions.get('window').height * 0.9;

  const [name, setName] = useState('');
  const [cardNumberRaw, setCardNumberRaw] = useState(''); // digits only
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [errors, setErrors] = useState<{ name?: string; number?: string; expiry?: string; cvc?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const pendingTokenRef = useRef<string | null>(null);

  const brand = useMemo(() => detectBrand(cardNumberRaw), [cardNumberRaw]);
  const cvcLen = brand === 'amex' ? 4 : 3;

  const cardNumberFormatted = useMemo(() => formatCardNumber(cardNumberRaw), [cardNumberRaw]);

  const close = () => {
    if (submitting) return;
    router.back();
  };

  const validate = (): boolean => {
    const next: typeof errors = {};
    if (!name.trim() || name.trim().length < 3) {
      next.name = isArabic ? 'أدخل اسم حامل البطاقة' : 'Enter the cardholder name';
    }
    if (cardNumberRaw.length < 12 || !luhn(cardNumberRaw)) {
      next.number = isArabic ? 'رقم البطاقة غير صالح' : 'Invalid card number';
    }
    if (!parseExpiry(expiry)) {
      next.expiry = isArabic ? 'تاريخ الانتهاء غير صالح' : 'Invalid expiry date';
    }
    if (!/^\d+$/.test(cvc) || cvc.length !== cvcLen) {
      next.cvc = isArabic
        ? `رمز CVV يجب أن يتكون من ${cvcLen} أرقام`
        : `CVC must be ${cvcLen} digits`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const finalizeAttach = async (tokenId: string) => {
    if (!merchantId) {
      throw new Error('Missing merchantId');
    }
    await paymentApi.attachSavedCard({ merchantId, token: tokenId });
  };

  const handleSave = async () => {
    if (submitting) return;
    if (!validate()) return;

    if (!moyasarPublishableKey) {
      Alert.alert(
        isArabic ? 'لم يُهيَّأ الدفع' : 'Payment not configured',
        isArabic
          ? 'لا يمكن حفظ البطاقات لهذا المتجر حالياً. تواصل مع فريق الدعم.'
          : 'This store cannot save cards yet. Please contact support.',
      );
      return;
    }
    if (!merchantId) {
      Alert.alert(
        isArabic ? 'خطأ' : 'Error',
        isArabic ? 'لم نتمكن من تحديد المتجر.' : 'Could not determine merchant.',
      );
      return;
    }

    const expParsed = parseExpiry(expiry)!;

    setSubmitting(true);
    try {
      const token: CreateTokenResponse = await createMoyasarToken({
        publishableKey: moyasarPublishableKey,
        name: name.trim(),
        number: cardNumberRaw,
        cvc,
        month: expParsed.month,
        year: expParsed.year,
      });

      // Some BINs require 3DS even for save-only tokens. Open the
      // verification URL in a webview; once it lands back on
      // sdk.moyasar.com/return the bank has approved the token.
      if (token.verification_url) {
        pendingTokenRef.current = token.id;
        setVerifyUrl(token.verification_url);
        return;
      }

      // No 3DS needed — verified out of the box.
      await finalizeAttach(token.id);
      onSavedSuccess();
    } catch (err: any) {
      const msg =
        err instanceof MoyasarTokenError
          ? err.message
          : err instanceof Error
            ? err.message
            : isArabic
              ? 'تعذر حفظ البطاقة.'
              : 'Could not save card.';
      Alert.alert(isArabic ? 'فشل حفظ البطاقة' : 'Card save failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onSavedSuccess = () => {
    Alert.alert(
      isArabic ? 'تم حفظ البطاقة' : 'Card saved',
      isArabic ? 'بطاقتك جاهزة للاستخدام عند الدفع.' : 'Your card is ready to use at checkout.',
      [{ text: 'OK', onPress: () => router.back() }],
    );
  };

  const onVerifyClose = () => {
    if (!submitting) {
      setVerifyUrl(null);
      pendingTokenRef.current = null;
    }
  };

  const onVerifyNavigationChange = async (url: string) => {
    if (!url) return;
    let parsedHost = '';
    try {
      // RN URL polyfill is loaded via expo's setup; fall back to
      // string check if URL parsing throws.
      parsedHost = new URL(url).hostname;
    } catch {
      parsedHost = url.includes(TOKEN_RETURN_HOSTNAME) ? TOKEN_RETURN_HOSTNAME : '';
    }
    if (parsedHost !== TOKEN_RETURN_HOSTNAME) return;
    const tokenId = pendingTokenRef.current;
    if (!tokenId) return;

    pendingTokenRef.current = null;
    setVerifyUrl(null);
    setSubmitting(true);
    try {
      await finalizeAttach(tokenId);
      onSavedSuccess();
    } catch (e: any) {
      Alert.alert(
        isArabic ? 'فشل التحقق' : 'Verification failed',
        e instanceof Error ? e.message : isArabic ? 'تعذر إكمال حفظ البطاقة.' : 'Could not finish saving the card.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Clear errors when the user fixes a field
  useEffect(() => {
    if (errors.name && name.trim().length >= 3) setErrors((e) => ({ ...e, name: undefined }));
  }, [name, errors.name]);
  useEffect(() => {
    if (errors.number && cardNumberRaw.length >= 12 && luhn(cardNumberRaw)) {
      setErrors((e) => ({ ...e, number: undefined }));
    }
  }, [cardNumberRaw, errors.number]);
  useEffect(() => {
    if (errors.expiry && parseExpiry(expiry)) setErrors((e) => ({ ...e, expiry: undefined }));
  }, [expiry, errors.expiry]);
  useEffect(() => {
    if (errors.cvc && /^\d+$/.test(cvc) && cvc.length === cvcLen) {
      setErrors((e) => ({ ...e, cvc: undefined }));
    }
  }, [cvc, cvcLen, errors.cvc]);

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={close} />
      <SwipeableBottomSheet
        onDismiss={close}
        height={modalHeight}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: 'white',
          borderTopLeftRadius: 40,
          borderTopRightRadius: 40,
          overflow: 'hidden',
          maxHeight: '90%',
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <View
            className="items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100"
            style={{ flexDirection: rowDirection }}
          >
            <Text className="text-xl font-bold text-slate-800">
              {isArabic ? 'إضافة بطاقة' : 'Add a Card'}
            </Text>
            <TouchableOpacity
              onPress={close}
              className="p-2"
              style={{ marginRight: isArabic ? 0 : -8, marginLeft: isArabic ? -8 : 0 }}
              disabled={submitting}
            >
              <X size={24} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView
            className="flex-1 px-6 py-6"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Card preview */}
            <View
              className="rounded-3xl p-5 mb-6"
              style={{ backgroundColor: primaryColor }}
            >
              <View
                className="items-center justify-between"
                style={{ flexDirection: rowDirection }}
              >
                <CreditCard size={28} color="white" />
                {brand ? (
                  <Text className="text-white font-bold text-sm">{brandLabel(brand, isArabic)}</Text>
                ) : null}
              </View>
              <Text className="text-white font-bold text-xl mt-6 tracking-widest" style={{ letterSpacing: 2 }}>
                {cardNumberFormatted || '•••• •••• •••• ••••'}
              </Text>
              <View
                className="justify-between mt-4"
                style={{ flexDirection: rowDirection }}
              >
                <View>
                  <Text className="text-white/60 text-[10px] uppercase tracking-widest">
                    {isArabic ? 'حامل البطاقة' : 'Cardholder'}
                  </Text>
                  <Text className="text-white font-bold text-sm" numberOfLines={1}>
                    {name || (isArabic ? 'الاسم الكامل' : 'Full Name')}
                  </Text>
                </View>
                <View>
                  <Text className="text-white/60 text-[10px] uppercase tracking-widest">
                    {isArabic ? 'تنتهي' : 'Expires'}
                  </Text>
                  <Text className="text-white font-bold text-sm">{expiry || 'MM/YY'}</Text>
                </View>
              </View>
            </View>

            {/* Cardholder name */}
            <View className="mb-4">
              <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>
                {isArabic ? 'اسم حامل البطاقة' : 'Cardholder Name'}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={isArabic ? 'كما هو ظاهر على البطاقة' : 'As shown on the card'}
                placeholderTextColor="#94a3b8"
                autoCapitalize="words"
                autoCorrect={false}
                className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium border border-slate-100"
                style={{
                  textAlign,
                  writingDirection: isArabic ? 'rtl' : 'ltr',
                }}
                editable={!submitting}
              />
              {errors.name ? (
                <Text className="text-red-500 text-xs mt-1" style={{ textAlign }}>{errors.name}</Text>
              ) : null}
            </View>

            {/* Card number */}
            <View className="mb-4">
              <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>
                {isArabic ? 'رقم البطاقة' : 'Card Number'}
              </Text>
              <TextInput
                value={cardNumberFormatted}
                onChangeText={(v) => setCardNumberRaw(v.replace(/\D/g, '').slice(0, 19))}
                placeholder="1234 5678 9012 3456"
                placeholderTextColor="#94a3b8"
                keyboardType="number-pad"
                className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium border border-slate-100"
                style={{
                  textAlign: 'left',
                  writingDirection: 'ltr',
                  fontVariant: ['tabular-nums'],
                }}
                maxLength={19 + 4} // 16-19 digits + up to 4 spaces
                editable={!submitting}
              />
              {errors.number ? (
                <Text className="text-red-500 text-xs mt-1" style={{ textAlign }}>{errors.number}</Text>
              ) : null}
            </View>

            {/* Expiry + CVC row */}
            <View className="gap-3" style={{ flexDirection: rowDirection }}>
              <View className="flex-1 mb-4">
                <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>
                  {isArabic ? 'تاريخ الانتهاء' : 'Expiry'}
                </Text>
                <TextInput
                  value={expiry}
                  onChangeText={(v) => setExpiry(formatExpiry(v))}
                  placeholder="MM/YY"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium border border-slate-100"
                  style={{ textAlign: 'left', writingDirection: 'ltr' }}
                  maxLength={5}
                  editable={!submitting}
                />
                {errors.expiry ? (
                  <Text className="text-red-500 text-xs mt-1" style={{ textAlign }}>{errors.expiry}</Text>
                ) : null}
              </View>
              <View className="flex-1 mb-4">
                <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>
                  CVC
                </Text>
                <TextInput
                  value={cvc}
                  onChangeText={(v) => setCvc(v.replace(/\D/g, '').slice(0, cvcLen))}
                  placeholder={cvcLen === 4 ? '••••' : '•••'}
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  secureTextEntry
                  className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium border border-slate-100"
                  style={{ textAlign: 'left', writingDirection: 'ltr' }}
                  maxLength={cvcLen}
                  editable={!submitting}
                />
                {errors.cvc ? (
                  <Text className="text-red-500 text-xs mt-1" style={{ textAlign }}>{errors.cvc}</Text>
                ) : null}
              </View>
            </View>

            {/* Save button */}
            <TouchableOpacity
              onPress={handleSave}
              disabled={submitting}
              className="rounded-2xl items-center justify-center py-4 mt-2"
              style={{ backgroundColor: primaryColor, opacity: submitting ? 0.6 : 1 }}
              activeOpacity={0.9}
            >
              {submitting ? (
                <ActivityIndicator color="white" />
              ) : (
                <View className="items-center" style={{ flexDirection: rowDirection }}>
                  <Lock size={18} color="white" />
                  <Text
                    className="text-white font-bold text-base"
                    style={{ marginLeft: isArabic ? 0 : 8, marginRight: isArabic ? 8 : 0 }}
                  >
                    {isArabic ? 'حفظ البطاقة' : 'Save Card'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>

            {/* PCI safety note */}
            <View
              className="items-center mt-5 px-3 py-2.5 bg-emerald-50 rounded-2xl"
              style={{ flexDirection: rowDirection }}
            >
              <ShieldCheck size={16} color="#10b981" />
              <Text
                className="text-emerald-700 text-xs flex-1"
                style={{
                  marginLeft: isArabic ? 0 : 8,
                  marginRight: isArabic ? 8 : 0,
                  textAlign,
                  lineHeight: 16,
                }}
              >
                {isArabic
                  ? 'بياناتك تُرسل مباشرة إلى Moyasar (PCI DSS) — لا نحفظ أرقام البطاقات على خوادمنا.'
                  : 'Card details go directly to Moyasar (PCI DSS). We never store raw card numbers on our servers.'}
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SwipeableBottomSheet>

      {/* 3DS verification webview (only when Moyasar requires it) */}
      <Modal visible={!!verifyUrl} animationType="slide" presentationStyle="pageSheet" onRequestClose={onVerifyClose}>
        <View className="flex-1 bg-white">
          <View
            className="items-center justify-between px-5 py-4 border-b border-slate-100"
            style={{ flexDirection: rowDirection }}
          >
            <Text className="text-lg font-bold text-slate-800">
              {isArabic ? 'تحقق البطاقة' : 'Card Verification'}
            </Text>
            <TouchableOpacity onPress={onVerifyClose} className="p-2" disabled={submitting}>
              <X size={24} color="#64748b" />
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
        </View>
      </Modal>
    </View>
  );
}
