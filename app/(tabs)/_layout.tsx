import { Tabs } from 'expo-router';
import { Gift, LayoutGrid, MoreHorizontal, Package } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, Text, View } from 'react-native';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';

export default function TabLayout() {
  const { t } = useTranslation();
  const { primaryColor, tabTextColor, menuLayout, layoutColors } = useMerchantBranding();
  const isPolaroid = menuLayout === 'polaroid';
  const tabBg = isPolaroid ? (layoutColors.tabBarBg ?? '#140d04') : primaryColor;
  const activeTint = isPolaroid ? (layoutColors.tabBarActive ?? layoutColors.accent ?? '#e07b3a') : tabTextColor;
  const inactiveTint = isPolaroid ? (layoutColors.tabBarInactive ?? 'rgba(240,226,200,0.55)') : tabTextColor;
  const activePillBg = isPolaroid ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.16)';
  // Note: suspension is gated at the root layout (SuspensionGate
  // wraps the entire Stack), so this layout doesn't need its own
  // check — by the time we render here, the merchant is not
  // suspended.

  const renderTabIcon = (
    Icon: typeof LayoutGrid,
    color: string,
    focused: boolean,
  ) => (
    <View
      style={{
        width: 42,
        height: 42,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: focused ? activePillBg : 'transparent' }}
    >
      <Icon color={color} size={isPolaroid ? 26 : 29} />
    </View>
  );

  const renderTabLabel = (label: string, color: string, focused: boolean) => (
    <Text
      style={{
        color,
        fontSize: isPolaroid ? 10 : 13,
        fontFamily: isPolaroid ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : 'Cairo-Bold',
        letterSpacing: isPolaroid ? 1.4 : 0,
        textTransform: isPolaroid ? 'uppercase' : 'none',
        opacity: focused ? 1 : 0.72,
        textAlign: 'center',
        marginTop: 2 }}
    >
      {label}
    </Text>
  );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: activeTint,
        tabBarInactiveTintColor: inactiveTint,
        tabBarStyle: {
          backgroundColor: tabBg,
          borderTopWidth: isPolaroid ? 1 : 0,
          borderTopColor: isPolaroid ? `${activeTint}22` : 'transparent',
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingBottom: Platform.OS === 'ios' ? 24 : 14,
          height: Platform.OS === 'ios' ? 96 : 78,
          paddingTop: 14,
          borderTopLeftRadius: isPolaroid ? 0 : 20,
          borderTopRightRadius: isPolaroid ? 0 : 20 },
        tabBarItemStyle: {
          paddingVertical: 4,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ translateY: -6 }] },
        tabBarButton: (props) => (
          <Pressable
            {...props}
            android_ripple={{ color: 'rgba(255,255,255,0.10)', borderless: false }}
            style={({ pressed }) => [props.style, pressed && { opacity: 0.75 }]}
          />
        ) }}
    >
      <Tabs.Screen
        name="menu"
        options={{
          title: t('menu'),
          tabBarLabel: ({ color, focused }) => renderTabLabel(t('menu'), color, focused),
          tabBarIcon: ({ color, focused }) => renderTabIcon(LayoutGrid, color, focused) }}
      />
      <Tabs.Screen
        name="offers"
        options={{
          title: t('offers'),
          tabBarLabel: ({ color, focused }) => renderTabLabel(t('offers'), color, focused),
          tabBarIcon: ({ color, focused }) => renderTabIcon(Gift, color, focused) }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: t('orders'),
          tabBarLabel: ({ color, focused }) => renderTabLabel(t('orders'), color, focused),
          tabBarIcon: ({ color, focused }) => renderTabIcon(Package, color, focused) }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t('more'),
          tabBarLabel: ({ color, focused }) => renderTabLabel(t('more'), color, focused),
          tabBarIcon: ({ color, focused }) => renderTabIcon(MoreHorizontal, color, focused) }}
      />
    </Tabs>
  );
}