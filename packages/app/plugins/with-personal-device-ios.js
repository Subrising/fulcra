const { withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

// Personal Apple teams cannot provision remote push. Run after notification
// plugins so an inferred Expo plugin cannot leave aps-environment behind.
module.exports = function withPersonalDeviceIos(config) {
  config = withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    return modConfig;
  });
  return withInfoPlist(config, (modConfig) => {
    const modes = modConfig.modResults.UIBackgroundModes;
    if (Array.isArray(modes)) {
      modConfig.modResults.UIBackgroundModes = modes.filter(
        (mode) => mode !== "remote-notification",
      );
    }
    return modConfig;
  });
};
