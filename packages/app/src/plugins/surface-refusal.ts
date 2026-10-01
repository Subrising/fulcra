import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";

type SurfaceConnection = Pick<
  HostRuntimeSnapshot,
  "authFailureReason" | "pairingRequired" | "lastError" | "connectionStatus"
>;

// Only host-owned typed reasons and exact preflight messages earn a specific diagnosis.
export function pluginConnectionRefusal(snapshot: SurfaceConnection | null): string | null {
  if (!snapshot) return null;
  if (snapshot.pairingRequired) return "This host requires pairing. Connect it from Settings.";
  if (snapshot.authFailureReason === "password_required") {
    return "This host requires its configured password. Connect it from Settings.";
  }
  if (snapshot.authFailureReason === "incorrect_password") {
    return "This host refused the configured password. Update it in Settings.";
  }
  if (snapshot.lastError === "Desktop daemon authentication unavailable. Retry from Settings.") {
    return "Desktop daemon authentication is unavailable. Retry from Settings.";
  }
  if (snapshot.lastError === "Desktop daemon is starting or unavailable. Retrying.") {
    return "Desktop daemon is starting or unavailable. Retry the connection.";
  }
  if (snapshot.lastError || snapshot.connectionStatus === "error") {
    return "The plugin host connection is unavailable. Retry the connection.";
  }
  if (snapshot.connectionStatus === "offline") return "The plugin host is offline.";
  return null;
}

export function pluginSurfaceUnavailable(
  connectionReason: string | null,
  evaluationFailed: boolean,
  hasSurface: boolean,
): string {
  if (connectionReason) return connectionReason;
  if (evaluationFailed) return "This plugin could not be loaded.";
  return hasSurface ? "The plugin host is unavailable." : "This plugin surface is unavailable.";
}
