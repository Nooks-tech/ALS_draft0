import { Cairo_400Regular, Cairo_700Bold } from '@expo-google-fonts/cairo';
import { Poppins_400Regular, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler'; // 👈 CRITICAL FIX
import { SafeAreaProvider } from 'react-native-safe-area-context'; // 👈 STABILITY FIX

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import "../global.css";
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function requestNotificationPermissions() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('orders', {
      name: 'Order Updates',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  }
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    await Notifications.requestPermissionsAsync();
  }
}
import { AuthProvider } from '../src/context/AuthContext';
import { CartProvider } from '../src/context/CartContext';
import { MerchantBrandingWrapper } from '../src/context/MerchantBrandingContext';
import { MerchantProvider } from '../src/context/MerchantContext';
import { OperationsProvider } from '../src/context/OperationsContext';
import { FavoritesProvider } from '../src/context/FavoritesContext';
import { MenuProvider } from '../src/context/MenuContext';
import { OrdersProvider } from '../src/context/OrdersContext';
import { ProfileProvider } from '../src/context/ProfileContext';
import { SavedAddressesProvider } from '../src/context/SavedAddressesContext';
import { useAuth } from '../src/context/AuthContext';
import { useMerchant } from '../src/context/MerchantContext';
import { registerPushToken } from '../src/api/push';
import '../src/i18n';

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    'Cairo-Regular': Cairo_400Regular,
    'Cairo-Bold': Cairo_700Bold,
    'Poppins-Regular': Poppins_400Regular,
    'Poppins-Bold': Poppins_700Bold,
  });

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
      requestNotificationPermissions();
    }
  }, [loaded, error]);

  if (!loaded && !error) {
    return null;
  }

  return (
    <ErrorBoundary>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
        <MerchantProvider>
        <MerchantBrandingWrapper>
        <OperationsProvider>
        <CartProvider>
          <MenuProvider>
          <FavoritesProvider>
          <OrdersProvider>
          <ProfileProvider>
          <SavedAddressesProvider>
          <PushTokenRegistrar />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="+not-found" />
            
            <Stack.Screen name="cart" options={{ presentation: 'modal' }} />
            <Stack.Screen name="checkout" options={{ presentation: 'modal' }} />
            <Stack.Screen name="order-type" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="product" options={{ presentation: 'modal' }} />
            <Stack.Screen name="profile-modal" options={{ presentation: 'modal' }} />
            <Stack.Screen name="address-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="add-address-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="support-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="contact-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="payment-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="favorites-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="order-detail-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="about-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="privacy-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="terms-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="loyalty-modal" options={{ presentation: 'modal' }} />
            <Stack.Screen name="order-confirmed" options={{ presentation: 'modal', gestureEnabled: false }} />
          </Stack>
          </SavedAddressesProvider>
          </ProfileProvider>
          </OrdersProvider>
          </FavoritesProvider>
          </MenuProvider>
        </CartProvider>
        </OperationsProvider>
        </MerchantBrandingWrapper>
        </MerchantProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

function PushTokenRegistrar() {
  const { user } = useAuth();
  const { merchantId } = useMerchant();

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!user?.id || !merchantId) return;
      if (!Device.isDevice) return;
      try {
        const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
        const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
        if (!token || cancelled) return;
        await registerPushToken({
          merchantId,
          customerId: user.id,
          token,
        });
      } catch {
        // Non-blocking: push registration can fail silently.
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id, merchantId]);

  return null;
}