import { Cairo_400Regular, Cairo_700Bold } from '@expo-google-fonts/cairo';
import { Poppins_400Regular, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import { useEffect } from 'react';
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

// Reads the language-switch state from context and renders
// AppSplash in overlay mode. Lives at the root so it floats above
// any screen the customer was on when they hit the language
// toggle, and stays visible right up until Updates.reloadAsync
// detonates the JS bundle.
function LanguageSwitchOverlay() {
  const { switching } = useLanguageSwitch();
  return <AppSplash mode="overlay" visible={switching} />;
}

/**
 * Proactive OTA-update applier. With the default expo-updates policy
 * (fallbackToCacheTimeout: 0), a freshly published OTA only takes
 * effect on the SECOND cold launch — the current launch always runs
 * the cached old bundle, the update downloads in the background, and
 * the next launch picks it up. That cost a full perf rollout: a
 * customer who opened, used, and closed the app within the download
 * window kept seeing the OLD bundle even though the new one was
 * sitting on the CDN.
 *
 * This component runs once on mount, asks Expo if a new bundle is
 * available, downloads it, and reloads with it BEFORE the customer
 * gets to interact with the old code. The whole check is gated on
 * __DEV__ being false so local dev / Expo Go isn't disrupted, and
 * on Updates.isEnabled so it no-ops in environments where the update
 * runtime isn't wired (e.g. internal distribution builds without
 * EAS Update channels).
 *
 * Worst case (network slow): the customer sees the splash for a
 * second longer than usual while the bundle downloads, then the
 * NEW bundle reloads in. That's strictly better than the old
 * "use the slow bundle, then maybe get the fast one next time"
 * behavior.
 */
function OtaUpdateGate() {
  useEffect(() => {
    if (__DEV__) return;
    if (!Updates.isEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const check = await Updates.checkForUpdateAsync();
        if (cancelled || !check.isAvailable) return;
        const fetched = await Updates.fetchUpdateAsync();
        if (cancelled || !fetched.isNew) return;
        // Reload with the freshly-downloaded bundle. The customer
        // sees one extra splash flicker but is now on current code.
        await Updates.reloadAsync();
      } catch {
        // Update server unreachable / runtime version mismatch /
        // already-up-to-date — none of which should block the app.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return null;
}

function NotificationPermissionInitializer() {
  // Runs once on app mount, after a small delay so the cold-start
  // splash gets a frame to render before the iOS / Android 13+
  // permission modal pops over it. Crucially this is NOT gated on
  // merchant-branding load state — the previous SplashGate-based
  // wiring depended on `loading` flipping to false, which in turn
  // depended on the merchant fetch resolving. A slow fetch (or
  // a user who killed the app before splash hide) meant
  // requestPermissionsAsync was never invoked, so iOS never created
  // a Notifications row in Settings and the device could never
  // receive pushes. This decoupling means every cold launch fires
  // the request regardless of network conditions or user impatience.
  //
  // SplashScreen.hideAsync() lives in AppSplash now (cold-start
  // mode releases the native splash itself once branding loads +
  // min visible time elapses), so we don't need to call it here.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void requestNotificationPermissions();
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

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
        {/* Runs requestNotificationPermissions() 1.5s after mount,
            independent of merchant context. Replaces the old
            SplashGate path which got orphaned during the splash
            refactor and was silently leaving new devices without
            an iOS Notifications row. */}
        <OtaUpdateGate />
        <NotificationPermissionInitializer />
        <AuthProvider>
        <MerchantProvider>
        <MerchantBrandingWrapper>
        <LanguageSwitchProvider>
        {/* MenuProvider is hoisted above the splash so the menu fetch
            kicks off in parallel with the splash min-visible timer
            (instead of after splash fades, which leaves the menu
            screen blank for an extra beat). The splash also reads
            menu.hydrated to hold itself visible until there's
            something to paint underneath. */}
        <MenuProvider>
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
        </OperationsProvider>
        </CartProvider>
        </MenuProvider>
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