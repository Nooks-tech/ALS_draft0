import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { Input } from '../../src/components/common/Input';
import { useAuth } from '../../src/context/AuthContext';

export default function RegisterScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { signUp } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      Alert.alert('Error', 'Please enter email and password.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    const { error } = await signUp(trimmedEmail, password);
    setLoading(false);
    if (error) {
      Alert.alert('Sign Up Failed', error);
      return;
    }
    router.replace('/(auth)/complete-profile');
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
              <Text className="text-4xl">🍔</Text>
            </View>
            <Text className="text-3xl font-bold text-gray-900">Create account</Text>
            <Text className="text-gray-500 mt-2 text-center">
              Sign up to access your exclusive offers
            </Text>
          </View>

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
              title="Sign Up"
              onPress={handleRegister}
              isLoading={loading}
              className="mt-4"
            />
          </View>

          <View className="flex-row justify-center mt-6">
            <Text className="text-gray-600">Already have an account? </Text>
            <TouchableOpacity onPress={() => router.back()}>
              <Text className="text-primary font-bold">Sign In</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}
