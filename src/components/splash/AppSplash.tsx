/**
 * The single splash component used everywhere in the app:
 *
 *   - Cold start (mounted in app/_layout.tsx): renders until the
 *     merchant branding has loaded, then fades out. Hides the
 *     native splash screen on its first layout pass so the
 *     hand-off is seamless.
 *   - Language switch (mounted in app/(tabs)/more.tsx): renders
 *     while `visible` is true, which the toggle handler holds
 *     for the ~1.5 s window before Updates.reloadAsync.
 *
 * Visual: merchant icon dropped directly on the merchant
 * background, with three pulsing dots near the bottom. No tinted
 * tile, no glow ring — the icon just floats on the bg, identical
 * in both contexts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, StyleSheet, Text, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { MerchantLogoImage } from '../branding/MerchantLogoImage';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

const COLD_START_MIN_VISIBLE_MS = 900;

type AppSplashProps = {
  /**
   * - `'cold-start'`: stay visible until branding is loaded AND
   *   the minimum visible time has passed; release the native
   *   splash on the first layout pass.
   * - `'overlay'`: visibility is driven entirely by the parent
   *   via the `visible` prop. Used for the language-switch
   *   transition; no native splash interaction.
   */
  mode: 'cold-start' | 'overlay';
  visible?: boolean;
};

export function AppSplash({ mode, visible }: AppSplashProps) {
  const branding = useMerchantBranding();
  const {
    primaryColor,
    backgroundColor,
    appIconUrl,
    logoUrl,
    appName,
    cafeName,
    textColor,
    tabTextColor,
    launcherIconScale,
    loading,
  } = branding;

  const [minTimePassed, setMinTimePassed] = useState(false);
  const [coldStartDone, setColdStartDone] = useState(false);
  const fadeOpacity = useRef(new Animated.Value(1)).current;
  const nativeHidden = useRef(false);

  // Cold-start min visible timer. Doesn't run in overlay mode.
  useEffect(() => {
    if (mode !== 'cold-start') return;
    const t = setTimeout(() => setMinTimePassed(true), COLD_START_MIN_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [mode]);

  // Cold-start dismissal once branding is ready and min time
  // has elapsed. Fades out smoothly so the menu paint isn't a
  // hard cut.
  useEffect(() => {
    if (mode !== 'cold-start') return;
    if (loading || !minTimePassed || coldStartDone) return;
    Animated.timing(fadeOpacity, {
      toValue: 0,
      duration: 320,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setColdStartDone(true));
  }, [mode, loading, minTimePassed, coldStartDone, fadeOpacity]);

  const releaseNativeSplash = useCallback(() => {
    if (mode !== 'cold-start' || nativeHidden.current) return;
    nativeHidden.current = true;
    SplashScreen.hideAsync().catch(() => {
      // Already hidden — ignore.
    });
  }, [mode]);

  const isVisible =
    mode === 'cold-start' ? !coldStartDone : Boolean(visible);

  if (!isVisible) return null;

  const splashBg = backgroundColor || '#0d9488';
  const dotColor = primaryColor || textColor || tabTextColor || '#ffffff';
  const splashLogoUri = appIconUrl || logoUrl;
  // Logo size adapts to the merchant's launcher icon scale; clamp
  // so a bad value can't push the icon to 0 px or past the screen.
  const logoBase = 140;
  const tileLogoScale = Math.min(1.2, Math.max(0.6, (launcherIconScale ?? 100) / 100));

  const body = (
    <Animated.View
      onLayout={mode === 'cold-start' ? releaseNativeSplash : undefined}
      style={[
        StyleSheet.absoluteFillObject,
        {
          backgroundColor: splashBg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: mode === 'cold-start' ? fadeOpacity : 1,
        },
      ]}
    >
      {splashLogoUri ? (
        <MerchantLogoImage
          uri={splashLogoUri}
          sizeDp={logoBase}
          scaleFactor={tileLogoScale}
          accessibilityLabel="Logo"
        />
      ) : (
        <Text
          style={{
            color: textColor || tabTextColor || '#ffffff',
            fontSize: 26,
            fontWeight: '700',
            textAlign: 'center',
            paddingHorizontal: 32,
          }}
        >
          {appName?.trim() || cafeName?.trim() || ''}
        </Text>
      )}
      <View style={styles.dots}>
        <PulsingDots color={dotColor} />
      </View>
    </Animated.View>
  );

  // Cold start renders inline (above the Stack via z-index in
  // _layout.tsx). Overlay mode wraps in a transparent Modal so
  // the layer floats above whatever screen is currently visible
  // when the language toggle is invoked.
  if (mode === 'overlay') {
    return (
      <Modal visible animationType="none" transparent statusBarTranslucent>
        {body}
      </Modal>
    );
  }
  return body;
}

function PulsingDots({ color }: { color: string }) {
  // Three Animated values each running their own loop with a
  // staggered delay produces the classic 'wave of dots' loader.
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
    const loops = [pulse(a1, 0), pulse(a2, 140), pulse(a3, 280)];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [a1, a2, a3]);

  return (
    <View style={styles.dotRow}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a1 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a2 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a3 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { position: 'absolute', bottom: '19%', left: 0, right: 0, alignItems: 'center' },
  dotRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
