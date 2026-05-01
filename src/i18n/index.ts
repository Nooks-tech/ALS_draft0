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

  // Native RTL — the bottom tab bar, navigation gestures, and any
  // platform component that captures direction at mount don't flip
  // unless I18nManager.forceRTL is on. The `more.tsx` language
  // toggle calls Updates.reloadAsync after this so the new direction
  // applies on the next paint, not the next install.
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