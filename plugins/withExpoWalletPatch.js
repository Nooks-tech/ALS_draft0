/**
 * Expo config plugin that patches @giulio987/expo-wallet Swift module
 * to use PKAddPassesViewController (native "Add to Wallet" sheet),
 * PKAddPassButton for the official wallet button UI,
 * and include real iOS error messages in rejections.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PATCHED_SWIFT_PATH = path.join(__dirname, '..', 'patches', 'ExpoWalletModule.swift');

function getPatchedSwift() {
  return fs.readFileSync(PATCHED_SWIFT_PATH, 'utf-8');
}

function withExpoWalletPatch(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const patchedSwift = getPatchedSwift();
      const podsDir = path.join(cfg.modRequest.platformProjectRoot, 'Pods');
      const targetPath = path.join(
        podsDir,
        'ExpoWallet',
        'ios',
        'ExpoWalletModule.swift'
      );

      const altPaths = [
        path.join(cfg.modRequest.platformProjectRoot, '..', 'node_modules', '@giulio987', 'expo-wallet', 'ios', 'ExpoWalletModule.swift'),
      ];

      for (const p of [targetPath, ...altPaths]) {
        if (fs.existsSync(p)) {
          console.log(`[withExpoWalletPatch] Patching: ${p}`);
          fs.writeFileSync(p, patchedSwift, 'utf-8');
        }
      }

      return cfg;
    },
  ]);
}

module.exports = withExpoWalletPatch;
