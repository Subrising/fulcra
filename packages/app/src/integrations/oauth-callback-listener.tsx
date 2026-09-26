import { useEffect } from "react";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { forwardOAuthCallback } from "./oauth-callback";

// The connected hosts that have the shared credential store (server_info.features.credentials).
export function credentialClients() {
  const store = getHostRuntimeStore();
  const sessions = useSessionStore.getState().sessions;
  return store
    .getHosts()
    .filter((host) => sessions[host.serverId]?.serverInfo?.features?.credentials === true)
    .map((host) => store.getClient(host.serverId))
    .filter((client): client is NonNullable<typeof client> => client !== null);
}

// Desktop: the main process forwards `fulcra://oauth/<flowId>` links here (event "oauth-callback").
// Mobile builds reach the same forwarder through the /oauth/[flowId] route.
export function OAuthCallbackListener() {
  const receive = useStableEvent((payload: unknown) => {
    void forwardOAuthCallback(payload, credentialClients()).then((outcome) => {
      if (outcome.status === "failed") console.warn("[integrations] sign-in link not completed");
      return undefined;
    });
  });
  useEffect(() => {
    if (typeof getDesktopHost()?.events?.on !== "function") return;
    let dispose: (() => void) | null = null;
    let disposed = false;
    void listenToDesktopEvent<unknown>("oauth-callback", receive).then((off) => {
      if (disposed) off();
      else dispose = off;
      return undefined;
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [receive]);
  return null;
}
