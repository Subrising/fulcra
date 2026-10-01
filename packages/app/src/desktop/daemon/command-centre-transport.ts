import { checkedTransport } from "./checked-transport";
import { getDesktopHost } from "@/desktop/host";
import { createAppWebSocketFactory } from "@/runtime/websocket-factory";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
/** Main adds authentication to the owned handshake. Renderer never requests or receives it. */
export function createDesktopCredentialTransport(
  _serverId: string | undefined,
  password?: string,
): DaemonTransportFactory | undefined {
  if (password || typeof getDesktopHost()?.invoke !== "function") return undefined;
  const base = createWebSocketTransportFactory(createAppWebSocketFactory());
  const checked = checkedTransport(base, async (url) => {
    const result = await getDesktopHost()!.invoke!("desktop_daemon_connection_check", { url });
    if (typeof result === "object" && result !== null && Reflect.get(result, "retry") === true)
      throw Object.assign(Error("Desktop daemon is starting or unavailable. Retrying."), {
        retryable: true,
      });
    if (result !== true)
      throw Error("Desktop daemon authentication unavailable. Retry from Settings.");
  });
  return (options) => {
    const url = new URL(options.url);
    return url.protocol === "ws:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
      ? checked(options)
      : base(options);
  };
}
