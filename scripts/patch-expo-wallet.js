const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', '@giulio987', 'expo-wallet', 'ios', 'ExpoWalletModule.swift');
const patch = path.join(__dirname, '..', 'patches', 'ExpoWalletModule.swift');

if (fs.existsSync(path.dirname(target)) && fs.existsSync(patch)) {
  fs.copyFileSync(patch, target);
  console.log('[patch-expo-wallet] Patched ExpoWalletModule.swift');
} else {
  console.log('[patch-expo-wallet] Skipped (target or patch not found)');
}
