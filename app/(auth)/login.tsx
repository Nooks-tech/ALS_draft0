import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../../src/components/common/Button';
import { Container } from '../../src/components/common/Container';
import { authApi } from '../../src/api/auth';
import { PHONE_PREFIX, ensurePrefix } from '../../src/utils/phone';
import { MerchantLogoImage } from '../../src/components/branding/MerchantLogoImage';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useMerchant } from '../../src/context/MerchantContext';

function getExtraAppName(): string | null {
  const extra = Constants.expoConfig?.extra as { appName?: string } | undefined;
  const n = extra?.appName?.trim();
  return n || null;
}

export default function LoginScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';
  const {
    appName,
    cafeName,
    logoUrl,
    appIconUrl,
    appIconBgColor,
    primaryColor,
    backgroundColor,
    textColor,
    launcherIconScale,
  } = useMerchantBranding();
  const { merchantId } = useMerchant();

  const brandName = useMemo(() => {
    const fromApi = (appName?.trim() || cafeName?.trim() || '').trim();
    if (fromApi) return fromApi;
    return getExtraAppName() || 'ALS';
  }, [appName, cafeName]);

  const copy = isArabic
    ? {
        error: 'خطأ',
        invalidPhone: 'يرجى إدخال رقم جوال سعودي صحيح.',
        sendCodeFailed: 'تعذر إرسال الرمز.',
        intro: 'أدخل رقم جوالك للبدء',
        phoneNumber: 'رقم الجوال',
        continue: 'متابعة',
        smsNotice: 'سنرسل لك رمز تحقق عبر رسالة نصية',
      }
    : {
        error: 'Error',
        invalidPhone: 'Please enter a valid Saudi phone number.',
        sendCodeFailed: 'Could not send code.',
        intro: 'Enter your phone number to get started',
        phoneNumber: 'Phone Number',
        continue: 'Continue',
        smsNotice: "We'll send you a verification code via SMS",
      };

  const [digits, setDigits] = useState('');
  const [loading, setLoading] = useState(false);

  const iconUri = (appIconUrl || logoUrl || '').trim() || null;
  const surfaceColor = appIconBgColor || primaryColor || '#0D9488';
  /** Match BrandedSplashOverlay tile scaling for consistency with splash. */
  const tileLogoScale = Math.min(1.12, Math.max(0.64, (launcherIconScale ?? 100) / 100));

  const handleContinue = async () => {
    const phone = ensurePrefix(digits);
    if (!phone || digits.replace(/\D/g, '').length < 9) {
      Alert.alert(copy.error, copy.invalidPhone);
      return;
    }
    setLoading(true);
    try {
      await authApi.sendOtp(phone, merchantId);
      router.push({ pathname: '/(auth)/otp', params: { phone } });
    } catch (err) {
      Alert.alert(copy.error, err instanceof Error ? err.message : copy.sendCodeFailed);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container className="justify-center" backgroundColor={backgroundColor}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="items-center mb-8">
            {iconUri ? (
              <View style={styles.logoStage}>
                <View style={[styles.logoGlow, { backgroundColor: surfaceColor }]} />
                <View style={[styles.logoTile, { backgroundColor: surfaceColor }]}>
                  <MerchantLogoImage
                    uri={iconUri}
                    sizeDp={72}
                    scaleFactor={tileLogoScale}
                    transition={200}
                    accessibilityLabel={brandName}
                  />
                </View>
              </View>
            ) : (
              <View style={styles.logoStage}>
                <View style={[styles.logoGlow, { backgroundColor: surfaceColor }]} />
                <View style={[styles.logoTile, { backgroundColor: surfaceColor }]}>
                  <Text style={{ color: textColor || '#ffffff', fontSize: 28, fontWeight: '700' }}>
                    {brandName.charAt(0).toUpperCase()}
                  </Text>
                </View>
              </View>
            )}
            <Text
              className="text-3xl font-bold text-center px-2"
              style={{ color: textColor }}
            >
              {t('welcome', { brand: brandName })}
            </Text>
            <Text className="text-gray-500 mt-2 text-center" style={{ textAlign: isArabic ? 'right' : 'center', alignSelf: 'stretch' }}>{copy.intro}</Text>
          </View>

          <View className="w-full mb-4">
            <Text className="text-gray-700 mb-2 font-medium" style={{ textAlign: isArabic ? 'right' : 'left' }}>{copy.phoneNumber}</Text>
            <View
              className="items-center border rounded-xl border-gray-200 bg-gray-50 px-4"
              style={{ minHeight: 52, flexDirection: isArabic ? 'row-reverse' : 'row' }}
            >
              <View style={{ height: 52, alignItems: 'center', flex: 1, flexDirection: isArabic ? 'row-reverse' : 'row' }}>
                <View style={{ justifyContent: 'center', paddingTop: 2 }}>
                  <Text className="text-gray-700 font-medium text-base" style={{ lineHeight: 20, fontSize: 16 }}>{PHONE_PREFIX} </Text>
                </View>
                <TextInput
                  placeholder="5XX XXX XXXX"
                  placeholderTextColor="#64748b"
                  value={digits}
                  onChangeText={(tx) => setDigits(tx.replace(/\D/g, '').slice(0, 9))}
                  keyboardType="phone-pad"
                  className="flex-1 text-gray-900 font-medium"
                  style={{
                    paddingVertical: 0,
                    paddingHorizontal: 8,
                    height: 52,
                    fontSize: 16,
                    lineHeight: 20,
                    textAlign: isArabic ? 'right' : 'left',
                    writingDirection: isArabic ? 'rtl' : 'ltr',
                    ...(Platform.OS === 'android' && { textAlignVertical: 'center' as const }),
                  }}
                />
              </View>
            </View>
          </View>

          <Button
            title={copy.continue}
            onPress={handleContinue}
            isLoading={loading}
            className="mt-4"
          />

          <View className="flex-row justify-center mt-6">
            <Text className="text-gray-600 text-center" style={{ textAlign: isArabic ? 'right' : 'center' }}>{copy.smsNotice}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Container>
  );
}

const styles = StyleSheet.create({
  logoStage: {
    width: 168,
    height: 168,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  logoGlow: {
    position: 'absolute',
    width: 156,
    height: 156,
    borderRadius: 44,
    opacity: 0.12,
  },
  logoTile: {
    width: 128,
    height: 128,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
});
