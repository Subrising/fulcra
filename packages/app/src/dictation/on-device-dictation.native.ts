import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { OnDeviceDictation } from "./on-device-dictation";

interface SpeechModule {
  startOnDeviceDictation(locale: string): Promise<boolean>;
  appendOnDeviceDictation(base64: string): void;
  finishOnDeviceDictation(): Promise<string>;
  cancelOnDeviceDictation(): void;
  addListener(name: string, callback: (value: { text: string }) => void): { remove(): void };
}
export function createOnDeviceDictation(): OnDeviceDictation | null {
  if (Platform.OS !== "ios") return null;
  const speech = requireOptionalNativeModule<SpeechModule>("ExpoTwoWayAudio");
  if (!speech?.startOnDeviceDictation) return null;
  let subscription: { remove(): void } | null = null;
  return {
    async start(locale, onPartial) {
      subscription?.remove();
      subscription = speech.addListener("onDictationPartial", (value) => onPartial(value.text));
      try {
        const ready = await speech.startOnDeviceDictation(locale);
        if (!ready) {
          subscription?.remove();
          subscription = null;
        }
        return ready;
      } catch {
        subscription?.remove();
        subscription = null;
        return false;
      }
    },
    append: (base64) => speech.appendOnDeviceDictation(base64),
    finish: () => speech.finishOnDeviceDictation(),
    cancel() {
      subscription?.remove();
      subscription = null;
      speech.cancelOnDeviceDictation();
    },
  };
}
