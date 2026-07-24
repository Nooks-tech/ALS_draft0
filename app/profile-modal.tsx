import { useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, Mail, Phone, User } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/context/AuthContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useProfile } from '../src/context/ProfileContext';
import { ensurePrefix, PHONE_PREFIX, stripPrefix } from '../src/utils/phone';

export default function ProfileModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const { primaryColor } = useMerchantBranding();
  const { profile, updateProfile, saveProfile } = useProfile();
  const isArabic = i18n.language === 'ar';
  const rowDirection: 'row' | 'row-reverse' = isArabic ? 'row-reverse' : 'row';
  const textAlign: 'left' | 'right' = isArabic ? 'right' : 'left';
  const BackIcon = isArabic ? ArrowRight : ArrowLeft;
  const [fullName, setFullName] = useState(profile.fullName);
  const [digits, setDigits] = useState(() => stripPrefix(profile.phone));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFullName(profile.fullName);
    setDigits(stripPrefix(profile.phone));
  }, [profile.fullName, profile.phone]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const phoneValue = ensurePrefix(digits);
      const data = { fullName, phone: phoneValue };
      updateProfile(data);
      await saveProfile(data);
      Alert.alert(isArabic ? 'تم الحفظ' : 'Saved', isArabic ? 'تم تحديث ملفك الشخصي.' : 'Your profile has been updated.');
      router.back();
    } catch (e) {
      Alert.alert(isArabic ? 'خطأ' : 'Error', e instanceof Error ? e.message : (isArabic ? 'تعذر الحفظ.' : 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Header */}
        <View
          className="items-center px-5 py-4 border-b border-slate-100"
          style={{ flexDirection: 'row' }}
        >
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginStart: -8 }}
          >
            <BackIcon size={24} color="#334155" />
          </TouchableOpacity>
          <Text className="flex-1 text-center text-xl font-bold text-slate-800">{isArabic ? 'الملف الشخصي' : 'Profile Info'}</Text>
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
            <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>{isArabic ? 'الاسم الكامل' : 'Full Name'}</Text>
            <View className="items-center bg-slate-50 rounded-2xl px-4" style={{ flexDirection: 'row' }}>
              <User size={20} color="#94a3b8" />
              <TextInput
                placeholder={isArabic ? 'أدخل اسمك الكامل' : 'Enter your full name'}
                placeholderTextColor="#64748b"
                value={fullName}
                onChangeText={setFullName}
                className="flex-1 py-3 text-slate-800 font-medium"
                style={{ marginStart: 12, textAlign, writingDirection: isArabic ? 'rtl' : 'ltr' }}
              />
            </View>
          </View>
          <View className="mb-4">
            <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>{isArabic ? 'رقم الجوال' : 'Phone Number'}</Text>
            <View className="items-center bg-slate-50 rounded-2xl px-4" style={{ minHeight: 52, flexDirection: 'row' }}>
              <Phone size={20} color="#94a3b8" />
              <View className="flex-1" style={{ height: 52, alignItems: 'center', flexDirection: 'row', marginStart: 12 }}>
                <View style={{ justifyContent: 'center', paddingTop: 2 }}>
                  <Text className="text-slate-600 font-medium text-base" style={{ lineHeight: 20, fontSize: 16 }}>{PHONE_PREFIX} </Text>
                </View>
                <TextInput
                  placeholder="5XX XXX XXXX"
                  placeholderTextColor="#64748b"
                  value={digits}
                  onChangeText={(t) => setDigits(t.replace(/\D/g, '').slice(0, 9))}
                  className="flex-1 text-slate-800 font-medium"
                  style={{
                    paddingVertical: 0,
                    paddingHorizontal: 8,
                    height: 52,
                    fontSize: 16,
                    lineHeight: 20,
                    textAlign: 'left',
                    writingDirection: 'ltr',
                    ...(Platform.OS === 'android' && { textAlignVertical: 'center' as const }) }}
                  keyboardType="phone-pad"
                  includeFontPadding={false}
                />
              </View>
            </View>
          </View>
          {user?.email && !user.email.endsWith('@phone.nooks.app') && (
            <View className="mb-4">
              <Text className="text-slate-500 text-sm font-bold mb-2" style={{ textAlign }}>{isArabic ? 'البريد الإلكتروني' : 'Email'}</Text>
              <View className="items-center bg-slate-50 rounded-2xl px-4 py-3" style={{ flexDirection: 'row' }}>
                <Mail size={20} color="#94a3b8" />
                <Text className="flex-1 text-slate-600 font-medium" style={{ marginStart: 12, textAlign }}>
                  {user.email}
                </Text>
              </View>
              <Text className="text-slate-400 text-xs mt-1" style={{ textAlign }}>{isArabic ? 'البريد الإلكتروني مرتبط بحسابك ولا يمكن تغييره من هنا' : 'Email is from your account and cannot be changed here'}</Text>
            </View>
          )}
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={{ backgroundColor: primaryColor }}
            className="py-4 rounded-2xl items-center mb-8"
          >
            <Text className="text-white font-bold text-lg">{saving ? (isArabic ? 'جارٍ الحفظ...' : 'Saving...') : (isArabic ? 'حفظ التغييرات' : 'Save Changes')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
