/**
 * Polaroid layout shared design tokens + style helpers.
 *
 * The mobile renderer reads color tokens from
 * `branding.layoutColors` (server-merged defaults + merchant
 * overrides). When a key is missing we fall back to the spec
 * defaults defined here. This mirrors the polaroid CSS variables
 * in nooksweb/tmp/layouts-cleaned.html (`.po-*` classes).
 */
import { Platform, TextStyle, ViewStyle } from 'react-native';

export const POLAROID_DEFAULT_COLORS = {
  bg: '#1e1508',            // dark kraft paper
  headerBg: '#140d04',      // top header bar (matches bottom tab bar by default)
  surface: '#ffffff',       // white polaroid card
  text: '#f0e2c8',          // cream text on dark bg (header)
  categoryText: '#f0e2c8',  // menu category section titles (+ count & divider)
  textOnSurface: 'rgba(26,14,6,0.7)', // dark mono text on white cards
  accent: '#e07b3a',        // warm terracotta
  stampRed: '#c8370a',      // deep red for stamps / discount badges
} as const;

export type PolaroidColors = {
  bg: string;
  headerBg: string;
  surface: string;
  text: string;
  categoryText: string;
  textOnSurface: string;
  accent: string;
  stampRed: string;
};

/** Read polaroid color tokens from MerchantBranding.layoutColors with defaults. */
export function resolvePolaroidColors(layoutColors: Record<string, string>): PolaroidColors {
  return {
    bg: layoutColors.bg ?? POLAROID_DEFAULT_COLORS.bg,
    headerBg: layoutColors.headerBg ?? layoutColors.tabBarBg ?? layoutColors.bg ?? POLAROID_DEFAULT_COLORS.headerBg,
    surface: layoutColors.surface ?? POLAROID_DEFAULT_COLORS.surface,
    text: layoutColors.text ?? POLAROID_DEFAULT_COLORS.text,
    categoryText: layoutColors.categoryText ?? layoutColors.text ?? POLAROID_DEFAULT_COLORS.categoryText,
    textOnSurface: layoutColors.textOnSurface ?? POLAROID_DEFAULT_COLORS.textOnSurface,
    accent: layoutColors.accent ?? POLAROID_DEFAULT_COLORS.accent,
    stampRed: layoutColors.stampRed ?? POLAROID_DEFAULT_COLORS.stampRed,
  };
}

export const POLAROID_FONT = {
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) ?? 'monospace',
  serif: Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' }) ?? 'serif',
};

/** Reusable shadow snippet for white polaroid cards. */
export const POLAROID_SHADOW: ViewStyle = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.35,
  shadowRadius: 8,
  elevation: 6,
};

/** Deeper shadow for full-width hero cards (offers, profile). */
export const POLAROID_SHADOW_LG: ViewStyle = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.4,
  shadowRadius: 14,
  elevation: 10,
};

/**
 * Card rotation by index. Tilt removed 2026-05-31 (founder request) — polaroid
 * cards/boxes now sit straight & symmetrical. Helper + signature kept so every
 * caller stays unchanged; it just always returns a no-tilt transform.
 */
export function rotationForIndex(_index: number): string {
  return '0deg';
}

/** Caption / label mono text style preset. */
export function monoCaption(color: string, size = 11, tracking = 0.5): TextStyle {
  return {
    fontFamily: POLAROID_FONT.mono,
    fontSize: size,
    color,
    letterSpacing: tracking,
  };
}
