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

  // Keep forceRTL OFF on every launch. Native RTL was breaking
  // English: the codebase is full of manual `flexDirection:
  // isArabic ? 'row-reverse' : 'row'` swaps, and once forceRTL was
  // enabled for Arabic those swaps became double-flips (and on the
  // English side, native RTL stayed sticky between sessions and
  // turned every plain `row` into `row-reverse`). The manual flips
  // on each screen are the single source of truth; English renders
  // LTR natively and Arabic mirrors via the flips.
  if (I18nManager.isRTL) {
    try {
      I18nManager.allowRTL(false);
      I18nManager.forceRTL(false);
    } catch {}
  }
};

initI18n();

export default i18n;