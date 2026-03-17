import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { authApi } from '../../src/api/auth';
import { useAuth } from '../../src/context/AuthContext';
import { PHONE_PREFIX, ensurePrefix } from '../../src/utils/phone';

// ─── SMS_VERIFICATION_DISABLED ───────────────────────────────────────────────
// To re-enable: set SMS_DISABLED = false
// The server must also have BYPASS_SMS=false (or the env var removed)
const SMS_DISABLED = true;
// ─────────────────────────────────────────────────────────────────────────────

export default function LoginScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { setServerSession } = useAuth();

  const [digits, setDigits] = useState('');
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    const phone = ensurePrefix(digits);
    if (!phone || digits.replace(/\D/g, '').length < 9) {
      Alert.alert(t('error') || 'Error', 'Please enter a valid Saudi phone number.');
      return;
    }
    setLoading(true);
    try {
      if (SMS_DISABLED) {
        // Bypass: skip OTP screen, sign in directly via server bypass
        const result = await authApi.verifyOtp(phone, 'BYPASS');
        const { error } = await setServerSession(
          result.session.access_token,
          result.session.refresh_token,
        );
        if (error) { Alert.alert(t('error') || 'Error', error); return; }
        router.replace('/(tabs)/menu');
      } else {
        await authApi.sendOtp(phone);
        router.push({ pathname: '/(auth)/otp', params: { phone } });
      }
    } catch (err) {
      Alert.alert(t('error') || 'Error', err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container className="justify-center">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="items-center mb-8">
            <View className="w-24 h-24 bg-red-100 rounded-full justify-center items-center mb-4">
              <Text className="text-4xl">☕</Text>
            </View>
            <Text className="text-3xl font-bold text-gray-900">{t('welcome')}</Text>
            <Text className="text-gray-500 mt-2 text-center">
              Enter your phone number to get started
            </Text>
          </View>

          <View className="w-full mb-4">
            <Text className="text-gray-700 mb-2 font-medium text-start">Phone Number</Text>
            <View className="flex-row items-center min-h-12 border rounded-xl border-gray-200 bg-gray-50 px-4 py-2">
              <Text className="text-gray-700 font-medium">{PHONE_PREFIX} </Text>
              <TextInput
                placeholder="5XX XXX XXXX"
                placeholderTextColor="#9CA3AF"
                value={digits}
                onChangeText={(t) => setDigits(t.replace(/\D/g, '').slice(0, 9))}
                keyboardType="phone-pad"
                autoFocus
                className="flex-1 py-2 px-2 text-base text-gray-900 font-medium"
              />
            </View>
          </View>

          <Button
            title="Continue"
            onPress={handleContinue}
            isLoading={loading}
            className="mt-4"
          />

          <View className="flex-row justify-center mt-6">
            <Text className="text-gray-600 text-center">
              We'll send you a verification code via SMS
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}
