/** Fallback when merchant branding is not loaded. App uses useMerchantBranding().primaryColor everywhere. */
const tintColorLight = '#0D9488';
const tintColorDark = '#fff';

export const Colors = {
  primary: '#0D9488',
  secondary: '#FFC107',
  light: {
    text: '#11181C',
    background: '#F8FAFC', // 👈 Off-White
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};