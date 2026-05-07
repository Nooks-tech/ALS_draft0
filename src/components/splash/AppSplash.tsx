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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, StyleSheet, Text, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { MerchantLogoImage } from '../branding/MerchantLogoImage';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { useMenuContext } from '../../context/MenuContext';

// How long the cold-start splash stays on screen at minimum.
// 2000 ms reads as a deliberate splash and gives the merchant
// branding a proper moment of focus before the menu paints. It's
// also enough time for the warmup coordinator to land the menu
// fetch + offers banners + loyalty/wallet from cache.
const COLD_START_MIN_VISIBLE_MS = 2000;
// Hard ceiling — even if branding/menu never resolve (offline first
// install with no cache), the splash MUST eventually let the user in
// rather than trapping them on the loading screen. 4 s is the
// product-side cap requested by ops: long enough for the menu fetch
// on a slow Saudi 4G link, short enough that a permanently offline
// device still gets to the menu rather than feeling stuck.
const COLD_START_MAX_VISIBLE_MS = 4000;

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
  // useMenuContext is only safe to call when MenuProvider is mounted
  // above this component. _layout.tsx hoists MenuProvider above
  // AppSplash for that reason. Reading menu.hydrated lets the splash
  // hold itself visible until the menu has at least *attempted* its
  // cache load, so the user doesn't see a teal-background-empty-menu
  // flash between splash fade and first paint.
  const menu = useMenuContext();

  const [minTimePassed, setMinTimePassed] = useState(false);
  const [maxTimePassed, setMaxTimePassed] = useState(false);
  const [coldStartDone, setColdStartDone] = useState(false);
  const fadeOpacity = useRef(new Animated.Value(1)).current;
  const nativeHidden = useRef(false);

  // Cold-start min/max visible timers. Don't run in overlay mode.
  useEffect(() => {
    if (mode !== 'cold-start') return;
    const minT = setTimeout(() => setMinTimePassed(true), COLD_START_MIN_VISIBLE_MS);
    const maxT = setTimeout(() => setMaxTimePassed(true), COLD_START_MAX_VISIBLE_MS);
    return () => {
      clearTimeout(minT);
      clearTimeout(maxT);
    };
  }, [mode]);

  // Cold-start dismissal: fade out once we have something real to
  // show underneath (branding + menu hydrated AND min time elapsed),
  // OR the max-wait ceiling is hit (so a permanently broken network
  // doesn't trap the user on the splash).
  useEffect(() => {
    if (mode !== 'cold-start' || coldStartDone) return;
    const readyToFade =
      maxTimePassed ||
      (minTimePassed && !loading && menu.hydrated);
    if (!readyToFade) return;
    Animated.timing(fadeOpacity, {
      toValue: 0,
      duration: 320,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setColdStartDone(true));
  }, [mode, loading, minTimePassed, maxTimePassed, menu.hydrated, coldStartDone, fadeOpacity]);

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
  // surfaceColor = the rounded tile's color. Prefer the merchant's
  // explicit app-icon-bg; fall back to primary so the tile reads as
  // 'their brand' instead of being colorless.
  const surfaceColor = branding.appIconBgColor || primaryColor || '#0D9488';
  const tileLogoScale = Math.min(1.12, Math.max(0.64, (launcherIconScale ?? 100) / 100));

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
        // Rounded merchant-colored tile with a soft glow ring,
        // logo centered inside. Matches the language-change
        // splash visual exactly so the cold-start splash and the
        // language-switch splash are identical.
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

  // BOTH modes wrap in a transparent Modal so the splash floats
  // above the navigation Stack. Returning `body` inline used to be
  // the cold-start path, but the JSX position of <AppSplash /> in
  // _layout.tsx is BEFORE <Stack>, which means React Native renders
  // the Stack on top in the same parent tree — the cold-start
  // splash has been silently invisible since the splash refactor.
  // The user only ever saw the NATIVE iOS launch storyboard for
  // ~1 s while the JS bundle loaded; the JS-rendered logo + pulsing
  // dots overlay never appeared. A Modal is a sibling-of-everything
  // native overlay (UIModalPresentation.fullScreen on iOS), so it
  // sits above whatever the navigation stack is rendering, exactly
  // like the overlay-mode language-switch path always has.
  return (
    <Modal visible animationType="none" transparent statusBarTranslucent>
      {body}
    </Modal>
  );
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
  // Rounded merchant tile sized like an iOS app icon (~176 dp) with
  // a 44 dp corner radius. The glow ring sits behind it at ~10%
  // opacity to lift it off the merchant background.
  logoStage: {
    width: 224,
    height: 224,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoGlow: {
    position: 'absolute',
    width: 210,
    height: 210,
    borderRadius: 60,
    opacity: 0.12,
  },
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
