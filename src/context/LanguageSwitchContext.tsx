/**
 * Owns the language-switch lifecycle: AppSplash visibility, remount
 * key for the routed tree, and the toggle function. Living above
 * MerchantBrandingWrapper but ABOVE the remount key wrapper means
 * the overlay + state survive the remount that flips RTL.
 *
 * The toggle DOES NOT call Updates.reloadAsync. Bridge reload was
 * what produced the white-screen gap (RN's default white RCTRootView
 * peeks through during the ~300 ms swap). Instead we:
 *   1. Persist the new language to AsyncStorage + i18n.
 *   2. Flip I18nManager.allowRTL/forceRTL synchronously.
 *   3. Bump `remountKey` so the routed tree (Stack + Tabs) fully
 *      unmounts and remounts. Yoga re-evaluates flexDirection on
 *      the new layout pass with the freshly-set isRTL value, which
 *      flips tab bars / headers / row layouts the same way a
 *      bundle reload would.
 *   4. Keep AppSplash visible while the tree rebuilds, then hide.
 * No bridge swap, no white gap, the dotted splash is the only
 * thing the customer sees from start to finish.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from 'i18next';
import { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { I18nManager } from 'react-native';

type Ctx = {
  remountKey: number;
  switching: boolean;
  toggleLanguage: () => Promise<void>;
};

const LanguageSwitchContext = createContext<Ctx>({
  remountKey: 0,
  switching: false,
  toggleLanguage: async () => {},
});

export function LanguageSwitchProvider({ children }: { children: ReactNode }) {
  const [remountKey, setRemountKey] = useState(0);
  const [switching, setSwitching] = useState(false);

  const toggleLanguage = useCallback(async () => {
    if (switching) return;
    const nextLang = i18n.language === 'en' ? 'ar' : 'en';
    const nextRtl = nextLang === 'ar';

    setSwitching(true);
    try {
      // Persist + apply the i18n change BEFORE the remount so the
      // new tree paints with the new language strings on first
      // render. Synchronous from React's perspective.
      await AsyncStorage.setItem('language', nextLang);
      await i18n.changeLanguage(nextLang);

      // forceRTL flips the I18nManager native flag. Yoga reads it
      // on the NEXT layout pass — which is exactly what happens
      // when we bump remountKey below.
      try {
        if (I18nManager.isRTL !== nextRtl) {
          I18nManager.allowRTL(nextRtl);
          I18nManager.forceRTL(nextRtl);
        }
      } catch {}

      // Hold the splash on screen for the dot-pulse cycle so the
      // transition reads as deliberate.
      await new Promise((r) => setTimeout(r, 1200));

      // Detonate the routed tree. Stack + Tabs unmount fully and
      // remount with the new direction. AppSplash sits ABOVE this
      // wrapper so it's untouched.
      setRemountKey((k) => k + 1);

      // Give the new tree a beat to lay out before we drop the
      // overlay. Without this, the overlay vanishes and the
      // customer sees the menu mid-relayout.
      await new Promise((r) => setTimeout(r, 350));
    } finally {
      setSwitching(false);
    }
  }, [switching]);

  return (
    <LanguageSwitchContext.Provider value={{ remountKey, switching, toggleLanguage }}>
      {children}
    </LanguageSwitchContext.Provider>
  );
}

export const useLanguageSwitch = () => useContext(LanguageSwitchContext);
