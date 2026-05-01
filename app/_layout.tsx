import { Cairo_400Regular, Cairo_700Bold } from '@expo-google-fonts/cairo';
import { Poppins_400Regular, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import Constants from 'expo-constants';
import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler'; // 👈 CRITICAL FIX
import { SafeAreaProvider } from 'react-native-safe-area-context'; // 👈 STABILITY FIX

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import "../global.css";
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';
import { AppSplash } from '../src/components/splash/AppSplash';
import {
  LanguageSwitchProvider,
  useLanguageSwitch,
} from '../src/context/LanguageSwitchContext';
import { View } from 'react-native';
import * as SystemUI from 'expo-system-ui';

// Pin the iOS / Android root-view backgroundColor to the merchant's
// build-time color BEFORE any React renders. This is the layer that
// shows underneath RCTRootView during the brief bridge-reload window
// (Updates.reloadAsync from the language toggle) — without this, the
// OS-default off-white view bled through and the customer saw a
// white flash mid-transition. Setting this at module load means it
// applies on the very first frame of the new bundle, not later.
{
  const initialBg = (process.env.EXPO_PUBLIC_BACKGROUND_COLOR || '').trim();
  if (initialBg) {
    SystemUI.setBackgroundColorAsync(initialBg).catch(() => {});
  }
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true }) });

async function requestNotificationPermissions() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('orders', {
      name: 'Order Updates',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default' });
    await Notifications.setNotificationChannelAsync('marketing', {
      name: 'Promotions & Updates',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default' });
  }
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    await Notifications.requestPermissionsAsync();
  }
}
import { AuthProvider } from '../src/context/AuthContext';
import { CartProvider } from '../src/context/CartContext';
import { MerchantBrandingWrapper, useMerchantBranding } from '../src/context/MerchantBrandingContext';
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

// Reads the language-switch state from context and renders
// AppSplash in overlay mode. Lives at the root so it floats above
// any screen the customer was on when they hit the language
// toggle, and stays visible right up until Updates.reloadAsync
// detonates the JS bundle.
function LanguageSwitchOverlay() {
  const { switching } = useLanguageSwitch();
  return <AppSplash mode="overlay" visible={switching} />;
}

function SplashGate() {
  const { loading } = useMerchantBranding();
  const releasedRef = useRef(false);

  useEffect(() => {
    if (loading || releasedRef.current) return;
    releasedRef.current = true;

    void SplashScreen.hideAsync()
      .catch(() => {
        // Ignore startup timing races when the native splash is already gone.
      })
      .finally(() => {
        void requestNotificationPermissions();
      });
  }, [loading]);

  return null;
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    'Cairo-Regular': Cairo_400Regular,
    'Cairo-Bold': Cairo_700Bold,
    'Poppins-Regular': Poppins_400Regular,
    'Poppins-Bold': Poppins_700Bold });

  if (!loaded && !error) {
    return null;
  }

  return (
    <ErrorBoundary>
    {/* GestureHandlerRootView's backgroundColor is the layer that
        paints between the JS bridge starting and BrandedSplashOverlay
        mounting. Setting it to the merchant's bg via the build-time
        env var means the very first frame of every bundle reload
        is already merchant-colored — no white peeking through during
        Updates.reloadAsync from the language toggle. */}
    <GestureHandlerRootView
      style={{
        flex: 1,
        backgroundColor: (process.env.EXPO_PUBLIC_BACKGROUND_COLOR || '').trim() || '#0d9488',
      }}
    >
      <SafeAreaProvider>
        <AuthProvider>
        <MerchantProvider>
        <MerchantBrandingWrapper>
        <LanguageSwitchProvider>
        {/* AppSplash in 'cold-start' mode = the only splash. Hides
            the native iOS / Android splash on its first layout pass
            and stays visible (with the merchant icon + pulsing dots
            on the merchant background) until branding has loaded
            AND a minimum visible time has elapsed, then fades. */}
        <AppSplash mode="cold-start" />
        {/* Language-switch overlay sits at the root so it floats
            above whatever screen the customer was on when they
            tapped the toggle, and stays visible until the bundle
            reload detonates the bridge — at which point the new
            bundle's AppSplash cold-start mode takes over. */}
        <LanguageSwitchOverlay />
        <CartProvider>
        <OperationsProvider>
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
            <Stack.Screen name="add-address-modal" options={{ presentation: 'modal' }} />
            <Stack.Screen name="support-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="contact-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="payment-modal" options={{ presentation: 'transparentModal' }} />
            <Stack.Screen name="add-card-modal" options={{ presentation: 'transparentModal' }} />
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
        </OperationsProvider>
        </CartProvider>
        </LanguageSwitchProvider>
        </MerchantBrandingWrapper>
        </MerchantProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

const PUSH_REGISTRATION_FAILURE_KEY = '@nooks_push_registration_failed';

function PushTokenRegistrar() {
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  // i18n is lazy-loaded; read the current language via require so this
  // component stays dependency-light for the rest of the tree.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const i18nInstance = require('../src/i18n').default as { language?: string };
  const appLanguage = (i18nInstance?.language || 'en').startsWith('ar') ? 'ar' : 'en';

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!user?.id || !merchantId) return;
      try {
        const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
        const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
        if (!token || cancelled) return;
        await registerPushToken({
          merchantId,
          customerId: user.id,
          token,
          appLanguage });
        // Clear the failure flag so the banner disappears if it was shown.
        AsyncStorage.removeItem(PUSH_REGISTRATION_FAILURE_KEY).catch(() => {});
      } catch (err: any) {
        console.warn('[Push] Registration failed:', err?.message || 'unknown error');
        // Persist the failure so the customer's next app launch shows a
        // visible banner asking them to enable notifications. Without this
        // they get zero signal when push stops working and miss order
        // status updates entirely.
        AsyncStorage.setItem(PUSH_REGISTRATION_FAILURE_KEY, '1').catch(() => {});
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id, merchantId, appLanguage]);

  return null;
}

export { PUSH_REGISTRATION_FAILURE_KEY };