import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import {
  Bell,
  ChevronRight,
  CreditCard,
  FileText,
  Globe,
  Heart,
  Info,
  LogOut,
  Mail,
  MapPin,
  Shield,
  Star,
  User,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../src/context/AuthContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useProfile } from '../../src/context/ProfileContext';
import { Alert, I18nManager, Linking, Platform, SafeAreaView, ScrollView, StatusBar, Text, TouchableOpacity, View } from 'react-native';

export default function MoreScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { primaryColor, backgroundColor, menuCardColor, textColor } = useMerchantBranding();
  const { profile } = useProfile();
  const { signOut } = useAuth();
  const isArabic = i18n.language === 'ar';
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
        learnAbout: 'تعرف على ALS Coffee',
        privacyPolicy: 'سياسة الخصوصية',
        terms: 'الشروط والأحكام',
        logOut: 'تسجيل الخروج',
        version: 'الإصدار 1.0.0',
      }
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
        learnAbout: 'Learn about ALS Coffee',
        privacyPolicy: 'Privacy Policy',
        terms: 'Terms & Conditions',
        logOut: 'Log Out',
        version: 'Version 1.0.0',
      };

  const toggleLanguage = async () => {
    try {
      const nextLang = i18n.language === 'en' ? 'ar' : 'en';
      await AsyncStorage.setItem('language', nextLang);
      await i18n.changeLanguage(nextLang);
      const isRTL = nextLang === 'ar';
      if (I18nManager.isRTL !== isRTL) {
        I18nManager.allowRTL(isRTL);
        I18nManager.forceRTL(isRTL);
        try {
          await Updates.reloadAsync();
        } catch {
          // Language change already applied; reload can fail in some environments.
        }
      }
    } catch (error) {
      Alert.alert(copy.error, copy.changeLanguageFailed);
    }
  };

  const handleLogout = () => {
    Alert.alert(copy.logoutTitle, copy.logoutConfirm, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: copy.logOut,
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  const openNotificationSettings = () => {
    Linking.openSettings();
  };

  const MenuItem = ({ icon: Icon, title, subtitle, onPress, isDestructive = false, accentColor }: any) => (
    <TouchableOpacity onPress={onPress} className="flex-row items-center p-4 mb-[1px]" style={{ backgroundColor: menuCardColor }}>
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
      <View className="flex-1 ml-4">
        <Text className="text-base font-bold" style={{ color: isDestructive ? '#ef4444' : textColor }}>{title}</Text>
        {subtitle && <Text className="text-xs" style={{ color: textColor }}>{subtitle}</Text>}
      </View>
      {!isDestructive && <ChevronRight size={20} color={textColor} />}
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
          <MenuItem icon={Bell} title={copy.notifications} subtitle={copy.offersUpdates} onPress={openNotificationSettings} accentColor={primaryColor} />
          <MenuItem icon={Heart} title={copy.favorites} subtitle={copy.savedItems} onPress={() => router.push('/favorites-modal')} accentColor={primaryColor} />
        </View>

        <Text className="px-4 mb-2 font-bold text-xs uppercase" style={{ color: textColor }}>{copy.preferences}</Text>
        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <MenuItem icon={CreditCard} title={copy.paymentMethod} subtitle={copy.cardsOptions} onPress={() => router.push('/payment-modal')} accentColor={primaryColor} />
          <MenuItem icon={Star} title={copy.loyaltyPoints} subtitle={copy.rewards} onPress={() => router.push('/loyalty-modal')} accentColor={primaryColor} />
        </View>

        <Text className="px-4 mb-2 font-bold text-xs uppercase" style={{ color: textColor }}>{copy.appSettings}</Text>
        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <TouchableOpacity onPress={toggleLanguage} className="flex-row items-center p-4" style={{ backgroundColor: menuCardColor }}>
            <View className="w-10 h-10 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Globe size={20} color={primaryColor} />
            </View>
            <View className="flex-1 ml-4">
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
        </View>

        <View className="mb-6 rounded-2xl overflow-hidden mx-4" style={{ backgroundColor: menuCardColor }}>
          <MenuItem icon={LogOut} title={copy.logOut} isDestructive onPress={handleLogout} />
        </View>

        <Text className="text-center text-xs mb-8" style={{ color: textColor }}>{copy.version}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
