/**
 * Full-screen overlay that appears while a payment is being confirmed
 * with Moyasar (or while a zero-charge commit is talking to the
 * backend). The previous UI showed a tiny ActivityIndicator inside the
 * Pay button — easy to miss on Apple Pay where the native button has
 * no spinner at all. This component is the consistent visual feedback
 * the user explicitly asked for.
 *
 * Renders nothing when `visible` is false. When true, mounts a Modal
 * with a translucent backdrop, a centered card with the merchant's
 * primary colour as the spinner accent, and bilingual copy.
 *
 * Uses while-payment-is-confirming:
 *   - app/checkout.tsx pay button (card / wallet / cashback / stamps)
 *   - app/checkout.tsx Apple Pay handler (during Moyasar verify)
 *   - app/wallet-modal.tsx top-up flows (card + Apple Pay + saved-card)
 */

import React from 'react';
import { ActivityIndicator, Modal, Text, View } from 'react-native';

export type PaymentProcessingOverlayProps = {
  visible: boolean;
  isArabic?: boolean;
  primaryColor?: string;
  /**
   * Optional override for the title text. Leave undefined to use the
   * default localized "Processing payment" copy.
   */
  title?: string;
  /**
   * Optional override for the secondary line. Defaults to a localized
   * "Confirming with your bank" that suits both card and Apple Pay.
   */
  subtitle?: string;
};

export function PaymentProcessingOverlay({
  visible,
  isArabic = false,
  primaryColor = '#0f766e',
  title,
  subtitle,
}: PaymentProcessingOverlayProps) {
  const defaultTitle = isArabic ? 'جاري معالجة الدفع' : 'Processing payment';
  const defaultSubtitle = isArabic
    ? 'نتحقق من عملية الدفع — لا تُغلق التطبيق.'
    : "Confirming your payment — please don't close the app.";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // statusBarTranslucent so the backdrop covers the status bar on
      // Android and the overlay doesn't look like it has a stripe at
      // the top.
      statusBarTranslucent
      // No onRequestClose handler — backdrop is intentionally
      // non-dismissable while a payment is in flight. The hardware
      // back button on Android is also blocked.
      onRequestClose={() => {}}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(15, 23, 42, 0.55)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 24,
        }}
      >
        <View
          style={{
            backgroundColor: '#ffffff',
            borderRadius: 28,
            paddingHorizontal: 32,
            paddingVertical: 36,
            alignItems: 'center',
            // Subtle shadow so the card lifts off the dimmed
            // background. The iOS / Android shadow props differ; both
            // are set so it looks right on either platform.
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.18,
            shadowRadius: 24,
            elevation: 10,
            minWidth: 260,
            maxWidth: '90%',
          }}
        >
          <View
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: `${primaryColor}1a`, // 10% tint of primary
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}
          >
            <ActivityIndicator size="large" color={primaryColor} />
          </View>
          <Text
            style={{
              color: '#0f172a',
              fontSize: 18,
              fontWeight: '700',
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            {title ?? defaultTitle}
          </Text>
          <Text
            style={{
              color: '#475569',
              fontSize: 14,
              textAlign: 'center',
              lineHeight: 20,
            }}
          >
            {subtitle ?? defaultSubtitle}
          </Text>
        </View>
      </View>
    </Modal>
  );
}
