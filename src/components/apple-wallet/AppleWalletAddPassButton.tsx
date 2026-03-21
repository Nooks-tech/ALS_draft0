/**
 * iOS-only native `PKAddPassButton` (traditional Apple "Add to Apple Wallet" control).
 * Registered on the ExpoWallet module; Android returns null.
 */
import { requireNativeViewManager } from 'expo-modules-core';
import * as React from 'react';
import { Platform, ViewProps } from 'react-native';

export type AppleWalletAddPassButtonProps = ViewProps & {
  onWalletButtonPress?: (event: { nativeEvent: Record<string, unknown> }) => void;
};

let NativeView: React.ComponentType<AppleWalletAddPassButtonProps> | null = null;

if (Platform.OS === 'ios') {
  try {
    NativeView = requireNativeViewManager('ExpoWallet');
  } catch {
    NativeView = null;
  }
}

export function AppleWalletAddPassButton(props: AppleWalletAddPassButtonProps) {
  if (!NativeView) return null;
  return <NativeView {...props} />;
}
