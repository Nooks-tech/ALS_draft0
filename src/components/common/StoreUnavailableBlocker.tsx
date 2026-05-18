/**
 * Full-screen blocker rendered in place of the tabs content when the
 * merchant's subscription is in the `suspended` state — i.e., they
 * went past their 2-day grace period without paying their bill.
 *
 * The customer sees a polite "store unavailable" message instead of
 * the menu, cart, or any other tab. Server-side gates already block
 * order POSTs and the menu endpoint, but the customer should never
 * even reach those — the store should look closed from the moment
 * the app opens.
 *
 * Bilingual (Arabic default + English fallback). Branding colors are
 * still applied so the blocker matches the merchant's app theme.
 */
import { Image, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

export default function StoreUnavailableBlocker() {
  const branding = useMerchantBranding();
  const { i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';
  const bg = branding.backgroundColor || '#0b0a08';
  const text = branding.textColor || '#f2e8d0';
  const accent = branding.primaryColor || '#c9a961';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        }}
      >
        {branding.logoUrl ? (
          <Image
            source={{ uri: branding.logoUrl }}
            style={{ width: 80, height: 80, marginBottom: 24, opacity: 0.7 }}
            resizeMode="contain"
          />
        ) : null}
        <Text
          style={{
            fontSize: 22,
            fontWeight: '700',
            color: text,
            textAlign: 'center',
            marginBottom: 12,
          }}
        >
          {isArabic ? 'المتجر غير متاح حالياً' : 'Store currently unavailable'}
        </Text>
        <Text
          style={{
            fontSize: 15,
            lineHeight: 22,
            color: text,
            opacity: 0.7,
            textAlign: 'center',
            maxWidth: 320,
          }}
        >
          {isArabic
            ? 'هذا المتجر متوقف عن استقبال الطلبات مؤقتاً. تواصل مع المتجر مباشرة أو حاول لاحقاً.'
            : 'This store has paused new orders. Reach out to the store directly or check back later.'}
        </Text>
        <View
          style={{
            marginTop: 24,
            height: 2,
            width: 48,
            backgroundColor: accent,
            opacity: 0.5,
          }}
        />
      </View>
    </SafeAreaView>
  );
}
