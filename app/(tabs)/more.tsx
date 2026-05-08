import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Bell,
  ChevronRight,
  CreditCard,
  Download,
  FileText,
  Globe,
  Heart,
  Info,
  LogOut,
  Mail,
  MapPin,
  Megaphone,
  Receipt,
  RotateCcw,
  Shield,
  Star,
  User,
  Wallet } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../src/context/AuthContext';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { unregisterPushToken } from '../../src/api/push';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useProfile } from '../../src/context/ProfileContext';
import { useCallback, useEffect, useState } from 'react';
import { walletApi } from '../../src/api/wallet';
import { Alert, Linking, Platform, SafeAreaView, ScrollView, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import { useLanguageSwitch } from '../../src/context/LanguageSwitchContext';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { API_URL } from '../../src/api/config';
import { supabase } from '../../src/api/supabase';

export default function MoreScreen() {
  const { i18n } = useTranslation();
  const router = useRouter();
  const { primaryColor, backgroundColor, menuCardColor, textColor, appName, cafeName, logoUrl, appIconUrl } = useMerchantBranding();
  const { profile } = useProfile();
  const { signOut, user } = useAuth();
  const { merchantId } = useMerchant();
  const isArabic = i18n.language === 'ar';

  // Marketing push consent toggle. Mirrors push_subscriptions.marketing_opt_in
  // on the server; we load it on mount and PATCH it back through the
  // push/register endpoint (which accepts the flag).
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [marketingBusy, setMarketingBusy] = useState(false);
  const [dataDownloading, setDataDownloading] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  // Wallet balance shown inline on the "My Wallet" row so the
  // customer doesn't have to drill in to know how much credit they
  // have. Refreshed on focus so a top-up done in /wallet-modal lands
  // here as soon as the user pops back to More.
  const [walletBalanceSar, setWalletBalanceSar] = useState<number | null>(null);
  const loadWalletBalance = useCallback(async () => {
    if (!user?.id || !merchantId) {
      setWalletBalanceSar(null);
      return;
    }
    try {
      const balance = await walletApi.getBalance(merchantId);
      setWalletBalanceSar(balance.balance_sar);
    } catch {
      // Best-effort — keep the prior value rather than flipping the
      // visible balance to null on a transient network error.
    }
  }, [user?.id, merchantId]);
  useEffect(() => { void loadWalletBalance(); }, [loadWalletBalance]);
  useFocusEffect(useCallback(() => { void loadWalletBalance(); }, [loadWalletBalance]));
  useEffect(() => {
    if (!user?.id || !merchantId || !supabase) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('push_subscriptions')
          .select('marketing_opt_in')
          .eq('user_id', user.id)
          .eq('merchant_id', merchantId)
          .limit(1)
          .maybeSingle();
        if (!cancelled) setMarketingOptIn(Boolean(data?.marketing_opt_in));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [user?.id, merchantId]);

  const toggleMarketingConsent = async (next: boolean) => {
    if (!user?.id || !merchantId || !supabase) return;
    setMarketingBusy(true);
    setMarketingOptIn(next);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session?.access_token) {
        setMarketingOptIn(!next);
        return;
      }
      // Grab the push token just to echo it back — required by the
      // upsert key — but the flag is what we're actually updating.
      const nonInteractive = await supabase
        .from('push_subscriptions')
        .select('expo_push_token, platform, app_language')
        .eq('user_id', user.id)
        .eq('merchant_id', merchantId)
        .limit(1)
        .maybeSingle();
      const existing = nonInteractive.data;
      if (!existing?.expo_push_token) {
        // No registered token yet — flip will take effect next registration.
        setMarketingBusy(false);
        return;
      }
      const base = (process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL || '').replace(/\/$/, '');
      if (!base) {
        setMarketingBusy(false);
        return;
      }
      await fetch(`${base}/api/public/merchants/${encodeURIComponent(merchantId)}/push/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          customerId: user.id,
          token: existing.expo_push_token,
          platform: existing.platform ?? Platform.OS,
          appLanguage: existing.app_language ?? (isArabic ? 'ar' : 'en'),
          marketingOptIn: next }) });
    } catch (e) {
      setMarketingOptIn(!next);
      Alert.alert(isArabic ? 'خطأ' : 'Error', isArabic ? 'ما قدرنا نحفظ التفضيل.' : "Couldn't save preference.");
    } finally {
      setMarketingBusy(false);
    }
  };

  const downloadMyData = async () => {
    if (dataDownloading) return;
    setDataDownloading(true);
    try {
      const session = (await supabase?.auth.getSession())?.data?.session;
      if (!session?.access_token) {
        Alert.alert(isArabic ? 'خطأ' : 'Error', isArabic ? 'سجّل دخول من جديد.' : 'Please sign in again.');
        return;
      }
      const res = await fetch(`${API_URL}/api/account/export?merchantId=${encodeURIComponent(merchantId ?? '')}`, {
        headers: { Authorization: `Bearer ${session.access_token}` } });
      if (!res.ok) throw new Error('Export failed');
      const text = await res.text();
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!dir) throw new Error('No writable cache directory');
      const path = `${dir}nooks-my-data-${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(path, text);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: 'application/json',
          dialogTitle: isArabic ? 'بياناتي' : 'My data' });
      } else {
        Alert.alert(
          isArabic ? 'تم التصدير' : 'Export ready',
          isArabic ? `تم حفظ الملف في: ${path}` : `Saved to: ${path}`,
        );
      }
    } catch (e) {
      Alert.alert(
        isArabic ? 'فشل التصدير' : 'Export failed',
        isArabic ? 'حاول بعد شوي.' : 'Please try again in a moment.',
      );
    } finally {
      setDataDownloading(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      isArabic ? 'حذف الحساب نهائياً؟' : 'Delete account permanently?',
      isArabic
        ? 'بنمسح ملفك الشخصي، عناوينك، ونقاط الولاء. الطلبات السابقة بتنجهّل. ما في رجوع بعد التأكيد.'
        : "We'll erase your profile, saved addresses, and loyalty balances. Past orders will be anonymised. This can't be undone.",
      [
        { text: isArabic ? 'لا' : 'Cancel', style: 'cancel' },
        {
          text: isArabic ? 'احذف' : 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingAccount(true);
            try {
              const session = (await supabase?.auth.getSession())?.data?.session;
              if (!session?.access_token) throw new Error('No session');
              const res = await fetch(`${API_URL}/api/account`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${session.access_token}` } });
              if (!res.ok) throw new Error('Delete failed');
              await signOut();
              router.replace('/(auth)/login');
            } catch {
              Alert.alert(
                isArabic ? 'فشل الحذف' : 'Delete failed',
                isArabic ? 'حاول مرة ثانية.' : 'Please try again.',
              );
            } finally {
              setDeletingAccount(false);
            }
          } },
      ],
    );
  };
  const copy = isArabic
    ? {
        error: 'خطأ',
        changeLanguageFailed: 'تعذر تغيير اللغة.',
        logoutTitle: 'تسجيل الخروج',
        logoutConfirm: 'هل أنت متأكد أنك تريد تسجيل الخروج؟',
        cancel: 'إلغاء',
        yourName: 'اسمك',
        account: 'الحساب',
        profileInfo: 'الملف الشخصي',
        editDetails: 'تعديل بياناتك',
        myAddresses: 'عناويني',
        manageLocations: 'إدارة مواقع التوصيل',
        receipts: 'إيصالاتي',
        receiptsSubtitle: 'سجل جميع طلباتك',
        notifications: 'الإشعارات',
        offersUpdates: 'العروض والتحديثات',
        favorites: 'المفضلة',
        savedItems: 'العناصر المحفوظة',
        preferences: 'التفضيلات',
        paymentMethod: 'طرق الدفع',
        cardsOptions: 'البطاقات وخيارات الدفع',
        loyaltyPoints: 'نقاط الولاء',
        rewards: 'اكسب واستبدل المكافآت',
        appSettings: 'إعدادات التطبيق',
        english: 'الإنجليزية',
        supportLegal: 'الدعم والقانونية',
        support: 'الدعم',
        getHelp: 'احصل على المساعدة',
        contactUs: 'اتصل بنا',
        reachOut: 'تواصل معنا',
        about: 'عن التطبيق',
        learnAbout: `تعرف على ${appName || cafeName || 'التطبيق'}`,
        privacyPolicy: 'سياسة الخصوصية',
        terms: 'الشروط والأحكام',
        refund: 'سياسة الاسترجاع والإلغاء',
        logOut: 'تسجيل الخروج',
        version: 'الإصدار 1.0.0' }
    : {
        error: 'Error',
        changeLanguageFailed: 'Could not change language.',
        logoutTitle: 'Log Out',
        logoutConfirm: 'Are you sure you want to log out?',
        cancel: 'Cancel',
        yourName: 'Your Name',
        account: 'Account',
        profileInfo: 'Profile Info',
        editDetails: 'Edit your details',
        myAddresses: 'My Addresses',
        manageLocations: 'Manage delivery locations',
        receipts: 'My Receipts',
        receiptsSubtitle: 'History of all your orders',
        notifications: 'Notifications',
        offersUpdates: 'Offers & Updates',
        favorites: 'Favorites',
        savedItems: 'Your saved items',
        preferences: 'Preferences',
        paymentMethod: 'Payment Method',
        cardsOptions: 'Cards & payment options',
        loyaltyPoints: 'Loyalty Points',
        rewards: 'Earn & redeem rewards',
        appSettings: 'App Settings',
        english: 'English',
        supportLegal: 'Support & Legal',
        support: 'Support',
        getHelp: 'Get help',
        contactUs: 'Contact Us',
        reachOut: 'Reach out to us',
        about: 'About',
        learnAbout: `Learn about ${appName || cafeName || 'the app'}`,
        privacyPolicy: 'Privacy Policy',
        terms: 'Terms & Conditions',
        refund: 'Refund & Cancellation',
        logOut: 'Log Out',
        version: 'Version 1.0.0' };

  // Language toggle now goes through the LanguageSwitchProvider
  // context (see _layout.tsx). The context owns the AppSplash
  // visibility, the routed-tree remount key, and the i18n / RTL
  // flip — handing the lifecycle off lets the splash overlay live
  // ABOVE the remount point so it survives the tree rebuild and
  // the customer sees one continuous animation start to finish
  // (no bridge swap, no white gap).
  const { toggleLanguage } = useLanguageSwitch();

  const handleLogout = () => {
    Alert.alert(copy.logoutTitle, copy.logoutConfirm, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: copy.logOut,
        style: 'destructive',
        onPress: async () => {
          // Unregister this device's Expo push token BEFORE signOut so
          // the next customer to log in on the same phone doesn't
          // inherit the outgoing user's order notifications. Best-effort
          // — failure here must not block sign-out.
          try {
            if (merchantId && user?.id) {
              const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
              const tokenRes = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined).catch(() => null);
              await unregisterPushToken({
                merchantId,
                customerId: user.id,
                token: tokenRes?.data });
            }
          } catch {}
          await signOut();
          router.replace('/(auth)/login');
        } },
    ]);
  };

  const openNotificationSettings = () => {
    Linking.openSettings();
  };

  const MenuItem = ({ icon: Icon, title, subtitle, onPress, isDestructive = false, accentColor }: any) => (
    <TouchableOpacity
      onPress={onPress}
      className="items-center p-4 mb-[1px]"
      style={{ backgroundColor: menuCardColor, flexDirection: 'row' }}
    >
      <View
        style={
          isDestructive
            ? undefined
            : { backgroundColor: `${accentColor || primaryColor}18` }
        }
        className={`w-10 h-10 rounded-full justify-center items-center ${isDestructive ? 'bg-red-50' : ''}`}
      >
        <Icon size={20} color={isDestructive ? '#EF4444' : (accentColor || '#0D9488')} />
      </View>
      <View
        className="flex-1"
        style={{
          marginStart: 16 }}
      >
        <Text className="text-base font-bold" style={{ color: isDestructive ? '#ef4444' : textColor }}>{title}</Text>
        {subtitle && <Text className="text-xs" style={{ color: textColor }}>{subtitle}</Text>}
      </View>
      {!isDestructive && <ChevronRight size={20} color={textColor} style={{ transform: [{ scaleX: isArabic ? -1 : 1 }] }} />}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={{ flex: 1, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0, backgroundColor }}>
      <ScrollView>
        <View className="p-6 mb-4 items-center" style={{ backgroundColor }}>
          <View className="w-20 h-20 rounded-full mb-3 justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
            <Text className="text-2xl font-bold" style={{ color: primaryColor }}>
              {profile.fullName ? profile.fullName.slice(0, 2).toUpperCase() : 'AA'}
            </Text>
          </View>
          <Text className="text-xl font-bold" style={{ color: textColor }}>
            {profile.fullName || copy.yourName}
          </Text>
          <Text style={{ color: textColor }}>{profile.phone || '+966 5X XXX XXXX'}</Text>
        </View>

        <Text className="px-4 mb-2 font-bold text-xs uppercase" style={{ color: textColor }}>{copy.account}</Text>
        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <MenuItem icon={User} title={copy.profileInfo} subtitle={copy.editDetails} onPress={() => router.push('/profile-modal')} accentColor={primaryColor} />
          <MenuItem icon={MapPin} title={copy.myAddresses} subtitle={copy.manageLocations} onPress={() => router.push('/address-modal')} accentColor={primaryColor} />
          {/* Receipts: tab-bar's Orders tab already lists every order
              the customer has placed and tapping any opens a receipt
              modal. Linking from More gives Saudi customers used to
              "find my receipts in account settings" a familiar entry
              point even though the same screen is one tab away. */}
          <MenuItem icon={Receipt} title={copy.receipts} subtitle={copy.receiptsSubtitle} onPress={() => router.push('/(tabs)/orders')} accentColor={primaryColor} />
          <MenuItem icon={Bell} title={copy.notifications} subtitle={copy.offersUpdates} onPress={openNotificationSettings} accentColor={primaryColor} />
          <MenuItem icon={Heart} title={copy.favorites} subtitle={copy.savedItems} onPress={() => router.push('/favorites-modal')} accentColor={primaryColor} />
        </View>

        <Text className="px-4 mb-2 font-bold text-xs uppercase" style={{ color: textColor }}>{copy.preferences}</Text>
        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <MenuItem
            icon={Wallet}
            title={isArabic ? 'محفظتي' : 'My Wallet'}
            subtitle={
              walletBalanceSar == null
                ? (isArabic ? 'الرصيد والمعاملات' : 'Balance and history')
                : isArabic
                  ? `الرصيد ${walletBalanceSar.toFixed(2)} ر.س`
                  : `Balance: ${walletBalanceSar.toFixed(2)} SAR`
            }
            onPress={() => router.push('/wallet-modal')}
            accentColor={primaryColor}
          />
          <MenuItem icon={CreditCard} title={copy.paymentMethod} subtitle={copy.cardsOptions} onPress={() => router.push('/payment-modal')} accentColor={primaryColor} />
        </View>

        <Text className="px-4 mb-2 font-bold text-xs uppercase" style={{ color: textColor }}>{copy.appSettings}</Text>
        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <TouchableOpacity
            onPress={toggleLanguage}
            className="items-center p-4"
            style={{ backgroundColor: menuCardColor, flexDirection: 'row' }}
          >
            <View className="w-10 h-10 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Globe size={20} color={primaryColor} />
            </View>
            <View
              className="flex-1"
              style={{
                marginStart: 16 }}
            >
              <Text className="text-base font-bold" style={{ color: textColor }}>Language / اللغة</Text>
              <Text className="text-xs" style={{ color: textColor }}>{i18n.language === 'en' ? copy.english : 'العربية'}</Text>
            </View>
            <View className="px-3 py-1 rounded-full" style={{ backgroundColor: menuCardColor }}>
              <Text className="font-bold text-xs" style={{ color: textColor }}>{i18n.language === 'en' ? 'AR' : 'EN'}</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text className="px-4 mb-2 font-bold text-xs uppercase" style={{ color: textColor }}>{copy.supportLegal}</Text>
        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <MenuItem icon={Mail} title={copy.contactUs} subtitle={copy.reachOut} onPress={() => router.push('/contact-modal')} />
          <MenuItem icon={Info} title={copy.about} subtitle={copy.learnAbout} onPress={() => router.push('/about-modal')} />
          <MenuItem icon={Shield} title={copy.privacyPolicy} onPress={() => router.push('/privacy-modal')} />
          <MenuItem icon={FileText} title={copy.terms} onPress={() => router.push('/terms-modal')} />
          <MenuItem icon={RotateCcw} title={copy.refund} onPress={() => router.push('/refund-modal')} />
        </View>

        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <MenuItem icon={LogOut} title={copy.logOut} isDestructive onPress={handleLogout} />
          <MenuItem
            icon={LogOut}
            title={isArabic ? 'احذف حسابي' : 'Delete my account'}
            subtitle={isArabic ? 'نهائي وما يرجع' : "Permanent — can't be undone"}
            isDestructive
            onPress={confirmDeleteAccount}
          />
        </View>

        <Text className="text-center text-xs mb-8" style={{ color: textColor }}>{copy.version}</Text>
      </ScrollView>

      {/* The language-switch overlay is mounted in _layout.tsx
          ABOVE the tree-remount point so it survives the rebuild
          that flips RTL. Nothing to render here. */}
    </SafeAreaView>
  );
}
