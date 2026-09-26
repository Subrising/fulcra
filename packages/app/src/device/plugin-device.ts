import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { PluginDevice } from "@getpaseo/plugin/client";
import { createNativeDeviceKey, type NativeDeviceKeyModule } from "./device-key-adapters";

// iOS and Android: the local PaseoDeviceKey module. A build without it offers no ctx.device.
const nativeModule = requireOptionalNativeModule<NativeDeviceKeyModule>("PaseoDeviceKey");

export function getPluginDevice(): PluginDevice | undefined {
  if (!nativeModule || (Platform.OS !== "ios" && Platform.OS !== "android")) return undefined;
  return createNativeDeviceKey({ module: nativeModule, platform: Platform.OS });
}
