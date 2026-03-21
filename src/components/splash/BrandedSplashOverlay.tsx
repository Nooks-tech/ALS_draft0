/**
 * Full-screen branded splash shown until merchant branding is loaded,
 * then fades out smoothly before native splash is hidden.
 */
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';

const MIN_VISIBLE_MS = 380;

type BrandedSplashOverlayProps = {
  /** Called after native splash is hidden (e.g. request notification permissions). */
  onDismiss?: () => void;
};

export function BrandedSplashOverlay({ onDismiss }: BrandedSplashOverlayProps) {
  const { loading, primaryColor, logoUrl, tabTextColor, cafeName } = useMerchantBranding();
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [finished, setFinished] = useState(false);

  const containerOpacity = useRef(new Animated.Value(1)).current;
  const logoScale = useRef(new Animated.Value(0.92)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setTimeout(() => setMinTimePassed(true), MIN_VISIBLE_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(logoScale, {
        toValue: 1,
        friction: 7,
        tension: 80,
        useNativeDriver: true,
      }),
    ]).start();
  }, [logoOpacity, logoScale]);

  useEffect(() => {
    if (loading || !minTimePassed || finished) return;

    Animated.timing(containerOpacity, {
      toValue: 0,
      duration: 420,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      void SplashScreen.hideAsync().then(() => {
        onDismiss?.();
      });
      setFinished(true);
    });
  }, [loading, minTimePassed, finished, containerOpacity, onDismiss]);

  if (finished) return null;

  const fg = tabTextColor || '#ffffff';

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        {
          zIndex: 99999,
          elevation: 99999,
          backgroundColor: primaryColor,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: containerOpacity,
        },
      ]}
    >
      <Animated.View style={{ opacity: logoOpacity, transform: [{ scale: logoScale }], alignItems: 'center' }}>
        {logoUrl ? (
          <Image
            source={{ uri: logoUrl }}
            style={{ width: 132, height: 132 }}
            resizeMode="contain"
            accessibilityLabel="Logo"
          />
        ) : (
          <Text style={{ color: fg, fontSize: 26, fontWeight: '700', textAlign: 'center', paddingHorizontal: 32 }}>
            {cafeName?.trim() || ''}
          </Text>
        )}
      </Animated.View>
      <View style={styles.dots} accessibilityElementsHidden>
        <SubtleDots color={fg} />
      </View>
    </Animated.View>
  );
}

function SubtleDots({ color }: { color: string }) {
  const a1 = useRef(new Animated.Value(0.35)).current;
  const a2 = useRef(new Animated.Value(0.35)).current;
  const a3 = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const pulse = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.35, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      );
    const l1 = pulse(a1, 0);
    const l2 = pulse(a2, 140);
    const l3 = pulse(a3, 280);
    l1.start();
    l2.start();
    l3.start();
    return () => {
      l1.stop();
      l2.stop();
      l3.stop();
    };
  }, [a1, a2, a3]);

  const dot = (a: Animated.Value) => (
    <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a }]} />
  );

  return (
    <View style={styles.dotRow}>
      {dot(a1)}
      {dot(a2)}
      {dot(a3)}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: {
    position: 'absolute',
    bottom: '18%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  dotRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
