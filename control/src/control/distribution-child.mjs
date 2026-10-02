import { managementReplyFailure, describeFailure } from "./management-refusal.mjs";
import { READ_METHODS } from "./command-parser.mjs";
import { requireManagementPrincipal } from "./management-principal.mjs";
import net from "node:net";
import { readFrames, writeFrames } from "./bounded-pipe.mjs";
import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createControllerTransport } from "@getpaseo/client/controller-transport";
import {
  parseControllerCommand as parseFrame,
  parseControllerReply,
  boundedJson,
} from "@getpaseo/protocol/controller-frames";
import { boundedControllerHostInput } from "@getpaseo/protocol/controller-service";
// Controller modules read portable config at import time: import them only after the owned boot.
let epoch,
  boot,
  adapter,
  management,
  started = false,
  live = true;
const pending = new Map();
function close() {
  if (!live) return;
  live = false;
  for (const call of pending.values()) {
    clearTimeout(call.timer);
    call.reject(Error("Controller epoch closed; outcome uncertain"));
  }
  pending.clear();
  if (adapter) adapter.receive({ type: "daemon-closed", version: 1, epoch });
  process.kill(process.pid, "SIGTERM");
}
// fd 3/4 are opened as event-loop pipe handles, never fs streams: an fs stream parks a threadpool thread in a blocking
// read()/write() on the pipe, and process.exit() then waits on that thread forever (W1 postfix-1: SIGTERM closed the
// socket and journal, reached exit, and the controller never exited).
// Once the epoch is closed (daemon-closed frame or host pipe EOF), the DaemonClient rejects its pending waiters with
// DaemonConnectionError (DAEMON_CONNECTION_LOST), and some have no handler. Unobserved, that rejection crashed the child
// before its own SIGTERM ran stop() and store.close() (W1 rebuild, daemon shutdown). Only that error, and only after the
// close, is expected; anything else still fails loudly.
process.on("unhandledRejection", (error) => {
  if (!live && error?.code === "DAEMON_CONNECTION_LOST") return;
  throw error;
});
const output = new net.Socket({ fd: 4, readable: false, writable: true });
output.on("error", close);
const write = writeFrames(output, {
  maxBytes: 1024 * 1024,
  maxQueuedBytes: 1024 * 1024,
  onError: close,
});
function send(frame) {
  if (!live) throw Error("Owned channel unavailable");
  write(boundedJson(frame));
}
function request(type, fields) {
  if (!live || pending.size >= 32) return Promise.reject(Error("Controller channel unavailable"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("Controller request timed out"));
      close();
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    try {
      send({ type, id, epoch, ...fields });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}
async function receive(input) {
  let managementDispatched = false,
    readCommand = false;
  try {
    const frame = boundedControllerHostInput(input);
    if (!started) {
      if (
        !frame ||
        Object.keys(frame).sort().join(",") !== "boot,contract,epoch,type" ||
        frame.type !== "boot" ||
        frame.contract !== "1.1" ||
        !/^[a-f0-9-]{36}$/.test(frame.epoch) ||
        typeof frame.boot !== "string"
      )
        throw Error("Invalid owned boot");
      started = true;
      ({ boot, epoch } = frame);
      adapter = createControllerTransport({
        epoch,
        onClose: close,
        request: (frame) => request("daemon-rpc", { frame }),
        ready: () => send({ type: "service-ready", boot, epoch, contract: "1.1" }),
      });
      const daemon = new DaemonClient({
        url: "ws://owned-service.invalid",
        clientId: randomUUID(),
        transportFactory: () => adapter.transport,
        reconnect: { enabled: false },
      });
      await daemon.connect();
      const { startController } = await import("./server.mjs");
      await startController({
        daemon,
        epoch,
        requestReport: (reportFrame) => request("report-inbox", { frame: reportFrame }),
        getHandshakeBoot: () => (live ? boot : undefined),
        issueProvenance: (binding) => request("issue-provenance", { binding }),
        registerManagement: (handler) => {
          management = handler;
          return () => {
            management = undefined;
          };
        },
      });
      send({ type: "ready", boot, epoch, contract: "1.1" });
      return;
    }
    if (frame.epoch !== epoch) throw Error("Expired owned epoch");
    if (["daemon-open", "daemon-event", "daemon-closed"].includes(frame.type)) {
      adapter.receive(frame);
      if (frame.type === "daemon-closed") close();
      return;
    }
    if (Object.hasOwn(frame, "ok")) {
      const reply = parseControllerReply(frame),
        call = pending.get(reply.id);
      if (!call) return;
      pending.delete(reply.id);
      clearTimeout(call.timer);
      reply.ok
        ? call.resolve(reply.result)
        : call.reject(Object.assign(Error(`Controller host ${reply.code}`), { code: reply.code }));
      return;
    }
    const command = parseFrame(frame);
    if (!management)
      throw Object.assign(Error("Controller management not ready"), { code: "unavailable" });
    // Host principal is kept separate from public service traffic.
    readCommand = READ_METHODS.includes(command.command.method);
    // Cutover A2: a write without an authorised host principal is refused BEFORE dispatch (reported 'unauthorised', not uncertain).
    if (!readCommand) requireManagementPrincipal(command.principal);
    managementDispatched = true;
    const result = await management(command.command, command.principal);
    send({ id: command.id, epoch, ok: true, result });
  } catch (error) {
    if (input?.type === "management" && typeof input.id === "string" && input.epoch === epoch) {
      // L37: keep evidence of a masked read failure (class + location only; see describeFailure).
      if (managementDispatched && readCommand)
        console.error(
          "Management read failed:",
          String(input.command?.method ?? "").slice(0, 64),
          describeFailure(error),
        );
      send({
        id: input.id,
        epoch,
        ok: false,
        ...managementReplyFailure(error, managementDispatched, readCommand),
      });
    } else {
      console.error("Controller owned channel failed:", error.message);
      close();
    }
  }
}
readFrames(new net.Socket({ fd: 3, readable: true, writable: false }), {
  maxBytes: 8 * 1024 * 1024,
  onFrame: (input) => {
    void receive(input);
  },
  onError: close,
});
