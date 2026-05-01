import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
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

  // Native RTL is now the single source of truth. The manual
  // `isArabic ? 'row-reverse' : 'row'` / `marginLeft: isArabic ? ...`
  // / `textAlign: isArabic ? ...` swaps have been stripped from the
  // tree (see the rtl-refactor commit), so plain `flexDirection:
  // 'row'` + `marginStart`/`marginEnd` + default text alignment
  // mirror automatically when `forceRTL(true)` is set. The more.tsx
  // language toggle calls Updates.reloadAsync after this runs so
  // the new direction takes effect on the next paint.
  const wantRTL = savedLanguage === 'ar';
  if (I18nManager.isRTL !== wantRTL) {
    try {
      I18nManager.allowRTL(wantRTL);
      I18nManager.forceRTL(wantRTL);
    } catch {}
  }
};

initI18n();

export default i18n;