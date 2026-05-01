/**
 * Full-screen splash shown during the language toggle's bundle
 * reload. Same visual identity as BrandedSplashOverlay (merchant
 * icon on a tinted tile + three pulsing dots) but driven by an
 * external `visible` flag instead of the branding-loading lifecycle,
 * so we can keep it on screen for the deliberate ~600 ms beat
 * before Updates.reloadAsync detonates the JS bundle.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, StyleSheet, Text, View } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { MerchantLogoImage } from '../branding/MerchantLogoImage';

type Props = {
  visible: boolean;
};

export function LanguageTransitionSplash({ visible }: Props) {
  const {
    primaryColor,
    backgroundColor,
    appIconBgColor,
    appIconUrl,
    logoUrl,
    appName,
    cafeName,
    textColor,
    tabTextColor,
    launcherIconScale,
  } = useMerchantBranding();

  const splashBg = backgroundColor || '#f5f5f4';
  const surfaceColor = appIconBgColor || primaryColor || '#0D9488';
  const splashLogoUri = appIconUrl || logoUrl;
  const fg = textColor || tabTextColor || '#ffffff';
  const tileLogoScale = Math.min(1.12, Math.max(0.64, (launcherIconScale ?? 100) / 100));

  return (
    // transparent + animationType="none". With transparent={false},
    // iOS treats the modal as a separate UIViewController and there
    // are layout reflows around its frame that briefly reveal the
    // host view while the bundle is reloading. transparent={true}
    // mounts the modal as an overlay on the existing view tree —
    // no separate view controller, no reflow, no flash. The inner
    // absolute View paints the same merchant bg corner-to-corner.
    <Modal visible={visible} animationType="none" transparent statusBarTranslucent>
      <View style={[StyleSheet.absoluteFillObject, { backgroundColor: splashBg, alignItems: 'center', justifyContent: 'center' }]}>
        {splashLogoUri ? (
          // No tile / glow — the merchant icon paints directly on
          // the merchant background. Matches BrandedSplashOverlay
          // so the cold-start splash and the language-switch splash
          // are visually identical.
          <MerchantLogoImage
            uri={splashLogoUri}
            sizeDp={140}
            scaleFactor={tileLogoScale}
            accessibilityLabel="Logo"
          />
        ) : (
          <Text style={{ color: fg, fontSize: 26, fontWeight: '700', textAlign: 'center', paddingHorizontal: 32 }}>
            {appName?.trim() || cafeName?.trim() || ''}
          </Text>
        )}
        <View style={styles.dots}>
          <PulsingDots color={surfaceColor} active={visible} />
        </View>
      </View>
    </Modal>
  );
}

function PulsingDots({ color, active }: { color: string; active: boolean }) {
  // Three Animated values driven by separate looping sequences with
  // staggered delays — produces the wave-of-dots effect without
  // requiring reanimated.
  const a1 = useRef(new Animated.Value(0.35)).current;
  const a2 = useRef(new Animated.Value(0.35)).current;
  const a3 = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    if (!active) return;
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
  }, [a1, a2, a3, active]);

  return (
    <View style={styles.dotRow}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a1 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a2 }]} />
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity: a3 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  logoStage: { width: 224, height: 224, alignItems: 'center', justifyContent: 'center' },
  logoGlow: { position: 'absolute', width: 210, height: 210, borderRadius: 60, opacity: 0.12 },
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
    elevation: 12,
  },
  dots: { position: 'absolute', bottom: '19%', left: 0, right: 0, alignItems: 'center' },
  dotRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
