import { Alert, Linking, Platform } from 'react-native';

type Lang = 'ar' | 'en';

function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function appleMapsUrl(lat: number, lng: number, label?: string): string {
  const q = label ? encodeURIComponent(label) : '';
  return `http://maps.apple.com/?q=${q}&ll=${lat},${lng}`;
}

/**
 * Open the platform map app pointed at a coordinate.
 *
 * iOS: presents an action sheet so the customer can pick Apple Maps
 * or Google Maps — many users have a strong preference and both
 * apps are common in KSA. Apple Maps falls through to the universal
 * URL (`maps://?q=...&ll=...`) which Apple Maps registers; the same
 * URL pasted in Google Maps just shows the Apple page, so we ship
 * a dedicated Google URL.
 *
 * Android: opens Google Maps directly (Apple Maps doesn't exist;
 * sending the user to maps.apple.com in Chrome is a worse UX than
 * just hitting Google).
 */
export function openMapToLocation(
  lat: number | null | undefined,
  lng: number | null | undefined,
  label: string | undefined,
  lang: Lang,
): void {
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  const isArabic = lang === 'ar';
  const gUrl = googleMapsUrl(lat, lng);
  if (Platform.OS === 'android') {
    void Linking.openURL(gUrl);
    return;
  }
  const aUrl = appleMapsUrl(lat, lng, label);
  Alert.alert(
    isArabic ? 'افتح في الخريطة' : 'Open in Maps',
    label || (isArabic ? 'اختر التطبيق' : 'Choose an app'),
    [
      { text: isArabic ? 'خرائط آبل' : 'Apple Maps', onPress: () => void Linking.openURL(aUrl) },
      { text: isArabic ? 'خرائط جوجل' : 'Google Maps', onPress: () => void Linking.openURL(gUrl) },
      { text: isArabic ? 'إلغاء' : 'Cancel', style: 'cancel' },
    ],
  );
}
