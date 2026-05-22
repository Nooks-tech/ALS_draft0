/**
 * Payment-processing overlay — option 6 "heartbeat / EKG line".
 *
 * Layout: a sheet covers the bottom third of the screen. Above it,
 * a translucent dimmer absorbs taps so the user can't interact
 * with the checkout / wallet page underneath while a payment is in
 * flight, but the upper two-thirds of the page stays visible. No
 * full-screen takeover.
 *
 * Animation: an SVG path containing five heartbeat-shaped beats
 * laid out across a wide canvas (1000px). The canvas translates
 * leftward at a constant rate. Because every beat in the path is
 * identical, when the animation reaches half-width and resets, the
 * silhouette looks unchanged — the loop is seamless.
 *
 * Visual signal: an EKG-style line says "transaction live, vital
 * signs OK" without words and without payment-specific imagery
 * (no credit card, no coin) but with clearly purposeful motion
 * — the user reads "something monitored is happening."
 *
 * No <Modal> used — absolutely-positioned <View> at zIndex 9999
 * so the same component works whether the parent is a Modal
 * (wallet-modal sheet) or a plain page (checkout). Previous Modal-
 * based version failed to mount on checkout for that reason.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export type PaymentProcessingOverlayProps = {
  visible: boolean;
  /** Kept for API parity with previous versions. Unused (no text). */
  isArabic?: boolean;
  primaryColor?: string;
  title?: string;
  subtitle?: string;
};

// One heartbeat over 200px width, baseline at y=80 in a 160-tall
// viewBox. The pattern is the classic QRS complex stylised down to
// six segments: flat, small P bump, flat, sharp R spike up, S dip
// below baseline, T bump, flat. Width chosen so five beats fit in a
// 1000-wide canvas; the right half (beats 3-4) mirrors the left
// half (beats 0-1) so the seamless loop reset is invisible.
const BEAT_WIDTH = 200;
const BEAT_COUNT = 5;
const TOTAL_WIDTH = BEAT_WIDTH * BEAT_COUNT;
// We scroll exactly half the width so the wrap-around lands on an
// identical waveform position. The render still shows the full
// width with overflow:hidden clipping outside the sheet.
const SCROLL_DISTANCE = TOTAL_WIDTH / 2;

function buildBeatPath(): string {
  const baseline = 80;
  const segments: string[] = [`M 0 ${baseline}`];
  for (let i = 0; i < BEAT_COUNT; i += 1) {
    const x = i * BEAT_WIDTH;
    // Flat lead-in
    segments.push(`L ${x + 60} ${baseline}`);
    // Small P-wave bump up
    segments.push(`L ${x + 70} ${baseline - 8}`);
    segments.push(`L ${x + 80} ${baseline}`);
    // Flat
    segments.push(`L ${x + 90} ${baseline}`);
    // Q small dip down
    segments.push(`L ${x + 95} ${baseline + 6}`);
    // R tall spike up
    segments.push(`L ${x + 102} ${baseline - 50}`);
    // S deep dip below baseline
    segments.push(`L ${x + 110} ${baseline + 30}`);
    // Recovery to baseline
    segments.push(`L ${x + 118} ${baseline}`);
    // Flat
    segments.push(`L ${x + 135} ${baseline}`);
    // Small T-wave bump up
    segments.push(`L ${x + 150} ${baseline - 6}`);
    segments.push(`L ${x + 165} ${baseline}`);
    // Flat trailing into the next beat's lead-in
    segments.push(`L ${x + BEAT_WIDTH} ${baseline}`);
  }
  return segments.join(' ');
}

const BEAT_PATH = buildBeatPath();

export function PaymentProcessingOverlay({
  visible,
  primaryColor = '#0f766e',
}: PaymentProcessingOverlayProps) {
  const translate = useRef(new Animated.Value(0)).current;
  // Sheet slide-in. Starts at full sheet height below the screen and
  // animates to 0 (resting position) when `visible` flips true.
  const slideIn = useRef(new Animated.Value(0)).current;

  const screenHeight = Dimensions.get('window').height;
  // Lower third of the screen — clamped to a minimum so the EKG line
  // has room on very small devices.
  const sheetHeight = Math.max(240, Math.round(screenHeight * 0.33));

  useEffect(() => {
    if (!visible) {
      // Snap the slide-in back so the next open animates fresh.
      slideIn.setValue(0);
      return;
    }
    // EKG scroll loop. translate ranges 0 → -SCROLL_DISTANCE then
    // resets. 3.2s feels like a calm resting heart rate at this
    // beat-spacing (~75 BPM equivalent perception).
    const scrollLoop = Animated.loop(
      Animated.timing(translate, {
        toValue: -SCROLL_DISTANCE,
        duration: 3200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    // Sheet slide-up — single one-shot animation, not looped.
    const slideUp = Animated.timing(slideIn, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    scrollLoop.start();
    slideUp.start();
    return () => {
      scrollLoop.stop();
      slideUp.stop();
    };
  }, [visible, translate, slideIn]);

  if (!visible) return null;

  // Sheet starts off-screen below, slides to 0.
  const sheetTranslateY = slideIn.interpolate({
    inputRange: [0, 1],
    outputRange: [sheetHeight, 0],
  });
  // Backdrop fades in alongside the sheet.
  const backdropOpacity = slideIn.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  return (
    <View pointerEvents="auto" style={styles.root}>
      {/* Backdrop covers the upper portion. Captures taps so the
          checkout page isn't tappable underneath. Subtle dimming —
          the page stays mostly visible. */}
      <Animated.View
        pointerEvents="auto"
        style={[styles.backdrop, { opacity: backdropOpacity }]}
      />
      {/* Bottom sheet. Pinned to the bottom edge, slides up on mount. */}
      <Animated.View
        style={[
          styles.sheet,
          {
            height: sheetHeight,
            transform: [{ translateY: sheetTranslateY }],
          },
        ]}
      >
        {/* Small handle bar at the top of the sheet — purely visual,
            doesn't dismiss. Signals "this is a sheet" so the layout
            reads as intentional rather than a stuck modal. */}
        <View style={styles.handle} />

        {/* EKG canvas. overflow:hidden clips the wide SVG so only
            the portion inside the sheet width is visible. The SVG
            is animated leftward inside this clip. */}
        <View style={styles.ekgClip}>
          <Animated.View
            style={{
              width: TOTAL_WIDTH,
              height: 160,
              transform: [{ translateX: translate }],
            }}
          >
            <Svg width={TOTAL_WIDTH} height={160} viewBox={`0 0 ${TOTAL_WIDTH} 160`}>
              <Path
                d={BEAT_PATH}
                stroke={primaryColor}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </Svg>
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    // High z-index so the overlay sits above page content. The
    // absolute View approach (vs a Modal) means we can't rely on
    // native portaling, so zIndex + elevation do the lifting.
    zIndex: 9999,
    elevation: 9999,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    // Very light dim — the upper page stays clearly readable. We
    // mostly want to absorb taps, not theatrically darken.
    backgroundColor: 'rgba(15, 23, 42, 0.18)',
  },
  sheet: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    // Soft lift off the page below.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 14,
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#e2e8f0',
    marginBottom: 8,
  },
  ekgClip: {
    width: '100%',
    height: 160,
    overflow: 'hidden',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
});
