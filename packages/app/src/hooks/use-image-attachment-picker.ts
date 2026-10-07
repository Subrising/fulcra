import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  normalizePickedImageAssets,
  pickImagesWithDesktopDialog,
  type PickedImageAttachmentInput,
} from "@/hooks/image-attachment-picker";
import { isWeb } from "@/constants/platform";

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  takePhoto: () => Promise<PickedImageAttachmentInput[] | null>;
}

export function useImageAttachmentPicker(): UseImageAttachmentPickerResult {
  const { t } = useTranslation();
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
  const isPickingRef = useRef(false);

  const ensurePermission = useCallback(async () => {
    let currentPermission = mediaPermission;

    if (
      !currentPermission ||
      currentPermission.status === ImagePicker.PermissionStatus.UNDETERMINED
    ) {
      currentPermission = await requestMediaPermission();
    } else if (!currentPermission.granted) {
      currentPermission = await requestMediaPermission();
    }

    if (!currentPermission?.granted) {
      Alert.alert(
        t("imageAttachmentPicker.permissionTitle"),
        t("imageAttachmentPicker.permissionMessage"),
      );
      return false;
    }

    return true;
  }, [mediaPermission, requestMediaPermission, t]);

  const pick = useCallback(
    async (source: "library" | "camera") => {
      if (isPickingRef.current) {
        return null;
      }

      isPickingRef.current = true;

      try {
        if (source === "library" && isWeb && isElectronRuntime()) {
          const selectedImages = await pickImagesWithDesktopDialog(getDesktopHost()?.dialog);
          if (selectedImages.length === 0) {
            return null;
          }
          return selectedImages;
        }

        let hasPermission;
        if (source === "camera") {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          hasPermission = permission.granted;
          if (!hasPermission) {
            Alert.alert(
              t("imageAttachmentPicker.permissionTitle"),
              t("imageAttachmentPicker.cameraPermissionMessage"),
            );
          }
        } else {
          hasPermission = await ensurePermission();
        }
        if (!hasPermission) {
          return null;
        }

        const pendingResult = await ImagePicker.getPendingResultAsync();
        if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
          return await normalizePickedImageAssets(pendingResult.assets);
        }

        const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.8 };
        const result =
          source === "camera"
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync({
                ...options,
                allowsMultipleSelection: true,
              });

        if (result.canceled) {
          return null;
        }

        return await normalizePickedImageAssets(result.assets);
      } catch (error) {
        console.error("[ImageAttachmentPicker] Failed to pick image:", error);
        const message =
          source === "camera"
            ? "imageAttachmentPicker.failedToTakePhoto"
            : "imageAttachmentPicker.failedToSelect";
        Alert.alert(t("imageAttachmentPicker.errorTitle"), t(message));
        return null;
      } finally {
        isPickingRef.current = false;
      }
    },
    [ensurePermission, t],
  );

  const pickImages = useCallback(() => pick("library"), [pick]);
  const takePhoto = useCallback(() => pick("camera"), [pick]);
  return { pickImages, takePhoto };
}
