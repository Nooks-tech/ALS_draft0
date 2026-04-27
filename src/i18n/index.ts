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

  // RTL strategy: we DELIBERATELY do NOT call I18nManager.forceRTL.
  // Native RTL flips flex direction, padding, margins, and text-align
  // automatically — which collides with the per-screen `isArabic`
  // checks (`flexDirection: isArabic ? 'row-reverse' : 'row'`,
  // `marginLeft: isArabic ? 0 : 16`, etc.) we use throughout the app.
  // With forceRTL on, those manual flips were getting double-flipped
  // (e.g. row-reverse → row) and rendering inverted. Keeping the app
  // visually LTR at the native layer makes the explicit `isArabic`
  // checks the single source of truth.
  if (I18nManager.isRTL || !I18nManager.getConstants().isRTL) {
    try {
      I18nManager.allowRTL(false);
      I18nManager.forceRTL(false);
    } catch {}
  }
};

initI18n();

export default i18n;