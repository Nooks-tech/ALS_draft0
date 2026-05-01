/**
 * Full-screen branded splash shown immediately after the native splash,
 * then fades away once branding is ready.
 */
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MerchantLogoImage } from '../branding/MerchantLogoImage';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

const MIN_VISIBLE_MS = 900;

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
    launcherIconScale } = useMerchantBranding();
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [nativeSplashHidden, setNativeSplashHidden] = useState(false);

  // Logo + dots start at full opacity / final position so the
  // overlay paints fully formed the instant it mounts. This is the
  // bridge between the native splash (which hides without animating)
  // and the branded JS splash — fading in from nothing produced a
  // visible flash of white between the two and a 'wait spinner'
  // feel that the customer noticed during language switches.
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const logoScale = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(1)).current;
  const logoTranslateY = useRef(new Animated.Value(0)).current;
  const dotsOpacity = useRef(new Animated.Value(1)).current;
  const nativeHideRequested = useRef(false);

  const releaseNativeSplash = useCallback(() => {
    if (nativeHideRequested.current) return;
    nativeHideRequested.current = true;
    void SplashScreen.hideAsync()
      .catch(() => {
        // Ignore "already hidden" and similar startup timing errors.
      })
      .finally(() => setNativeSplashHidden(true));
  }, []);

  useEffect(() => {
    if (!nativeSplashHidden) return;
    const t = setTimeout(() => setMinTimePassed(true), MIN_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [nativeSplashHidden]);

  // Entrance animation removed — logo and dots are already at their
  // final values (see useRef defaults above). The dots themselves
  // animate continuously inside SubtleDots, which is the only motion
  // that needs to be visible during the language-switch hand-off.

  const handleLayout = useCallback(() => {
    releaseNativeSplash();
  }, [releaseNativeSplash]);

  useEffect(() => {
    if (!nativeSplashHidden || loading || !minTimePassed || finished) return;

    Animated.parallel([
      Animated.timing(containerOpacity, {
        toValue: 0,
        duration: 360,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true }),
      Animated.timing(dotsOpacity, {
        toValue: 0,
        duration: 220,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true }),
    ]).start(() => {
      onDismiss?.();
      setFinished(true);
    });
  }, [loading, minTimePassed, finished, containerOpacity, dotsOpacity, nativeSplashHidden, onDismiss]);

  if (finished) return null;

  const splashBg = backgroundColor || '#f5f5f4';
  const surfaceColor = appIconBgColor || primaryColor || '#0D9488';
  const splashLogoUri = appIconUrl || logoUrl;
  const fg = textColor || tabTextColor || '#ffffff';
  const tileLogoScale = Math.min(1.12, Math.max(0.64, (launcherIconScale ?? 100) / 100));

  return (
    <Animated.View
      onLayout={handleLayout}
      style={[
        StyleSheet.absoluteFillObject,
        {
          zIndex: 99999,
          elevation: 99999,
          backgroundColor: splashBg,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: containerOpacity },
      ]}
    >
      <Animated.View
        style={{
          opacity: logoOpacity,
          transform: [{ translateY: logoTranslateY }, { scale: logoScale }],
          alignItems: 'center' }}
      >
        {splashLogoUri ? (
          <View style={styles.logoStage}>
            <View style={[styles.logoGlow, { backgroundColor: surfaceColor }]} />
            <View style={[styles.logoTile, { backgroundColor: surfaceColor }]}>
              <MerchantLogoImage
                uri={splashLogoUri}
                sizeDp={94}
                scaleFactor={tileLogoScale}
                accessibilityLabel="Logo"
              />
            </View>
          </View>
        ) : (
          <Text style={{ color: fg, fontSize: 26, fontWeight: '700', textAlign: 'center', paddingHorizontal: 32 }}>
            {appName?.trim() || cafeName?.trim() || ''}
          </Text>
        )}
      </Animated.View>
      {/* Cold-start splash is intentionally calm: merchant icon on
          tile, no animated dots. Dots only appear during the
          language-switch splash (LanguageTransitionSplash) where
          the motion communicates 'something is happening' between
          two reloads. */}
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
  logoStage: {
    width: 224,
    height: 224,
    alignItems: 'center',
    justifyContent: 'center' },
  logoGlow: {
    position: 'absolute',
    width: 210,
    height: 210,
    borderRadius: 60,
    opacity: 0.12 },
  logoTile: {
    width: 176,
    height: 176,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12 },
  dots: {
    position: 'absolute',
    bottom: '19%',
    left: 0,
    right: 0,
    alignItems: 'center' },
  dotRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center' },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3 } });
