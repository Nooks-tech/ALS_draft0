/**
 * Expo config plugin: Adds Apple Pay entitlement to iOS project.
 * Required for Apple Pay to work. Merchant ID from EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID.
 * @see docs/APPLE_PAY_SETUP.md
 */
const { withEntitlementsPlist } = require('@expo/config-plugins');

function withApplePayEntitlement(config, props = {}) {
  const merchantId = props.merchantId || 'merchant.com.als';
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.in-app-payments'] = [merchantId];
    return cfg;
  });
}

module.exports = withApplePayEntitlement;
