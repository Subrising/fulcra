// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { configuredControllerPluginId } from "@getpaseo/protocol/bundled-controller";
import { randomUUID } from "node:crypto";
import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import type { JsonObject, JsonValue } from "@getpaseo/protocol/trusted-input";
import { PluginSessionSocket } from "./session-socket.js";
import type { PluginPaseoSessionHost } from "./runtime.js";
import { boundedJson } from "./controller-frames.js";

function rejectUnknownFields(input: JsonValue, parsed: unknown): void {
  if (!input || typeof input !== "object") return;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid controller RPC object");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(parsed, key)) throw new Error("Unknown controller RPC fields");
    rejectUnknownFields(Reflect.get(input, key), Reflect.get(parsed, key));
  }
}

/** A private plugin-bound service session; never an operator authentication source. */
export async function createControllerRpcProxy(
  host: PluginPaseoSessionHost,
  controllerPluginId?: string,
): Promise<{
  rpc(frame: JsonObject): Promise<JsonValue>;
  close(): void;
}> {
  const pluginId = configuredControllerPluginId(controllerPluginId);
  let live = true;
  const pending = new Map<
    string,
    {
      originalId: string;
      resolve(value: JsonValue): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const socket = new PluginSessionSocket({
    send(message, callback) {
      if (message.type === "paseo_close") {
        close();
        callback?.(null);
        return true;
      }
      if (message.type !== "paseo_frame" || message.isBinary || typeof message.data !== "string") {
        callback?.(null);
        return true;
      }
      let envelope: { message?: { payload?: { requestId?: string } } };
      try {
        envelope = boundedJson(message.data) as typeof envelope;
      } catch {
        close();
        callback?.(new Error("Invalid controller service frame"));
        return false;
      }
      callback?.(null);
      const response = envelope.message;
      const id = response?.payload?.requestId;
      if (id) {
        const call = pending.get(id);
        if (call) {
          pending.delete(id);
          clearTimeout(call.timer);
          call.resolve({
            ...response,
            payload: { ...response?.payload, requestId: call.originalId },
          } as JsonValue);
        }
      }
      return true;
    },
  });
  function close(): void {
    if (!live) return;
    live = false;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Controller service transport closed"));
    }
    pending.clear();
    socket.peerClosed();
  }
  const attachment = await host.attachPluginSocket(pluginId, socket);
  void attachment.closed.then(close, close);
  socket.receive(
    JSON.stringify({
      type: "hello",
      clientId: randomUUID(),
      clientType: "mcp",
      protocolVersion: 1,
    }),
    false,
  );
  return {
    rpc(frame) {
      if (!live || pending.size >= 32)
        return Promise.reject(new Error("Controller service unavailable"));
      const value = boundedJson(frame);
      const decoded = SessionInboundMessageSchema.safeParse(value);
      if (!decoded.success) throw new Error("Invalid controller RPC frame");
      const parsed = decoded.data;
      // Parsing must not silently strip caller-supplied authority/envelope fields.
      rejectUnknownFields(value, parsed);
      if (!("requestId" in parsed) || typeof parsed.requestId !== "string")
        throw new Error("Correlated controller RPC required");
      const id = randomUUID();
      return new Promise<JsonValue>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Controller RPC timed out"));
        }, 30_000);
        pending.set(id, {
          originalId: parsed.requestId as string,
          resolve,
          reject,
          timer,
        });
        try {
          socket.receive(
            JSON.stringify({
              type: "session",
              message: { ...parsed, requestId: id },
            }),
            false,
          );
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    close,
  };
}
