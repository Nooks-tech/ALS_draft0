import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { Input } from '../../src/components/common/Input';
import { authApi } from '../../src/api/auth';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useAuth } from '../../src/context/AuthContext';
import { useMerchant } from '../../src/context/MerchantContext';

export default function OtpScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { setServerSession } = useAuth();
  const { merchantId } = useMerchant();
  const isArabic = i18n.language === 'ar';
  const copy = isArabic
    ? {
        error: 'خطأ',
        invalidCodeTitle: 'رمز غير صحيح',
        configMissing: 'تعذر تحديد المتجر لهذا التطبيق. يرجى إعادة تشغيل التطبيق أو التواصل مع الدعم.',
        couldNotSend: 'تعذر إرسال الرمز.',
        invalidCodeBody: 'يرجى إدخال رمز التحقق المكون من 6 أرقام.',
        phoneMissing: 'رقم الجوال مفقود. يرجى العودة والمحاولة مرة أخرى.',
        codeExpired: 'الرمز غير صحيح أو منتهي الصلاحية. حاول مرة أخرى.',
        title: 'تحقق من رقم الجوال',
        yourPhone: 'رقم جوالك',
        enterBelow: 'أدخله بالأسفل للمتابعة.',
        verificationCode: 'رمز التحقق',
        verifyContinue: 'تأكيد ومتابعة',
        didntReceive: 'لم يصلك الرمز؟',
        resendIn: 'إعادة الإرسال خلال',
        resendCode: 'إعادة إرسال الرمز',
      }
    : {
        error: 'Error',
        invalidCodeTitle: 'Invalid Code',
        configMissing: 'This app is missing its merchant configuration. Please restart the app or contact support.',
        couldNotSend: 'Could not send code.',
        invalidCodeBody: 'Please enter the 6-digit code from your SMS.',
        phoneMissing: 'Phone number is missing. Please go back and try again.',
        codeExpired: 'Code is wrong or expired. Try again.',
        title: 'Verify your phone',
        yourPhone: 'your phone',
        enterBelow: 'Enter it below to continue.',
        verificationCode: 'Verification Code',
        verifyContinue: 'Verify & Continue',
        didntReceive: "Didn't receive the code?",
        resendIn: 'Resend in',
        resendCode: 'Resend Code',
      };

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [timer, setTimer] = useState(60);

  const resendOtp = useCallback(async () => {
    if (!phone?.trim()) return;
    if (!merchantId) {
      Alert.alert(copy.error, copy.configMissing);
      return;
    }
    setSending(true);
    try {
      await authApi.sendOtp(phone, merchantId);
      setTimer(60);
    } catch (err) {
      Alert.alert(copy.error, err instanceof Error ? err.message : copy.couldNotSend);
    } finally {
      setSending(false);
    }
  }, [merchantId, phone, copy.configMissing, copy.couldNotSend, copy.error]);

  useEffect(() => {
    const interval = setInterval(() => setTimer((prev) => (prev > 0 ? prev - 1 : 0)), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleVerify = async () => {
    const c = code.replace(/\D/g, '');
    if (c.length !== 6) {
      Alert.alert(copy.invalidCodeTitle, copy.invalidCodeBody);
      return;
    }
    if (!phone?.trim()) {
      Alert.alert(copy.error, copy.phoneMissing);
      return;
    }
    setLoading(true);
    try {
      const result = await authApi.verifyOtp(phone, c);
      const { error } = await setServerSession(
        result.session.access_token,
        result.session.refresh_token,
      );
      if (error) {
        Alert.alert(copy.error, error);
        return;
      }
      router.replace('/(tabs)/menu');
    } catch (err) {
      Alert.alert(copy.invalidCodeTitle, err instanceof Error ? err.message : copy.codeExpired);
    } finally {
      setLoading(false);
    }
  };

  const maskedPhone = phone
    ? phone.replace(/(\+966)(\d{2})(\d+)(\d{2})/, '$1 $2***$4')
    : '';

  return (
    <Container className="justify-center">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-center">
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
          <View className="mb-8">
            <Text className="text-3xl font-bold text-gray-900 mb-2" style={{ textAlign: isArabic ? 'right' : 'left' }}>
              {copy.title}
            </Text>
            <Text className="text-gray-500 text-base" style={{ textAlign: isArabic ? 'right' : 'left' }}>
              {isArabic ? 'أرسلنا رمزًا مكونًا من 6 أرقام إلى ' : 'We sent a 6-digit code to '}
              {maskedPhone || copy.yourPhone}.
              {'\n'}
              {copy.enterBelow}
            </Text>
          </View>

          <View className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
            <Input
              label={copy.verificationCode}
              placeholder="000000"
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              className="text-center text-2xl tracking-widest font-bold"
            />

            <Button
              title={copy.verifyContinue}
              onPress={handleVerify}
              isLoading={loading}
              className="mt-4"
            />
          </View>

          <View className="mt-8 items-center">
            <Text className="text-gray-500 mb-2">{copy.didntReceive}</Text>
            {timer > 0 ? (
              <Text className="text-gray-400 font-bold">{isArabic ? `${copy.resendIn} ${timer}ث` : `${copy.resendIn} ${timer}s`}</Text>
            ) : (
              <TouchableOpacity onPress={resendOtp} disabled={sending}>
                <Text className="font-bold text-lg" style={{ color: primaryColor }}>{copy.resendCode}</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}
