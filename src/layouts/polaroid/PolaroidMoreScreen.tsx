/**
 * Polaroid more / settings screen.
 *
 * Layout (matches `.po-more-*` classes):
 *  - profile polaroid card at the top (user name + member code)
 *  - single column of small white polaroid cards, each one a
 *    settings row: mono caps label on the left, terracotta
 *    chevron block on the right
 *
 * All actions delegate to the existing modal routes — we don't
 * re-implement profile/contact/etc here.
 */
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  I18nManager,
  Platform,
  ScrollView,
  StatusBar,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useLanguageSwitch } from '../../context/LanguageSwitchContext';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { useProfile } from '../../context/ProfileContext';
import { MonoText, PolaroidCard } from './PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from './styles';

type Row = {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

export default function PolaroidMoreScreen() {
  const { i18n } = useTranslation();
  const router = useRouter();
  const isArabic = i18n.language === 'ar' || I18nManager.isRTL;
  const { profile } = useProfile();
  const { signOut } = useAuth();
  const { toggleLanguage } = useLanguageSwitch();
  const { layoutColors, appName, cafeName } = useMerchantBranding();
  const colors = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);

  const confirmLogout = () => {
    Alert.alert(
      isArabic ? 'تسجيل الخروج' : 'Log Out',
      isArabic ? 'هل أنت متأكد؟' : 'Are you sure you want to log out?',
      [
        { text: isArabic ? 'إلغاء' : 'Cancel', style: 'cancel' },
        {
          text: isArabic ? 'خروج' : 'Log Out',
          style: 'destructive',
          onPress: async () => {
            await signOut();
            router.replace('/(auth)/login');
          },
        },
      ],
    );
  };

  const rows: Row[] = [
    { key: 'profile', label: isArabic ? 'الملف الشخصي' : 'Profile', onPress: () => router.push('/profile-modal') },
    { key: 'addresses', label: isArabic ? 'العناوين' : 'Addresses', onPress: () => router.push('/address-modal') },
    { key: 'favorites', label: isArabic ? 'المفضلة' : 'Favorites', onPress: () => router.push('/favorites-modal') },
    { key: 'wallet', label: isArabic ? 'محفظتي' : 'My Wallet', onPress: () => router.push('/wallet-modal' as never) },
    { key: 'payment', label: isArabic ? 'طرق الدفع' : 'Payment Methods', onPress: () => router.push('/payment-modal') },
    { key: 'loyalty', label: isArabic ? 'الولاء' : 'Loyalty', onPress: () => router.push('/loyalty-modal' as never) },
    { key: 'language', label: isArabic ? 'English / اللغة' : 'العربية / Language', onPress: toggleLanguage },
    { key: 'contact', label: isArabic ? 'اتصل بنا' : 'Contact Us', onPress: () => router.push('/contact-modal') },
    { key: 'about', label: isArabic ? 'عن التطبيق' : 'About', onPress: () => router.push('/about-modal') },
    { key: 'privacy', label: isArabic ? 'سياسة الخصوصية' : 'Privacy', onPress: () => router.push('/privacy-modal') },
    { key: 'terms', label: isArabic ? 'الشروط' : 'Terms', onPress: () => router.push('/terms-modal') },
    { key: 'refund', label: isArabic ? 'سياسة الاسترجاع والإلغاء' : 'Refund & Cancellation', onPress: () => router.push('/refund-modal') },
    { key: 'logout', label: isArabic ? 'تسجيل الخروج' : 'Log Out', onPress: confirmLogout, destructive: true },
  ];

  const brandTitle = appName || cafeName || 'More';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />

      <ScrollView
        contentContainerStyle={{
          paddingTop: Platform.OS === 'ios' ? 58 : 36,
          paddingHorizontal: 18,
          paddingBottom: Platform.OS === 'ios' ? 130 : 110,
        }}
      >
        <MonoText
          size={22}
          tracking={-0.3}
          color={colors.text}
          style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}
        >
          {brandTitle}
        </MonoText>
        <MonoText
          size={9}
          tracking={1.8}
          uppercase
          color={`${colors.text}55`}
          style={{ marginTop: 2, marginBottom: 18 }}
        >
          {isArabic ? 'الإعدادات' : 'Settings'}
        </MonoText>

        {/* Profile polaroid */}
        <View style={{ marginBottom: 18 }}>
          <PolaroidCard
            rotation="-1.4deg"
            large
            style={{ padding: 18 }}
          >
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => router.push('/profile-modal')}
            >
              <MonoText
                size={9}
                tracking={2}
                uppercase
                weight="700"
                color={`${colors.textOnSurface}80`}
              >
                {isArabic ? 'الحساب' : 'Member'}
              </MonoText>
              <MonoText
                size={18}
                tracking={0.2}
                weight="800"
                color={colors.textOnSurface}
                style={{ marginTop: 6 }}
                numberOfLines={1}
              >
                {profile.fullName || (isArabic ? 'اسمك' : 'Your Name')}
              </MonoText>
              <MonoText
                size={11}
                tracking={0.3}
                color={`${colors.textOnSurface}77`}
                style={{ marginTop: 4 }}
                numberOfLines={1}
              >
                {profile.phone || '+966 5X XXX XXXX'}
              </MonoText>
            </TouchableOpacity>
          </PolaroidCard>
        </View>

        {/* Settings rows */}
        {rows.map((row, idx) => (
          <View key={row.key} style={{ marginBottom: 10 }}>
            <PolaroidCard
              rotation={rotationForIndex(idx + 2)}
              style={{ paddingVertical: 12, paddingHorizontal: 14 }}
            >
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={row.onPress}
                style={{ flexDirection: 'row', alignItems: 'center' }}
              >
                <MonoText
                  size={11}
                  tracking={1.5}
                  uppercase
                  weight="700"
                  color={row.destructive ? '#c8370a' : colors.textOnSurface}
                  style={{ flex: 1 }}
                  numberOfLines={1}
                >
                  {row.label}
                </MonoText>
                <View
                  style={{
                    width: 18,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: row.destructive ? '#c8370a' : colors.accent,
                    opacity: row.destructive ? 0.75 : 0.7,
                  }}
                />
              </TouchableOpacity>
            </PolaroidCard>
          </View>
        ))}

        <MonoText
          size={9}
          tracking={1.8}
          uppercase
          align="center"
          color={`${colors.text}33`}
          style={{ marginTop: 18 }}
        >
          v 1.0.0
        </MonoText>
      </ScrollView>
    </View>
  );
}
