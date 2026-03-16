/**
 * Expo config plugin: Adds Apple Pay entitlement to iOS project.
 * - com.apple.developer.in-app-payments: required for Apple Pay
 * Note: PKPassLibrary.addPasses() does NOT require pass-type-identifiers entitlement.
 * @see docs/APPLE_PAY_SETUP.md
 */
const { withEntitlementsPlist } = require('@expo/config-plugins');

function withApplePayEntitlement(config, props = {}) {
  const merchantId = props.merchantId || 'merchant.com.nooks';
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.in-app-payments'] = [merchantId];
    return cfg;
  });
}

module.exports = withApplePayEntitlement;
