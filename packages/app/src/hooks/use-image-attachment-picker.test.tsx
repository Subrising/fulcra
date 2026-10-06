/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PickedImageAttachmentInput } from "./image-attachment-picker";

const picker = vi.hoisted(() => ({
  cameraPermission: vi.fn(),
  libraryPermission: vi.fn(),
  camera: vi.fn(),
  library: vi.fn(),
  pending: vi.fn(),
  normalize: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("expo-image-picker", () => ({
  PermissionStatus: { UNDETERMINED: "undetermined" },
  useMediaLibraryPermissions: () => [
    { status: "denied", granted: false },
    picker.libraryPermission,
  ],
  requestCameraPermissionsAsync: picker.cameraPermission,
  launchCameraAsync: picker.camera,
  launchImageLibraryAsync: picker.library,
  getPendingResultAsync: picker.pending,
}));
vi.mock("react-native", () => ({ Alert: { alert: picker.alert } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/platform", () => ({ isWeb: false }));
vi.mock("@/desktop/host", () => ({ isElectronRuntime: () => false, getDesktopHost: () => null }));
vi.mock("@/hooks/image-attachment-picker", () => ({
  normalizePickedImageAssets: picker.normalize,
  pickImagesWithDesktopDialog: vi.fn(),
}));
import { useImageAttachmentPicker } from "./use-image-attachment-picker";

const assets = [{ uri: "file:///capture.jpg", width: 40, height: 40 }];
const normalized: PickedImageAttachmentInput[] = [
  {
    source: { kind: "file_uri", uri: "file:///normalized.png" },
    fileName: "normalized.png",
    mimeType: "image/png",
  },
];
beforeEach(() => {
  vi.resetAllMocks();
  picker.cameraPermission.mockResolvedValue({ granted: true });
  picker.libraryPermission.mockResolvedValue({ granted: true });
  picker.pending.mockResolvedValue(null);
  picker.camera.mockResolvedValue({ canceled: false, assets });
  picker.library.mockResolvedValue({ canceled: false, assets });
  picker.normalize.mockResolvedValue(normalized);
});

describe("useImageAttachmentPicker native camera", () => {
  it("captures without photo-library access and uses the same attachment normalization", async () => {
    const { result } = renderHook(() => useImageAttachmentPicker());
    await act(async () => {
      expect(await result.current.takePhoto()).toEqual(normalized);
    });
    expect(picker.cameraPermission).toHaveBeenCalledOnce();
    expect(picker.libraryPermission).not.toHaveBeenCalled();
    expect(picker.library).not.toHaveBeenCalled();
    expect(picker.camera).toHaveBeenCalledWith({ mediaTypes: ["images"], quality: 0.8 });
    expect(picker.normalize).toHaveBeenCalledWith(assets);
  });
  it("refuses denied camera access before capture with actionable permission copy", async () => {
    picker.cameraPermission.mockResolvedValue({ granted: false });
    const { result } = renderHook(() => useImageAttachmentPicker());
    await act(async () => {
      expect(await result.current.takePhoto()).toBeNull();
    });
    expect(picker.camera).not.toHaveBeenCalled();
    expect(picker.normalize).not.toHaveBeenCalled();
    expect(picker.alert).toHaveBeenCalledWith(
      "imageAttachmentPicker.permissionTitle",
      "imageAttachmentPicker.cameraPermissionMessage",
    );
  });
  it("does not attach a canceled capture", async () => {
    picker.camera.mockResolvedValue({ canceled: true, assets: null });
    const { result } = renderHook(() => useImageAttachmentPicker());
    await act(async () => {
      expect(await result.current.takePhoto()).toBeNull();
    });
    expect(picker.normalize).not.toHaveBeenCalled();
  });
  it("reports capture failure and releases the picker for the next attempt", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    picker.camera.mockRejectedValueOnce(new Error("capture failed"));
    const { result } = renderHook(() => useImageAttachmentPicker());
    await act(async () => {
      expect(await result.current.takePhoto()).toBeNull();
    });
    expect(picker.alert).toHaveBeenCalledWith(
      "imageAttachmentPicker.errorTitle",
      "imageAttachmentPicker.failedToTakePhoto",
    );
    await act(async () => {
      expect(await result.current.takePhoto()).toEqual(normalized);
    });
    consoleError.mockRestore();
  });
  it("keeps Choose photo on the media-library path with multiple image selection", async () => {
    const { result } = renderHook(() => useImageAttachmentPicker());
    await act(async () => {
      expect(await result.current.pickImages()).toEqual(normalized);
    });
    expect(picker.libraryPermission).toHaveBeenCalledOnce();
    expect(picker.cameraPermission).not.toHaveBeenCalled();
    expect(picker.library).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsMultipleSelection: true,
    });
    expect(picker.normalize).toHaveBeenCalledWith(assets);
  });
});
