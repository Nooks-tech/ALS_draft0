import { Tabs } from 'expo-router';
import { ClipboardList, MoreHorizontal, Tag, Utensils } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';

export default function TabLayout() {
  const { t } = useTranslation();
  const { primaryColor, textColor } = useMerchantBranding();

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