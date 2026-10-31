const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");
const path = require("path");

const projectRoot = __dirname;
const appNodeModulesRoot = path.resolve(projectRoot, "node_modules");
const appSrcRoot = path.resolve(projectRoot, "src");
const isWatchdogBuild = process.env.PASEO_WATCHDOG_BUILD === "1";
const isFdroidBuild = process.env.PASEO_FDROID_BUILD === "1";
const fdroidModuleOverrides = {
  "expo-camera": path.resolve(appSrcRoot, "fdroid/expo-camera.tsx"),
  "expo-notifications": path.resolve(appSrcRoot, "fdroid/expo-notifications.ts"),
};
const customWebPlatform = (process.env.PASEO_WEB_PLATFORM ?? "")
  .trim()
  .replace(/^\./, "")
  .toLowerCase();

const config = getDefaultConfig(projectRoot);
<<<<<<< HEAD
// Metro validates source and transformer keys inside this store. CI reuses it
// between exports; exact final bundles have a separate source-keyed cache.
if (process.env.E2E_METRO_CACHE) {
  const { FileStore } = require("metro-cache");
  config.cacheStores = [new FileStore({ root: process.env.E2E_METRO_CACHE })];
}
config.watchFolders = [
  ...new Set([
    ...(config.watchFolders ?? []),
    path.resolve(projectRoot, "../../control/orca-organization/client"),
    path.resolve(projectRoot, "../../control/orca-organization/shared"),
  ]),
];
=======
config.cacheVersion = isWatchdogBuild ? "watchdog" : "standard";
>>>>>>> refs/remotes/upstream/tags/v0.14.0
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;

// Keep app exports deterministic across dev machines and CI. Metro's Watchman
// crawler behavior depends on the host Watchman build/capabilities, while the
// node crawler is the path used when Watchman is absent.
config.resolver.useWatchman = false;

const escapedAppSrcRoot = appSrcRoot
  .split(path.sep)
  .map((segment) => segment.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"))
  .join("[\\\\/]");
const pathSeparatorPattern = "[\\\\/]";

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  react: path.join(appNodeModulesRoot, "react"),
  "react-dom": path.join(appNodeModulesRoot, "react-dom"),
  "react/jsx-runtime": path.join(appNodeModulesRoot, "react/jsx-runtime"),
  "react/jsx-dev-runtime": path.join(appNodeModulesRoot, "react/jsx-dev-runtime"),
};
config.resolver.blockList = new RegExp(
  `(^${escapedAppSrcRoot}${pathSeparatorPattern}.*\\.(test|spec)\\.(ts|tsx)$|${pathSeparatorPattern}__tests__${pathSeparatorPattern}.*)$`,
);

function isLocalModuleImport(moduleName) {
  return (
    moduleName.startsWith("./") ||
    moduleName.startsWith("../") ||
    moduleName.startsWith("@/") ||
    path.isAbsolute(moduleName)
  );
}

function resolveWithCustomWebOverlay(context, moduleName, platform) {
  const shouldResolveCustomWebVariant =
    platform === "web" &&
    customWebPlatform.length > 0 &&
    customWebPlatform !== "web" &&
    isLocalModuleImport(moduleName);

  if (shouldResolveCustomWebVariant) {
    const overlayContext = {
      ...context,
      // Resolve only "<custom-platform>.<ext>" variants in overlay mode.
      sourceExts: context.sourceExts.map((ext) => `${customWebPlatform}.${ext}`),
      preferNativePlatform: false,
    };

    try {
      return defaultResolveRequest(overlayContext, moduleName, null);
    } catch {
      // Ignore overlay misses and continue with normal web resolution.
    }
  }

  return defaultResolveRequest(context, moduleName, platform);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    isWatchdogBuild &&
    platform === "android" &&
    /[/\\]Renderer[/\\]shims[/\\]/.test(context.originModulePath) &&
    /implementations\/(ReactFabric|ReactNativeRenderer)-prod$/.test(moduleName)
  ) {
    return defaultResolveRequest(context, moduleName.replace(/-prod$/, "-profiling"), platform);
  }
  if (isFdroidBuild && platform === "android" && fdroidModuleOverrides[moduleName]) {
    return resolveWithCustomWebOverlay(context, fdroidModuleOverrides[moduleName], platform);
  }

  return resolveWithCustomWebOverlay(context, moduleName, platform);
};

if (process.env.PASEO_SERVE_SIM_PREVIEW === "1") {
  const { simMiddleware } = require("serve-sim/middleware");
  const originalEnhanceMiddleware = config.server?.enhanceMiddleware;
  config.server = config.server ?? {};
  config.server.enhanceMiddleware = (metroMiddleware, server) => {
    const middleware = originalEnhanceMiddleware
      ? originalEnhanceMiddleware(metroMiddleware, server)
      : metroMiddleware;
    const serveSimulator = simMiddleware({
      basePath: "/.sim",
      device: process.env.PASEO_SERVE_SIM_DEVICE_UDID,
    });
    return (req, res, next) => {
      serveSimulator(req, res, (error) => {
        if (error) {
          if (next) {
            next(error);
            return;
          }
          throw error;
        }
        middleware(req, res, next);
      });
    };
  };
}

module.exports = config;
