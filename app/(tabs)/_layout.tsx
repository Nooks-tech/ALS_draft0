import { Tabs, useRouter } from 'expo-router';
import { ClipboardList, MoreHorizontal, Tag, Utensils } from 'lucide-react-native';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useAuth } from '../../src/context/AuthContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useProfile } from '../../src/context/ProfileContext';

export default function TabLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user } = useAuth();
  const { profile, profileLoaded } = useProfile();
  const { primaryColor, textColor } = useMerchantBranding();

  useEffect(() => {
    if (user && profileLoaded && !profile.phone?.trim()) {
      router.replace('/(auth)/complete-profile');
    }
  }, [user, profileLoaded, profile.phone, router]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: textColor,
        tabBarInactiveTintColor: textColor,
        tabBarStyle: {
          backgroundColor: primaryColor,
          borderTopWidth: 0,
          paddingBottom: Platform.OS === 'ios' ? 25 : 10,
          height: Platform.OS === 'ios' ? 85 : 60,
          paddingTop: 10,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontFamily: 'Cairo-Bold',
        },
      }}
    >
      <Tabs.Screen
        name="menu"
        options={{
          title: t('menu'),
          tabBarIcon: ({ color }) => <Utensils color={color} size={24} />,
        }}
      />
      <Tabs.Screen
        name="offers"
        options={{
          title: t('offers'),
          tabBarIcon: ({ color }) => <Tag color={color} size={24} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: t('orders'),
          tabBarIcon: ({ color }) => <ClipboardList color={color} size={24} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t('more'),
          tabBarIcon: ({ color }) => <MoreHorizontal color={color} size={24} />,
        }}
      />
    </Tabs>
  );
}