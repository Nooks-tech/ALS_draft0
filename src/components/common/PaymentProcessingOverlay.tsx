/**
 * Payment-processing overlay — EKG heartbeat in a floating bottom card,
 * with an optional order-summary block below the line.
 *
 * Layout: a card pinned near the bottom of the screen with horizontal
 * and bottom margins (it floats, not pinned to the edge). Inside,
 * top-to-bottom: handle, EKG line, divider, items list, divider,
 * location. A translucent dimmer covers everything above to absorb
 * taps. The page underneath stays visible.
 *
 * orderSummary is optional. Checkout passes it; wallet topup doesn't,
 * in which case the card shrinks to just handle + EKG.
 *
 * No <Modal> — absolutely-positioned <View> at zIndex 9999 so the
 * same component works whether the parent is a Modal (wallet-modal
 * sheet) or a plain page (checkout).
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { MapPin } from 'lucide-react-native';

export type PaymentProcessingOrderItem = {
  name: string;
  quantity: number;
};

export type PaymentProcessingOrderSummary = {
  items: PaymentProcessingOrderItem[];
  /** 'delivery' → "Deliver to <address>"; anything else → "Pickup from <branch>". */
  orderType: 'pickup' | 'delivery' | 'drivethru' | string;
  locationLabel: string;
};

export type PaymentProcessingOverlayProps = {
  visible: boolean;
  isArabic?: boolean;
  primaryColor?: string;
  /** Order summary block — shown below the EKG. Omit to render a
   *  shorter card with just the line (used by wallet topup). */
  orderSummary?: PaymentProcessingOrderSummary;
};

// EKG geometry. One QRS-complex beat per BEAT_WIDTH px. Five beats
// laid out across TOTAL_WIDTH; we scroll exactly half of that and
// loop — the silhouette at scroll-end matches scroll-start so the
// reset is invisible.
const BEAT_WIDTH = 200;
const BEAT_COUNT = 5;
const TOTAL_WIDTH = BEAT_WIDTH * BEAT_COUNT;
const SCROLL_DISTANCE = TOTAL_WIDTH / 2;

// Tighter viewBox than the previous version so the line fills an
// 80-tall container without empty vertical room. Baseline y=40,
// spike up to y=8, dip down to y=64.
const VIEW_HEIGHT = 80;

function buildBeatPath(): string {
  const baseline = 40;
  const segments: string[] = [`M 0 ${baseline}`];
  for (let i = 0; i < BEAT_COUNT; i += 1) {
    const x = i * BEAT_WIDTH;
    // Flat lead-in
    segments.push(`L ${x + 60} ${baseline}`);
    // Small P-wave bump up
    segments.push(`L ${x + 70} ${baseline - 5}`);
    segments.push(`L ${x + 80} ${baseline}`);
    // Flat
    segments.push(`L ${x + 90} ${baseline}`);
    // Q small dip down
    segments.push(`L ${x + 95} ${baseline + 4}`);
    // R tall spike up
    segments.push(`L ${x + 102} ${baseline - 32}`);
    // S dip below baseline
    segments.push(`L ${x + 110} ${baseline + 24}`);
    // Recovery to baseline
    segments.push(`L ${x + 118} ${baseline}`);
    // Flat
    segments.push(`L ${x + 135} ${baseline}`);
    // Small T-wave bump up
    segments.push(`L ${x + 150} ${baseline - 4}`);
    segments.push(`L ${x + 165} ${baseline}`);
    // Flat trailing into next beat's lead-in
    segments.push(`L ${x + BEAT_WIDTH} ${baseline}`);
  }
  return segments.join(' ');
}

const BEAT_PATH = buildBeatPath();

// Max items rendered in the list before we collapse the rest into
// a "+ N more" row — keeps the card a predictable height for big
// carts and avoids needing a scroll view inside the sheet.
const MAX_VISIBLE_ITEMS = 3;

export function PaymentProcessingOverlay({
  visible,
  isArabic = false,
  primaryColor = '#0f766e',
  orderSummary,
}: PaymentProcessingOverlayProps) {
  const translate = useRef(new Animated.Value(0)).current;
  const slideIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      slideIn.setValue(0);
      return;
    }
    const scrollLoop = Animated.loop(
      Animated.timing(translate, {
        toValue: -SCROLL_DISTANCE,
        duration: 3200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const slideUp = Animated.timing(slideIn, {
      toValue: 1,
      duration: 280,
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

  // Slide-in from below. 500px is enough to be off-screen on any
  // device since the card itself never exceeds ~360px tall.
  const sheetTranslateY = slideIn.interpolate({
    inputRange: [0, 1],
    outputRange: [500, 0],
  });
  const backdropOpacity = slideIn.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const visibleItems = orderSummary?.items.slice(0, MAX_VISIBLE_ITEMS) ?? [];
  const hiddenCount = orderSummary
    ? Math.max(0, orderSummary.items.length - MAX_VISIBLE_ITEMS)
    : 0;
  const isDelivery = orderSummary?.orderType === 'delivery';
  const isCurbside = orderSummary?.orderType === 'drivethru';
  // Header label flips per order type: delivery shows the address,
  // curbside ("Receive from your car") shows the branch, pickup
  // shows the branch. Each gets its own verb so the user knows the
  // overlay reflects what they actually picked.
  const locationHeader = isDelivery
    ? (isArabic ? 'التوصيل إلى' : 'DELIVER TO')
    : isCurbside
      ? (isArabic ? 'استلام من السيارة' : 'CAR PICKUP AT')
      : (isArabic ? 'الاستلام من' : 'PICKUP FROM');
  const rowDir: 'row' | 'row-reverse' = isArabic ? 'row-reverse' : 'row';
  const txtAlign: 'left' | 'right' = isArabic ? 'right' : 'left';

  return (
    <View pointerEvents="auto" style={styles.root}>
      <Animated.View
        pointerEvents="auto"
        style={[styles.backdrop, { opacity: backdropOpacity }]}
      />
      <Animated.View
        style={[
          styles.card,
          { transform: [{ translateY: sheetTranslateY }] },
        ]}
      >
        <View style={styles.handle} />

        {/* EKG canvas — clipped width with the SVG translating
            leftward inside it. */}
        <View style={styles.ekgClip}>
          <Animated.View
            style={{
              width: TOTAL_WIDTH,
              height: VIEW_HEIGHT,
              transform: [{ translateX: translate }],
            }}
          >
            <Svg
              width={TOTAL_WIDTH}
              height={VIEW_HEIGHT}
              viewBox={`0 0 ${TOTAL_WIDTH} ${VIEW_HEIGHT}`}
            >
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

        {orderSummary && (
          <>
            <View style={styles.divider} />

            {/* Items list. Each row: name on one side, "× qty" on
                the other. Direction flips for Arabic. */}
            <View style={styles.itemsBlock}>
              {visibleItems.map((it, idx) => (
                <View
                  key={`${it.name}-${idx}`}
                  style={[styles.itemRow, { flexDirection: rowDir }]}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.itemName, { textAlign: txtAlign }]}
                  >
                    {it.name}
                  </Text>
                  <Text style={styles.itemQty}>× {it.quantity}</Text>
                </View>
              ))}
              {hiddenCount > 0 && (
                <Text
                  style={[styles.moreLine, { textAlign: txtAlign }]}
                >
                  {isArabic
                    ? `+ ${hiddenCount} عنصر آخر`
                    : `+ ${hiddenCount} more`}
                </Text>
              )}
            </View>

            <View style={styles.divider} />

            {/* Location row. MapPin icon, header label above the
                actual address/branch name. */}
            <View style={[styles.locationRow, { flexDirection: rowDir }]}>
              <MapPin size={18} color={primaryColor} />
              <View style={styles.locationText}>
                <Text style={[styles.locationHeader, { textAlign: txtAlign }]}>
                  {locationHeader}
                </Text>
                <Text
                  numberOfLines={2}
                  style={[styles.locationValue, { textAlign: txtAlign }]}
                >
                  {orderSummary.locationLabel || '—'}
                </Text>
              </View>
            </View>
          </>
        )}
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
    alignItems: 'center',
    zIndex: 9999,
    elevation: 9999,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.22)',
  },
  card: {
    // Floating card — horizontal margins + lifted off the bottom
    // edge so it doesn't read as "stuck" to the screen.
    width: '92%',
    marginBottom: 32,
    backgroundColor: '#ffffff',
    borderRadius: 24,
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 22,
    elevation: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#e2e8f0',
    marginBottom: 6,
  },
  ekgClip: {
    width: '100%',
    height: VIEW_HEIGHT,
    overflow: 'hidden',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e2e8f0',
    marginVertical: 12,
  },
  itemsBlock: {
    gap: 6,
  },
  itemRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
    marginRight: 12,
    marginLeft: 12,
  },
  itemQty: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  moreLine: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
    marginTop: 2,
  },
  locationRow: {
    alignItems: 'flex-start',
    gap: 10,
  },
  locationText: {
    flex: 1,
  },
  locationHeader: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94a3b8',
    letterSpacing: 1,
  },
  locationValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 2,
  },
});
