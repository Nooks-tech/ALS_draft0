/**
 * Expo config plugin: Adds Apple Pay + Apple Wallet (PassKit) entitlements to iOS project.
 * - com.apple.developer.in-app-payments: required for Apple Pay
 * - com.apple.developer.pass-type-identifiers: required for PKPassLibrary.addPasses()
 * @see docs/APPLE_PAY_SETUP.md
 */
const { withEntitlementsPlist } = require('@expo/config-plugins');

function withApplePayEntitlement(config, props = {}) {
  const merchantId = props.merchantId || 'merchant.com.als';
  const passTypeId = props.passTypeId || 'pass.space.nooks.loyalty';
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.in-app-payments'] = [merchantId];
    cfg.modResults['com.apple.developer.pass-type-identifiers'] = [passTypeId];
    return cfg;
  });
}

module.exports = withApplePayEntitlement;
