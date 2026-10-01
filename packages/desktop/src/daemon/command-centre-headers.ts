import type { OnBeforeSendHeadersListenerDetails, BeforeSendResponse, WebContents } from "electron";
import {
  DAEMON_AUTH_PROTOCOL_PREFIX,
  LEGACY_BEARER_PROTOCOL_PREFIX,
  daemonAuthorizationHeader,
} from "@getpaseo/protocol/daemon-credential";

/** No secret crosses IPC or a reflected WebSocket subprotocol. */
export function ownedDaemonHeaders(
  windows: Set<WebContents>,
  credential: (url: string) => Promise<string | null | undefined>,
) {
  return async (
    details: OnBeforeSendHeadersListenerDetails,
    callback: (response: BeforeSendResponse) => void,
  ): Promise<void> => {
    const headers = { ...details.requestHeaders };
    const sender = details.webContents;
    const eligible = () => {
      if (
        !sender ||
        !windows.has(sender) ||
        sender.isDestroyed() ||
        details.webContentsId !== sender.id ||
        details.resourceType !== "webSocket" ||
        !details.frame ||
        details.frame !== sender.mainFrame
      )
        return false;
      try {
        const origin = new URL(details.frame.url);
        if (
          origin.protocol !== "paseo:" ||
          origin.hostname !== "app" ||
          origin.port ||
          origin.username ||
          origin.password
        )
          return false;
      } catch {
        return false;
      }
      // Explicit caller authentication keeps its own semantics.
      return !Object.keys(headers).some(
        (key) =>
          key.toLowerCase() === "authorization" ||
          (key.toLowerCase() === "sec-websocket-protocol" &&
            (headers[key].includes(DAEMON_AUTH_PROTOCOL_PREFIX) ||
              headers[key].includes(LEGACY_BEARER_PROTOCOL_PREFIX))),
      );
    };
    if (!eligible()) {
      callback({ requestHeaders: headers });
      return;
    }
    try {
      const password = await credential(details.url);
      if (password === null) {
        callback({ cancel: true });
        return;
      }
      // Navigation/destruction may occur during asynchronous ownership validation.
      // Any password is a valid header value this way (spaces, quotes, non-ASCII are encoded).
      if (password && eligible()) headers.Authorization = daemonAuthorizationHeader(password);
      callback({ requestHeaders: headers });
    } catch {
      callback({ cancel: true });
    }
  };
}
