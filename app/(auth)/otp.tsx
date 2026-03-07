import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { Input } from '../../src/components/common/Input';
import { authApi } from '../../src/api/auth';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useAuth } from '../../src/context/AuthContext';

export default function OtpScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const { t } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { setServerSession } = useAuth();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [timer, setTimer] = useState(60);

  const resendOtp = useCallback(async () => {
    if (!phone?.trim()) return;
    setSending(true);
    try {
      await authApi.sendOtp(phone);
      setTimer(60);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not send code.');
    } finally {
      setSending(false);
    }
  }, [phone]);

  useEffect(() => {
    const interval = setInterval(() => setTimer((prev) => (prev > 0 ? prev - 1 : 0)), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleVerify = async () => {
    const c = code.replace(/\D/g, '');
    if (c.length !== 6) {
      Alert.alert('Invalid Code', 'Please enter the 6-digit code from your SMS.');
      return;
    }
    if (!phone?.trim()) {
      Alert.alert('Error', 'Phone number is missing. Please go back and try again.');
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
        Alert.alert('Error', error);
        return;
      }
      router.replace('/(tabs)/menu');
    } catch (err) {
      Alert.alert('Invalid Code', err instanceof Error ? err.message : 'Code is wrong or expired. Try again.');
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
            <Text className="text-3xl font-bold text-gray-900 mb-2">
              {t('otp') || 'Verify your phone'}
            </Text>
            <Text className="text-gray-500 text-base">
              We sent a 6-digit code to {maskedPhone || 'your phone'}.
              {'\n'}Enter it below to continue.
            </Text>
          </View>

          <View className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
            <Input
              label="Verification Code"
              placeholder="000000"
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              className="text-center text-2xl tracking-widest font-bold"
            />

            <Button
              title="Verify & Continue"
              onPress={handleVerify}
              isLoading={loading}
              className="mt-4"
            />
          </View>

          <View className="mt-8 items-center">
            <Text className="text-gray-500 mb-2">Didn't receive the code?</Text>
            {timer > 0 ? (
              <Text className="text-gray-400 font-bold">Resend in {timer}s</Text>
            ) : (
              <TouchableOpacity onPress={resendOtp} disabled={sending}>
                <Text className="font-bold text-lg" style={{ color: primaryColor }}>Resend Code</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}
