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

  if (!savedLanguage) {
    savedLanguage = Localization.getLocales()[0].languageCode;
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

  // Handle RTL Layout
  const isRTL = i18n.dir() === 'rtl';
  if (I18nManager.isRTL !== isRTL) {
      I18nManager.allowRTL(isRTL);
      I18nManager.forceRTL(isRTL);
  }
};

initI18n();

export default i18n;