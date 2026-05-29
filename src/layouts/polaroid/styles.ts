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
  surface: '#ffffff',       // white polaroid card
  text: '#f0e2c8',          // cream text on dark bg
  textOnSurface: 'rgba(26,14,6,0.7)', // dark mono text on white cards
  accent: '#e07b3a',        // warm terracotta
  stampRed: '#c8370a',      // deep red for stamps / discount badges
} as const;

export type PolaroidColors = {
  bg: string;
  surface: string;
  text: string;
  textOnSurface: string;
  accent: string;
  stampRed: string;
};

/** Read polaroid color tokens from MerchantBranding.layoutColors with defaults.
 *
 *  `surface` (the polaroid photo-paper color) is intentionally LOCKED to
 *  white. It's a core part of the polaroid design language — the iconic
 *  white instant-photo frame. Letting merchants edit it produced blue
 *  "broken" polaroid cards in field testing. Other tokens (bg, text,
 *  accent, etc.) remain fully customizable. */
export function resolvePolaroidColors(layoutColors: Record<string, string>): PolaroidColors {
  return {
    bg: layoutColors.bg ?? POLAROID_DEFAULT_COLORS.bg,
    surface: POLAROID_DEFAULT_COLORS.surface,
    text: layoutColors.text ?? POLAROID_DEFAULT_COLORS.text,
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
 * Deterministic small rotation for a card based on its index.
 * Alternates between four angles so a 2-column grid never has
 * two adjacent cards at the same rotation.
 */
export function rotationForIndex(index: number): string {
  const angles = ['-1.5deg', '1.2deg', '-0.8deg', '1deg'];
  return angles[index % angles.length];
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
