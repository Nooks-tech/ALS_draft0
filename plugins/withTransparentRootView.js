// Expo config plugin: makes the iOS RCTRootView's backgroundColor
// transparent so the layer underneath (UIWindow + rootViewController.view,
// which expo-system-ui pins to the merchant's background color) shows
// through during the brief gap when Updates.reloadAsync tears down the
// JS bridge. Without this patch, RCTRootView's hardcoded default
// `[UIColor whiteColor]` covers the merchant bg and the customer sees
// a white flash mid-language-switch — fixable only at the native layer.
//
// Patches AppDelegate.swift after the rootView/RCTRootView is created
// to set its backgroundColor to .clear. Idempotent: the patch line
// includes a marker comment so re-applying the plugin is a no-op.
const { withAppDelegate } = require('@expo/config-plugins');

const MARKER = '// nooks: transparent rootView for reload-gap fix';

function withTransparentRootView(config) {
  return withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;

    // Recent Expo templates (SDK 50+) use Swift AppDelegate. Locate the
    // didFinishLaunching method and append the bg-clear after the
    // rootView is bound. The variable name is `rootView` in template
    // code; if missing, fall back to setting the window's
    // rootViewController.view bg, which is identical for our purpose.
    if (cfg.modResults.language === 'swift') {
      // Try to inject right after the line that creates rootView /
      // sets self.window.rootViewController.
      const swiftPatch = `\n    // ${MARKER.replace('// ', '')}\n    self.window?.rootViewController?.view.backgroundColor = .clear\n`;
      if (src.includes('self.window.rootViewController =')) {
        src = src.replace(
          /(self\.window\.rootViewController = [^\n]+\n)/,
          `$1${swiftPatch}`,
        );
      } else if (src.includes('self.window?.makeKeyAndVisible')) {
        src = src.replace(
          /(self\.window\?\.makeKeyAndVisible[^\n]*\n)/,
          `$1${swiftPatch}`,
        );
      }
    } else {
      // Objective-C fallback (older templates).
      const objcPatch = `\n  ${MARKER}\n  self.window.rootViewController.view.backgroundColor = [UIColor clearColor];\n`;
      if (src.includes('self.window.rootViewController =')) {
        src = src.replace(
          /(self\.window\.rootViewController = [^;]+;\n)/,
          `$1${objcPatch}`,
        );
      } else if (src.includes('[self.window makeKeyAndVisible]')) {
        src = src.replace(
          /(\[self\.window makeKeyAndVisible\];\n)/,
          `$1${objcPatch}`,
        );
      }
    }

    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = withTransparentRootView;
