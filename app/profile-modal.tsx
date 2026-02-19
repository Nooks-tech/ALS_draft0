import DateTimePicker from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import { ArrowLeft, Calendar, Mail, Phone, Trash2, User } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/context/AuthContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useProfile } from '../src/context/ProfileContext';
import { ensurePrefix, PHONE_PREFIX, stripPrefix } from '../src/utils/phone';

const toDate = (s: string): Date => {
  if (!s) return new Date(2000, 0, 1);
  const [y, m, d] = s.split('-').map(Number);
  if (y && m && d) return new Date(y, m - 1, d);
  return new Date(2000, 0, 1);
};
const toYYYYMMDD = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export default function ProfileModal() {
  const router = useRouter();
  const { user } = useAuth();
  const { primaryColor } = useMerchantBranding();
  const { profile, updateProfile, saveProfile, clearProfile } = useProfile();
  const [fullName, setFullName] = useState(profile.fullName);
  const [digits, setDigits] = useState(() => stripPrefix(profile.phone));
  const [dateOfBirth, setDateOfBirth] = useState(profile.dateOfBirth);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFullName(profile.fullName);
    setDigits(stripPrefix(profile.phone));
    setDateOfBirth(profile.dateOfBirth);
  }, [profile.fullName, profile.phone, profile.dateOfBirth]);

  const onDateChange = (event: any, date?: Date) => {
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (event?.type === 'dismissed') return;
    if (date) setDateOfBirth(toYYYYMMDD(date));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const phoneValue = ensurePrefix(digits);
      const data = { fullName, phone: phoneValue, dateOfBirth };
      updateProfile(data);
      await saveProfile(data);
      Alert.alert('Saved', 'Your profile has been updated.');
      router.back();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? This will remove all your profile data, saved addresses, and favorites. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await clearProfile();
            router.replace('/(tabs)/more');
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Header */}
        <View className="flex-row items-center px-5 py-4 border-b border-slate-100">
          <TouchableOpacity onPress={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft size={24} color="#334155" />
          </TouchableOpacity>
          <Text className="flex-1 text-center text-xl font-bold text-slate-800">Profile Info</Text>
          <View className="w-10" />
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="items-center mb-8">
            <View className="w-24 h-24 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <User size={40} color={primaryColor} />
            </View>
          </View>
          <View className="mb-4">
            <Text className="text-slate-500 text-sm font-bold mb-2">Full Name</Text>
            <View className="flex-row items-center bg-slate-50 rounded-2xl px-4">
              <User size={20} color="#94a3b8" />
              <TextInput
                placeholder="Enter your full name"
                value={fullName}
                onChangeText={setFullName}
                className="flex-1 py-3 ml-3 text-slate-800 font-medium"
              />
            </View>
          </View>
          <View className="mb-4">
            <Text className="text-slate-500 text-sm font-bold mb-2">Phone Number</Text>
            <View className="flex-row items-center bg-slate-50 rounded-2xl px-4 py-2">
              <Phone size={20} color="#94a3b8" />
              <Text className="ml-3 text-slate-600 font-medium">{PHONE_PREFIX} </Text>
              <TextInput
                placeholder="5XX XXX XXXX"
                placeholderTextColor="#94a3b8"
                value={digits}
                onChangeText={(t) => setDigits(t.replace(/\D/g, '').slice(0, 9))}
                className="flex-1 py-3 px-2 text-base text-slate-800 font-medium"
                keyboardType="phone-pad"
              />
            </View>
          </View>
          <View className="mb-4">
            <Text className="text-slate-500 text-sm font-bold mb-2">Email</Text>
            <View className="flex-row items-center bg-slate-50 rounded-2xl px-4 py-3">
              <Mail size={20} color="#94a3b8" />
              <Text className="flex-1 ml-3 text-slate-600 font-medium">
                {user?.email || '—'}
              </Text>
            </View>
            <Text className="text-slate-400 text-xs mt-1">Email is from your account and cannot be changed here</Text>
          </View>
          <View className="mb-6">
            <Text className="text-slate-500 text-sm font-bold mb-2">Date of Birth</Text>
            <TouchableOpacity
              onPress={() => {
                Keyboard.dismiss();
                setShowDatePicker(true);
              }}
              className="flex-row items-center bg-slate-50 rounded-2xl px-4 py-3"
            >
              <Calendar size={20} color="#94a3b8" />
              <Text className={`flex-1 ml-3 ${dateOfBirth ? 'text-slate-800 font-medium' : 'text-slate-400'}`}>
                {dateOfBirth || 'Tap to select date'}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={{ backgroundColor: primaryColor }}
            className="py-4 rounded-2xl items-center mb-8"
          >
            <Text className="text-white font-bold text-lg">{saving ? 'Saving...' : 'Save Changes'}</Text>
          </TouchableOpacity>

          {/* Delete Account */}
          <TouchableOpacity
            onPress={handleDeleteAccount}
            className="flex-row items-center justify-center py-4 border-t border-slate-200"
          >
            <Trash2 size={20} color="#ef4444" />
            <Text className="text-red-500 font-bold ml-2">Delete Account</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Date picker overlay */}
      {showDatePicker && (
        <View className="absolute inset-0 bg-black/60" style={{ zIndex: 999, elevation: 999 }}>
          <TouchableOpacity className="flex-1" activeOpacity={1} onPress={() => setShowDatePicker(false)} />
          <View className="bg-white rounded-t-[24px] p-6 pb-10">
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-lg font-bold text-slate-800">Select date</Text>
              <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                <Text className="font-bold text-lg" style={{ color: primaryColor }}>Done</Text>
              </TouchableOpacity>
            </View>
            <View className="rounded-2xl overflow-hidden border border-slate-100 bg-slate-50">
              <DateTimePicker
                value={toDate(dateOfBirth)}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={onDateChange}
                maximumDate={new Date()}
                themeVariant="light"
                accentColor={primaryColor}
              />
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}
