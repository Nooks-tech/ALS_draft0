import { Cairo_400Regular, Cairo_700Bold } from '@expo-google-fonts/cairo';
import { Poppins_400Regular, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler'; // 👈 CRITICAL FIX
import { SafeAreaProvider } from 'react-native-safe-area-context'; // 👈 STABILITY FIX

import "../global.css";
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';
import { AuthProvider } from '../src/context/AuthContext';
import { CartProvider } from '../src/context/CartContext';
import { MerchantBrandingWrapper } from '../src/context/MerchantBrandingContext';
import { MerchantProvider } from '../src/context/MerchantContext';
import { FavoritesProvider } from '../src/context/FavoritesContext';
import { MenuProvider } from '../src/context/MenuContext';
import { OrdersProvider } from '../src/context/OrdersContext';
import { ProfileProvider } from '../src/context/ProfileContext';
import { SavedAddressesProvider } from '../src/context/SavedAddressesContext';
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
        <CartProvider>
          <MenuProvider>
          <FavoritesProvider>
          <OrdersProvider>
          <ProfileProvider>
          <SavedAddressesProvider>
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
          </Stack>
          </SavedAddressesProvider>
          </ProfileProvider>
          </OrdersProvider>
          </FavoritesProvider>
          </MenuProvider>
        </CartProvider>
        </MerchantBrandingWrapper>
        </MerchantProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}