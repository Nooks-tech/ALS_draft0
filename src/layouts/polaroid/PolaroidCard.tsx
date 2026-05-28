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
import { POLAROID_FONT, POLAROID_SHADOW, POLAROID_SHADOW_LG } from './styles';

export type PolaroidCardProps = {
  children: React.ReactNode;
  /** Rotation in CSS degrees, e.g. "-1.5deg". Defaults to 0. */
  rotation?: string;
  /** Use a heavier shadow (for hero cards). */
  large?: boolean;
  surfaceColor?: string;
  style?: StyleProp<ViewStyle>;
};

export function PolaroidCard({
  children,
  rotation = '0deg',
  large = false,
  surfaceColor = '#ffffff',
  style,
}: PolaroidCardProps) {
  return (
    <View
      style={[
        {
          backgroundColor: surfaceColor,
          borderRadius: 4,
          transform: [{ rotate: rotation }],
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
