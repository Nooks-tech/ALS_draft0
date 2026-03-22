/**
 * Full-screen branded splash shown until merchant branding is loaded,
 * then fades out smoothly before native splash is hidden.
 */
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { MerchantLogoImage } from '../branding/MerchantLogoImage';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

const MIN_VISIBLE_MS = 380;

type BrandedSplashOverlayProps = {
  /** Called after native splash is hidden (e.g. request notification permissions). */
  onDismiss?: () => void;
};

export function BrandedSplashOverlay({ onDismiss }: BrandedSplashOverlayProps) {
  const {
    loading,
    primaryColor,
    backgroundColor,
    appIconBgColor,
    appIconUrl,
    logoUrl,
    tabTextColor,
    textColor,
    appName,
    cafeName,
    launcherIconScale,
  } = useMerchantBranding();
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

  const splashBg = backgroundColor || primaryColor;
  const surfaceColor = appIconBgColor || primaryColor;
  const splashLogoUri = appIconUrl || logoUrl;
  const fg = textColor || tabTextColor || '#ffffff';
  const tileLogoScale = Math.min(1.2, Math.max(0.72, (launcherIconScale ?? 100) / 100));

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        {
          zIndex: 99999,
          elevation: 99999,
          backgroundColor: splashBg,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: containerOpacity,
        },
      ]}
    >
      <Animated.View style={{ opacity: logoOpacity, transform: [{ scale: logoScale }], alignItems: 'center' }}>
        {splashLogoUri ? (
          <View style={[styles.logoTile, { backgroundColor: surfaceColor }]}>
            <MerchantLogoImage
              uri={splashLogoUri}
              sizeDp={96}
              scaleFactor={tileLogoScale}
              accessibilityLabel="Logo"
            />
          </View>
        ) : (
          <Text style={{ color: fg, fontSize: 26, fontWeight: '700', textAlign: 'center', paddingHorizontal: 32 }}>
            {appName?.trim() || cafeName?.trim() || ''}
          </Text>
        )}
      </Animated.View>
      <View style={styles.dots} accessibilityElementsHidden>
        <SubtleDots color={primaryColor || fg} />
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
  logoTile: {
    width: 156,
    height: 156,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
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
