/**
 * Owns the language-switch lifecycle: AppSplash visibility + the
 * toggle function.
 *
 * I18nManager.forceRTL ONLY takes effect on the next bundle reload
 * — Yoga reads isRTL at native layer when it initializes, and
 * cached layout for native components like the bottom tab bar
 * doesn't refresh from a JS-only remount. Without
 * Updates.reloadAsync the customer's tabs stay in the previous
 * direction until they manually kill the app from the switcher.
 *
 * So we DO call Updates.reloadAsync, but we hide the bridge-swap
 * window behind the dotted AppSplash overlay. The native splash
 * (after a fresh build with merchant patches) AND the JS
 * AppSplash both render the same merchant-tile + logo, so even
 * though there's a brief moment the bridge is reloading, the
 * customer sees the same image throughout. The dotted overlay
 * fades the moment the new bundle's AppSplash takes over.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from 'i18next';
import * as Updates from 'expo-updates';
import { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { I18nManager } from 'react-native';

type Ctx = {
  switching: boolean;
  toggleLanguage: () => Promise<void>;
};

const LanguageSwitchContext = createContext<Ctx>({
  switching: false,
  toggleLanguage: async () => {},
});

export function LanguageSwitchProvider({ children }: { children: ReactNode }) {
  const [switching, setSwitching] = useState(false);

  const toggleLanguage = useCallback(async () => {
    if (switching) return;
    const nextLang = i18n.language === 'en' ? 'ar' : 'en';
    const nextRtl = nextLang === 'ar';

    setSwitching(true);
    try {
      // Persist BEFORE flipping forceRTL so the next bundle's
      // i18n init reads the right language and applies the right
      // direction on cold start.
      await AsyncStorage.setItem('language', nextLang);
      await i18n.changeLanguage(nextLang);

      try {
        if (I18nManager.isRTL !== nextRtl) {
          I18nManager.allowRTL(nextRtl);
          I18nManager.forceRTL(nextRtl);
        }
      } catch {}

      // Hold the splash on screen for one full dot-pulse cycle
      // before triggering the bundle reload, so the transition
      // reads as a deliberate splash instead of a stutter.
      await new Promise((r) => setTimeout(r, 1200));

      try {
        await Updates.reloadAsync();
      } catch {
        // Updates.reloadAsync is unavailable in dev / Expo Go;
        // drop the overlay so the customer isn't stuck staring
        // at it. (In dev tabs won't actually flip — they need a
        // production reload — but at least we don't hang.)
        setSwitching(false);
      }
    } catch {
      setSwitching(false);
    }
  }, [switching]);

  return (
    <LanguageSwitchContext.Provider value={{ switching, toggleLanguage }}>
      {children}
    </LanguageSwitchContext.Provider>
  );
}

export const useLanguageSwitch = () => useContext(LanguageSwitchContext);
