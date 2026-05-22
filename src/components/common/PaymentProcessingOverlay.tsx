/**
 * Full-screen processing overlay — option 9 "pulsing gradient blob".
 *
 * Three overlapping organic shapes, each with asymmetric per-corner
 * border-radius (the CSS "blob" trick), animated with independent
 * scale + rotation loops at different durations. Their overlap +
 * brand-colour gradients create a constantly-morphing amoeba feel
 * without any new dependencies (uses expo-linear-gradient which is
 * already installed for other parts of the app).
 *
 * Switched from a nested <Modal> to an absolutely-positioned <View>
 * because the previous Modal-based overlay rendered correctly only
 * when wrapped inside another Modal (wallet-modal worked, checkout
 * didn't). An absolute View at zIndex 9999 portals reliably in both
 * contexts.
 *
 * No text by design — "simple and abstract" per the brief. The blob
 * animation alone signals that something is happening; nothing
 * language-dependent to translate, nothing implementation-specific
 * to leak.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export type PaymentProcessingOverlayProps = {
  visible: boolean;
  /** Kept for API parity with previous version; unused now (no text). */
  isArabic?: boolean;
  primaryColor?: string;
  /** Kept for API parity; unused now. */
  title?: string;
  /** Kept for API parity; unused now. */
  subtitle?: string;
};

export function PaymentProcessingOverlay({
  visible,
  primaryColor = '#0f766e',
}: PaymentProcessingOverlayProps) {
  // Three separate scale + rotation values so the blobs don't sync up.
  // Different periods (2.4s / 2.8s / 3.2s for scale; 9s / 11s / 13s
  // for rotation) ensure the silhouette never repeats exactly — the
  // overlap looks "alive" instead of mechanical.
  const blob1Scale = useRef(new Animated.Value(1)).current;
  const blob1Rot = useRef(new Animated.Value(0)).current;
  const blob2Scale = useRef(new Animated.Value(1.1)).current;
  const blob2Rot = useRef(new Animated.Value(0)).current;
  const blob3Scale = useRef(new Animated.Value(0.95)).current;
  const blob3Rot = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    const sine = Easing.inOut(Easing.sin);
    const loops = [
      Animated.loop(
        Animated.sequence([
          Animated.timing(blob1Scale, { toValue: 1.2, duration: 2400, easing: sine, useNativeDriver: true }),
          Animated.timing(blob1Scale, { toValue: 0.95, duration: 2400, easing: sine, useNativeDriver: true }),
        ]),
      ),
      Animated.loop(
        Animated.timing(blob1Rot, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: true }),
      ),
      Animated.loop(
        Animated.sequence([
          Animated.timing(blob2Scale, { toValue: 0.85, duration: 2800, easing: sine, useNativeDriver: true }),
          Animated.timing(blob2Scale, { toValue: 1.1, duration: 2800, easing: sine, useNativeDriver: true }),
        ]),
      ),
      Animated.loop(
        Animated.timing(blob2Rot, { toValue: 1, duration: 11000, easing: Easing.linear, useNativeDriver: true }),
      ),
      Animated.loop(
        Animated.sequence([
          Animated.timing(blob3Scale, { toValue: 1.15, duration: 3200, easing: sine, useNativeDriver: true }),
          Animated.timing(blob3Scale, { toValue: 0.9, duration: 3200, easing: sine, useNativeDriver: true }),
        ]),
      ),
      Animated.loop(
        Animated.timing(blob3Rot, { toValue: 1, duration: 13000, easing: Easing.linear, useNativeDriver: true }),
      ),
    ];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [visible, blob1Scale, blob1Rot, blob2Scale, blob2Rot, blob3Scale, blob3Rot]);

  if (!visible) return null;

  const rot1 = blob1Rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  // Negative direction for blob 2 — opposing rotations make the
  // silhouette swirl rather than just orbit.
  const rot2 = blob2Rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });
  const rot3 = blob3Rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  // Brand-color gradient stops at varying opacities. The hex-with-
  // alpha suffix (#RRGGBBAA) lets us tint a single primary color
  // without needing to compute lighter/darker shades at runtime.
  const c100 = primaryColor;
  const c60 = `${primaryColor}99`; // ~60% opacity
  const c30 = `${primaryColor}4d`; // ~30% opacity

  return (
    <View
      // pointerEvents="auto" so taps don't fall through to the screen
      // underneath while a payment is in flight.
      pointerEvents="auto"
      style={styles.backdrop}
    >
      <View style={styles.blobContainer}>
        <Animated.View
          style={[
            styles.blob,
            {
              width: 170,
              height: 170,
              // Asymmetric per-corner radii are what create the
              // organic blob shape. Each blob's corners are tuned
              // independently — the eye reads three different
              // amoebas rather than three rotated copies of one.
              borderTopLeftRadius: 110,
              borderTopRightRadius: 70,
              borderBottomLeftRadius: 60,
              borderBottomRightRadius: 95,
              opacity: 0.55,
              transform: [{ scale: blob1Scale }, { rotate: rot1 }],
            },
          ]}
        >
          <LinearGradient
            colors={[c100, c60]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.blob,
            {
              width: 190,
              height: 190,
              borderTopLeftRadius: 55,
              borderTopRightRadius: 115,
              borderBottomLeftRadius: 100,
              borderBottomRightRadius: 65,
              opacity: 0.5,
              transform: [{ scale: blob2Scale }, { rotate: rot2 }],
            },
          ]}
        >
          <LinearGradient
            colors={[c60, c100]}
            start={{ x: 1, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.blob,
            {
              width: 150,
              height: 150,
              borderTopLeftRadius: 75,
              borderTopRightRadius: 105,
              borderBottomLeftRadius: 95,
              borderBottomRightRadius: 50,
              opacity: 0.45,
              transform: [{ scale: blob3Scale }, { rotate: rot3 }],
            },
          ]}
        >
          <LinearGradient
            colors={[c30, c100]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFillObject}
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Translucent dark backdrop so the underlying screen darkens but
    // stays faintly visible — the user can still see they're on the
    // checkout page, just frozen.
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    // High z-index + elevation so the overlay sits above every other
    // child in the parent tree on both platforms. The previous Modal-
    // based approach skipped this — Modals portal to the root window
    // — but the new absolute-positioned View needs it explicitly.
    zIndex: 9999,
    elevation: 9999,
  },
  blobContainer: {
    width: 240,
    height: 240,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blob: {
    position: 'absolute',
    overflow: 'hidden',
  },
});
