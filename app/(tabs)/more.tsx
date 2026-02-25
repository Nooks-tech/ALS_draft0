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
  HelpCircle,
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
  const { primaryColor, backgroundColor } = useMerchantBranding();
  const { profile } = useProfile();
  const { signOut } = useAuth();

  const toggleLanguage = async () => {
    try {
      const nextLang = i18n.language === 'en' ? 'ar' : 'en';
      await AsyncStorage.setItem('language', nextLang);
      await i18n.changeLanguage(nextLang);
      const isRTL = nextLang === 'ar';
      if (I18nManager.isRTL !== isRTL) {
        I18nManager.allowRTL(isRTL);
        I18nManager.forceRTL(isRTL);
        await Updates.reloadAsync();
      }
    } catch (error) {
      Alert.alert('Error', 'Could not change language.');
    }
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
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
    <TouchableOpacity onPress={onPress} className="flex-row items-center bg-white p-4 mb-[1px]">
      <View style={!isDestructive && accentColor ? { backgroundColor: `${accentColor}18` } : undefined} className={`w-10 h-10 rounded-full justify-center items-center ${isDestructive ? 'bg-red-50' : accentColor ? '' : 'bg-slate-50'}`}>
        <Icon size={20} color={isDestructive ? '#EF4444' : (accentColor || '#0D9488')} />
      </View>
      <View className="flex-1 ml-4">
        <Text className={`text-base font-bold ${isDestructive ? 'text-red-500' : 'text-slate-800'}`}>{title}</Text>
        {subtitle && <Text className="text-slate-400 text-xs">{subtitle}</Text>}
      </View>
      {!isDestructive && <ChevronRight size={20} color="#94a3b8" />}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={{ flex: 1, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0, backgroundColor }}>
      <ScrollView>
        <View className="bg-white p-6 mb-4 items-center border-b border-slate-100">
          <View className="w-20 h-20 rounded-full mb-3 justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
            <Text className="text-2xl font-bold" style={{ color: primaryColor }}>
              {profile.fullName ? profile.fullName.slice(0, 2).toUpperCase() : 'AA'}
            </Text>
          </View>
          <Text className="text-xl font-bold text-slate-800">
            {profile.fullName || 'Your Name'}
          </Text>
          <Text className="text-slate-500">{profile.phone || '+966 5X XXX XXXX'}</Text>
        </View>

        <Text className="px-4 mb-2 text-slate-500 font-bold text-xs uppercase">Account</Text>
        <View className="mb-6 bg-white rounded-2xl overflow-hidden mx-4">
          <MenuItem icon={User} title="Profile Info" subtitle="Edit your details" onPress={() => router.push('/profile-modal')} accentColor={primaryColor} />
          <MenuItem icon={MapPin} title="My Addresses" subtitle="Manage delivery locations" onPress={() => router.push('/address-modal')} accentColor={primaryColor} />
          <MenuItem icon={Bell} title="Notifications" subtitle="Offers & Updates" onPress={openNotificationSettings} accentColor={primaryColor} />
          <MenuItem icon={Heart} title="Favorites" subtitle="Your saved items" onPress={() => router.push('/favorites-modal')} accentColor={primaryColor} />
        </View>

        <Text className="px-4 mb-2 text-slate-500 font-bold text-xs uppercase">Preferences</Text>
        <View className="mb-6 bg-white rounded-2xl overflow-hidden mx-4">
          <MenuItem icon={CreditCard} title="Payment Method" subtitle="Cards & payment options" onPress={() => router.push('/payment-modal')} accentColor={primaryColor} />
          <MenuItem icon={Star} title="Loyalty Points" subtitle="Earn & redeem rewards" onPress={() => router.push('/loyalty-modal')} accentColor={primaryColor} />
        </View>

        <Text className="px-4 mb-2 text-slate-500 font-bold text-xs uppercase">App Settings</Text>
        <View className="mb-6 bg-white rounded-2xl overflow-hidden mx-4">
          <TouchableOpacity onPress={toggleLanguage} className="flex-row items-center p-4">
            <View className="w-10 h-10 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
              <Globe size={20} color={primaryColor} />
            </View>
            <View className="flex-1 ml-4">
              <Text className="text-base font-bold text-slate-800">Language / اللغة</Text>
              <Text className="text-slate-400 text-xs">{i18n.language === 'en' ? 'English' : 'العربية'}</Text>
            </View>
            <View className="bg-slate-100 px-3 py-1 rounded-full">
              <Text className="font-bold text-xs text-slate-600">{i18n.language === 'en' ? 'AR' : 'EN'}</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text className="px-4 mb-2 text-slate-500 font-bold text-xs uppercase">Support & Legal</Text>
        <View className="mb-6 bg-white rounded-2xl overflow-hidden mx-4">
          <MenuItem icon={HelpCircle} title="Support" subtitle="Get help" onPress={() => router.push('/support-modal')} />
          <MenuItem icon={Mail} title="Contact Us" subtitle="Reach out to us" onPress={() => router.push('/contact-modal')} />
          <MenuItem icon={Info} title="About" subtitle="Learn about ALS Coffee" onPress={() => router.push('/about-modal')} />
          <MenuItem icon={Shield} title="Privacy Policy" onPress={() => router.push('/privacy-modal')} />
          <MenuItem icon={FileText} title="Terms & Conditions" onPress={() => router.push('/terms-modal')} />
        </View>

        <View className="mb-6 bg-white rounded-2xl overflow-hidden mx-4">
          <MenuItem icon={LogOut} title="Log Out" isDestructive onPress={handleLogout} />
        </View>

        <Text className="text-center text-slate-400 text-xs mb-8">Version 1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
