import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import * as Updates from 'expo-updates';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { I18nManager } from 'react-native';

import ar from './ar.json';
import en from './en.json';

const RESOURCES = {
  en: { translation: en },
  ar: { translation: ar },
};

const initI18n = async () => {
  let savedLanguage = await AsyncStorage.getItem('language');

  if (!savedLanguage || !['ar', 'en'].includes(savedLanguage)) {
    savedLanguage = Localization.getLocales()[0]?.languageCode === 'ar' ? 'ar' : 'en';
  }

  i18n.use(initReactI18next).init({
    compatibilityJSON: 'v3',
    resources: RESOURCES,
    lng: savedLanguage,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

  // Native RTL is the single source of truth (manual flips stripped
  // in the rtl-refactor pass). I18nManager.forceRTL is sticky native
  // state and only takes effect on the NEXT bundle reload, so when
  // the saved language and the current native direction disagree
  // we self-heal: queue the new direction AND trigger a reload so
  // the next paint comes up in the right shape. Without this, the
  // user sees one ugly intermediate frame after every toggle (the
  // strings flip immediately but the layout is still in the old
  // direction).
  const wantRTL = savedLanguage === 'ar';
  if (I18nManager.isRTL !== wantRTL) {
    try {
      I18nManager.allowRTL(wantRTL);
      I18nManager.forceRTL(wantRTL);
      // Defer so React doesn't tear down mid-render. The reload
      // re-runs this init with the new I18nManager state and the
      // condition becomes a no-op, breaking the loop.
      setTimeout(() => {
        Updates.reloadAsync().catch(() => {});
      }, 50);
    } catch {}
  }
};

initI18n();

export default i18n;