import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { Input } from '../../src/components/common/Input';
import { useAuth } from '../../src/context/AuthContext';

export default function LoginScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, signIn, signUp } = useAuth();

  const [email, setEmail] = useState('');

  useEffect(() => {
    if (user) {
      // User is signed in - stay here so we can send OTP and navigate to OTP screen
      // (handled in handleContinue)
    }
  }, [user]);

  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      Alert.alert('Error', 'Please enter email and password.');
      return;
    }
    setLoading(true);
    let error: string | null = null;
    error = (await signIn(trimmedEmail, password)).error;
    if (error) {
      const signUpResult = await signUp(trimmedEmail, password);
      error = signUpResult.error;
    }
    setLoading(false);
    if (error) {
      Alert.alert('Error', error);
      return;
    }
    router.replace({ pathname: '/(auth)/otp', params: { email: trimmedEmail.toLowerCase() } });
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
      {/* 1. Logo / Header Area */}
      <View className="items-center mb-8">
        <View className="w-24 h-24 bg-red-100 rounded-full justify-center items-center mb-4">
          <Text className="text-4xl">🍔</Text>
        </View>
        <Text className="text-3xl font-bold text-gray-900">{t('welcome')}</Text>
        <Text className="text-gray-500 mt-2 text-center">
          Sign in to access your exclusive offers
        </Text>
      </View>

      {/* 2. Form Area */}
      <View className="w-full space-y-4">
        <Input 
          label="Email"
          placeholder="user@example.com"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        
        <Input 
          label="Password"
          placeholder="••••••••"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <Button 
          title="Continue" 
          onPress={handleContinue} 
          isLoading={loading}
          className="mt-4"
        />
      </View>

      {/* 3. Footer */}
      <View className="flex-row justify-center mt-6">
        <Text className="text-gray-600 text-center">Enter your email and password to continue</Text>
      </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}