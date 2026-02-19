import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { useAuth } from '../../src/context/AuthContext';
import { useProfile } from '../../src/context/ProfileContext';
import { ensurePrefix, PHONE_PREFIX, stripPrefix } from '../../src/utils/phone';

export default function CompleteProfileScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { profile, saveProfile, refetchProfile } = useProfile();
  const [digits, setDigits] = useState(() => stripPrefix(profile?.phone));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (profile?.phone?.trim()) {
      router.replace('/(tabs)/menu');
    }
  }, [profile?.phone, router]);

  useEffect(() => {
    setDigits(stripPrefix(profile?.phone));
  }, [profile?.phone]);

  const handleSave = async () => {
    const phoneValue = ensurePrefix(digits);
    if (!phoneValue) {
      Alert.alert('Required', 'Please enter your phone number.');
      return;
    }
    setLoading(true);
    try {
      await saveProfile({ phone: phoneValue });
      await refetchProfile();
      router.replace('/(tabs)/menu');
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not save. Try again.');
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
              <Text className="text-4xl">📱</Text>
            </View>
            <Text className="text-3xl font-bold text-gray-900">Almost there!</Text>
            <Text className="text-gray-500 mt-2 text-center">
              Add your phone number so we can reach you for your order
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
                className="flex-1 py-2 px-2 text-base text-gray-900 font-medium"
              />
            </View>
          </View>
          <Button
            title="Continue"
            onPress={handleSave}
            isLoading={loading}
            className="mt-4"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}
