// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { configuredControllerPluginId } from "@getpaseo/protocol/bundled-controller";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { createPluginClientId } from "./plugin-session-identity.js";
import { SessionInboundMessageSchema, WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import {
  boundedControllerJson,
  boundedControllerServiceJson,
  CONTROLLER_SERVICE_MAX_BYTES,
  parseControllerServiceFrame,
  rejectUnknownControllerFields,
  type ControllerServiceFrame,
} from "@getpaseo/protocol/controller-service";
import { PluginSessionSocket } from "./session-socket.js";
import type { PluginPaseoSessionHost } from "./runtime.js";

/** One private plugin-bound session per child epoch. No caller-selected authentication. */
export async function createControllerService(
  host: PluginPaseoSessionHost,
  options: {
    /** FULCRA(trusted-bundle): supplied only by the original host distribution. */
    pluginId?: string;
    epoch: string;
    emit(frame: ControllerServiceFrame): void;
    revoke(): void;
    log?(reason: string): void;
  },
) {
  const pluginId = configuredControllerPluginId(options.pluginId);
  let live = true,
    ready = false,
    opened = false,
    bytes = 0;
  const queued: ControllerServiceFrame[] = [];
  function deliver(frame: ControllerServiceFrame) {
    if (!live) return;
    const validated = parseControllerServiceFrame(frame);
    const size = Buffer.byteLength(JSON.stringify(validated));
    if (!ready) {
      if (queued.length >= 64 || bytes + size > CONTROLLER_SERVICE_MAX_BYTES) {
        options.log?.("Controller pre-ready output capacity exceeded");
        close();
        return;
      }
      queued.push(validated);
      bytes += size;
    } else options.emit(validated);
  }
  const logFailure = (error: unknown) =>
    options.log?.(error instanceof Error ? error.message : "Invalid controller service output");
  const socket = new PluginSessionSocket({
    send(message, callback) {
      try {
        if (message.type === "paseo_close") {
          close();
          callback?.(null);
          return true;
        }
        if (
          !live ||
          message.type !== "paseo_frame" ||
          message.isBinary ||
          typeof message.data !== "string"
        )
          throw Error("Invalid service output");
        const value = boundedControllerServiceJson(message.data);
        const frame = WSOutboundMessageSchema.parse(value);

        const welcome =
          frame.type === "session" &&
          frame.message.type === "status" &&
          frame.message.payload.status === "server_info";
        if (!opened && !welcome) throw Error("Service event before welcome");
        if (welcome && opened) throw Error("Repeated service welcome");
        opened ||= welcome;
        deliver({
          type: welcome ? "daemon-open" : "daemon-event",
          version: 1,
          epoch: options.epoch,
          frame,
        });
        callback?.(null);
        return true;
      } catch (error) {
        logFailure(error);
        close();
        callback?.(error instanceof Error ? error : Error("Invalid service output"));
        return false;
      }
    },
  });
  function close() {
    if (!live) return;
    live = false;
    queued.length = 0;
    bytes = 0;
    // Revoke before any notification/transport callback can re-enter the host.
    options.revoke();
    socket.peerClosed();
    options.emit({ type: "daemon-closed", version: 1, epoch: options.epoch });
  }
  try {
    const attachment = await host.attachPluginSocket(pluginId, socket);
    void attachment.closed.then(close, close);
    socket.receive(
      JSON.stringify({
        type: "hello",
        clientId: createPluginClientId(pluginId),
        clientType: "mcp",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.explicitEventSubscriptions]: true,
          [CLIENT_CAPS.ownedSubscriptions]: true,
          [CLIENT_CAPS.allProviders]: true,
          [CLIENT_CAPS.commandCentrePermission]: true,
        },
      }),
      false,
    );
  } catch (error) {
    close();
    throw error;
  }
  return {
    ready() {
      if (!live || ready) return;
      ready = true;
      const frames = queued.splice(0);
      bytes = 0;
      for (const frame of frames) {
        if (!live) break;
        options.emit(frame);
      }
    },
    async dispatch(input: unknown) {
      if (!live) throw Error("Controller service closed");
      const value = boundedControllerJson(input);
      const message = SessionInboundMessageSchema.parse(value);
      rejectUnknownControllerFields(value, message);
      socket.receive(JSON.stringify({ type: "session", message }), false);
      return null;
    },
    close,
  };
}
