const fs = require("node:fs");
const path = require("node:path");
const pkg = require("./package.json");
const withAndroidAsyncStorageSize = require("./plugins/with-android-async-storage-size");
const withAndroidProfileable = require("./plugins/with-android-profileable");
const withFdroidAutolinking = require("./plugins/with-fdroid-autolinking");
const withPasteInput = require("./plugins/with-paste-input");
const withPersonalDeviceIos = require("./plugins/with-personal-device-ios");
const withAndroidScroll = require("./modules/paseo-scroll/app.plugin");
const { getNativeReleaseVersion } = require("./native-release-version");
const appVariant = process.env.APP_VARIANT ?? "production";
const isPrivatePreview = appVariant === "private-preview";
const isPersonalDeviceIos = process.env.ORCA_IOS_PERSONAL_DEVICE === "1";
const isFdroidBuild = isPrivatePreview || process.env.PASEO_FDROID_BUILD === "1";
const isProfileBuild = process.env.PASEO_PROFILE_BUILD === "1";

const buildProfile = isFdroidBuild
  ? {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
      cameraPlugins: [],
      fdroidPlugins: [withFdroidAutolinking],
      notificationPlugins: [],
    }
  : {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "CAMERA",
        "android.permission.CAMERA",
      ],
      cameraPlugins: [
        [
          "expo-camera",
          {
            cameraPermission:
              "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
          },
        ],
      ],
      fdroidPlugins: [],
      notificationPlugins: [
        [
          "expo-notifications",
          {
            icon: "./assets/images/fulcra-v1/mark.png",
            color: "#20744A",
          },
        ],
      ],
    };

function resolveSecretFile(params) {
  const fromEnv = process.env[params.envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const fallbackAbsolutePath = path.resolve(__dirname, params.fallbackRelativePath);
  if (fs.existsSync(fallbackAbsolutePath)) {
    return params.fallbackRelativePath;
  }

  return undefined;
}

const variants = {
  "private-preview": {
    name: "Fulcra Preview",
    packageId: "dev.orca.workspace.preview",
  },
  production: {
    name: "Fulcra",
    packageId: "dev.orca.workspace",
    googleServicesFile: resolveSecretFile({
      envKey: "ORCA_GOOGLE_SERVICES_FILE_PROD",
      fallbackRelativePath: "./.secrets/orca-google-services.prod.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "ORCA_GOOGLE_SERVICE_INFO_PLIST_PROD",
      fallbackRelativePath: "./.secrets/Orca-GoogleService-Info.prod.plist",
    }),
  },
  development: {
    name: "Fulcra Debug",
    packageId: "dev.orca.workspace.debug",
    googleServicesFile: resolveSecretFile({
      envKey: "ORCA_GOOGLE_SERVICES_FILE_DEBUG",
      fallbackRelativePath: "./.secrets/orca-google-services.debug.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "ORCA_GOOGLE_SERVICE_INFO_PLIST_DEBUG",
      fallbackRelativePath: "./.secrets/Orca-GoogleService-Info.debug.plist",
    }),
  },
};

const variant = variants[appVariant] ?? variants.production;
const nativeReleaseVersion = getNativeReleaseVersion(pkg.version);

export default {
  expo: {
    name: variant.name,
    slug: "orca",
    version: nativeReleaseVersion.appVersion,
    orientation: "portrait",
    icon: "./assets/images/fulcra-v1/icon.png",
    // `fulcra` carries sign-in return links (fulcra://oauth/<flowId>, CONTRACTS §7.2); `orca` stays for existing links.
    scheme: ["orca", "fulcra"],
    userInterfaceStyle: isPrivatePreview ? "dark" : "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSSpeechRecognitionUsageDescription:
          "Fulcra uses on-device speech recognition for phone dictation when available.",
        NSMicrophoneUsageDescription: "This app needs access to the microphone for voice commands.",
        NSFaceIDUsageDescription:
          "Fulcra uses Face ID to confirm that you are the one answering a decision on this device.",
        ITSAppUsesNonExemptEncryption: false,
      },
      bundleIdentifier: isPersonalDeviceIos
        ? process.env.ORCA_IOS_BUNDLE_IDENTIFIER || variant.packageId
        : variant.packageId,
      ...(variant.googleServiceInfoPlist
        ? { googleServicesFile: variant.googleServiceInfoPlist }
        : {}),
      buildNumber: nativeReleaseVersion.iosBuildNumber,
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/images/fulcra-v1/adaptive-foreground.png",
        backgroundColor: "#181B1A",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
      // Allow HTTP connections for local network hosts (required for release builds)
      usesCleartextTraffic: true,
      permissions: buildProfile.androidPermissions,
      ...(isFdroidBuild ? { blockedPermissions: ["android.permission.CAMERA"] } : {}),
      package: variant.packageId,
      versionCode: nativeReleaseVersion.androidVersionCode,
      ...(variant.googleServicesFile ? { googleServicesFile: variant.googleServicesFile } : {}),
    },
    web: {
      output: "single",
      favicon: "./assets/images/fulcra-v1/icon.png",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "expo-router",
      withPasteInput,
      withAndroidScroll,
      [withAndroidAsyncStorageSize, 64],
      ...buildProfile.cameraPlugins,
      [
        "expo-image-picker",
        {
          photosPermission: "Allow $(PRODUCT_NAME) to attach photos to your chats.",
          cameraPermission: "Allow $(PRODUCT_NAME) to take photos to attach to your chats.",
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/images/fulcra-v1/icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#181B1A",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
      ...(isPersonalDeviceIos ? [] : buildProfile.notificationPlugins),
      "expo-audio",
      [
        "expo-gradle-jvmargs",
        {
          xmx: "4096m",
          maxMetaspace: "1024m",
        },
      ],
      [
        "expo-build-properties",
        {
          android: {
            minSdkVersion: 29,
            kotlinVersion: "2.1.20",
            // Allow HTTP connections for local network hosts in release builds
            usesCleartextTraffic: true,
          },
        },
      ],
      ...buildProfile.fdroidPlugins,
      ...(isProfileBuild ? [withAndroidProfileable] : []),
      ...(isPersonalDeviceIos ? [withPersonalDeviceIos] : []),
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      fdroidBuild: isFdroidBuild,
      profileBuild: isProfileBuild,
      router: {},
    },
  },
};
