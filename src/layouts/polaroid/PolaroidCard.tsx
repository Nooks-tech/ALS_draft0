/**
 * Shared "polaroid card" primitive — a white rounded surface
 * with a subtle shadow and a small rotation. Every product,
 * offer, order, and settings row in the Polaroid layout is a
 * PolaroidCard.
 *
 * Rotation is intentionally NOT mirrored for RTL — it's an
 * aesthetic flourish, not a directional cue.
 */
import React from 'react';
import { Platform, StyleProp, Text, TextStyle, View, ViewStyle } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import { POLAROID_DEFAULT_COLORS, POLAROID_FONT, POLAROID_SHADOW, POLAROID_SHADOW_LG, resolvePolaroidColors } from './styles';

export type PolaroidCardProps = {
  children: React.ReactNode;
  /** No-op since 2026-05-31: polaroid cards are kept straight & symmetrical.
   *  Retained so existing call sites compile; the value is ignored. */
  rotation?: string;
  /** Use a heavier shadow (for hero cards). */
  large?: boolean;
  /** Explicit override (e.g. order-type uses accent). When omitted,
   *  reads from the merchant's polaroid `surface` token so merchants
   *  can color-customize the photo paper through layout_colors_override. */
  surfaceColor?: string;
  style?: StyleProp<ViewStyle>;
};

export function PolaroidCard({
  children,
  large = false,
  surfaceColor,
  style,
}: PolaroidCardProps) {
  const branding = useMerchantBranding();
  const themed = resolvePolaroidColors(branding.layoutColors || {});
  const bg = surfaceColor ?? themed.surface ?? POLAROID_DEFAULT_COLORS.surface;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: 4,
        },
        large ? POLAROID_SHADOW_LG : POLAROID_SHADOW,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type MonoTextProps = {
  children: React.ReactNode;
  /** Font size in px. */
  size?: number;
  /** Letter-spacing in px. */
  tracking?: number;
  color?: string;
  weight?: TextStyle['fontWeight'];
  uppercase?: boolean;
  align?: TextStyle['textAlign'];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
};

/**
 * Mono text convenience component. Uses system mono (Menlo on
 * iOS, monospace on Android) — see styles.ts for rationale. The
 * uppercase + tracking combo is what gives the polaroid spec its
 * "small caption typed on a label maker" feel.
 */
export function MonoText({
  children,
  size = 11,
  tracking = 0.5,
  color,
  weight,
  uppercase = false,
  align,
  style,
  numberOfLines,
}: MonoTextProps) {
  const baseStyle: TextStyle = {
    fontFamily: POLAROID_FONT.mono,
    fontSize: size,
    letterSpacing: tracking,
    ...(color ? { color } : {}),
    ...(weight ? { fontWeight: weight } : {}),
    ...(uppercase ? { textTransform: 'uppercase' as const } : {}),
    ...(align ? { textAlign: align } : {}),
    // iOS letter-spacing on monospace tends to render heavier;
    // Android monospace is already wide so this just keeps things
    // visually consistent on both platforms.
    ...(Platform.OS === 'ios' ? {} : {}),
  };
  return (
    <Text style={[baseStyle, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}
