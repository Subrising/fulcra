import { parseControllerServiceFrame } from "@getpaseo/protocol/controller-service";
import type { DaemonTransport } from "./daemon-client-transport-types.js";

/** Distribution-only transport. Public SDK hello is local; the host owns admission. */
export function createControllerTransport(options: {
  epoch: string;
  request(frame: Record<string, unknown>): Promise<unknown>;
  ready(): void;
  onClose?(): void;
}) {
  let live = true,
    hello = false,
    started = false;
  let message: ((data: unknown, binary: boolean) => void) | undefined;
  let open: (() => void) | undefined;
  let closed: ((event?: unknown) => void) | undefined;
  let error: ((event?: unknown) => void) | undefined;
  function close() {
    if (!live) return;
    live = false;
    options.onClose?.();
    closed?.({ code: 1001, reason: "Controller epoch closed" });
  }
  function start() {
    if (started || !open || !message || !closed || !error) return;
    started = true;
    queueMicrotask(() => {
      if (!live) return;
      open?.();
      if (hello && live) options.ready();
    });
  }
  const transport: DaemonTransport = {
    send(data) {
      if (!live || typeof data !== "string") throw Error("Controller transport unavailable");
      const frame = JSON.parse(data);
      if (frame.type === "hello") {
        if (hello) throw Error("Repeated SDK hello");
        hello = true;
        return; // never forward credentials, capabilities, admission or identity
      }
      if (!hello) throw Error("SDK hello required");
      if (frame.type === "ping") {
        message?.(JSON.stringify({ type: "pong" }), false);
        return;
      }
      if (
        frame.type !== "session" ||
        Object.keys(frame).some((key) => !["type", "message"].includes(key))
      )
        throw Error("Invalid SDK service envelope");
      void options.request(frame.message).catch((failure) => {
        error?.(failure);
        close();
      });
    },
    close,
    onMessage(handler) {
      message = handler;
      start();
      return () => {
        message = undefined;
      };
    },
    onOpen(handler) {
      open = handler;
      start();
      return () => {
        open = undefined;
      };
    },
    onClose(handler) {
      closed = handler;
      start();
      return () => {
        closed = undefined;
      };
    },
    onError(handler) {
      error = handler;
      start();
      return () => {
        error = undefined;
      };
    },
  };
  let welcomed = false;
  return {
    transport,
    receive(input: unknown) {
      if (!live) return;
      try {
        const frame = parseControllerServiceFrame(input);
        if (frame.epoch !== options.epoch) throw Error("Stale service epoch");
        if (frame.type === "daemon-closed") {
          close();
          return;
        }
        if (!hello || !message || (frame.type === "daemon-open" ? welcomed : !welcomed))
          throw Error("Invalid service event order");
        welcomed = true;
        message(JSON.stringify(frame.frame), false);
      } catch (failure) {
        error?.(failure);
        close();
      }
    },
  };
}
