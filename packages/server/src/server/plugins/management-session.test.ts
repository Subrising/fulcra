import { NativeReportRegistry } from "../report-registry.js";
import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import type { NativeReportIdentity } from "@getpaseo/protocol/native-intercom";
import { ReportRegistrationReceiptSchema } from "@getpaseo/protocol/native-intercom";
import type { JsonValue } from "@getpaseo/protocol/trusted-input";
import { parseControllerCommand } from "../../../../../control/orca-organization/shared/command-parser.mjs";
import {
  registerNativeReceiptMaintenance,
  registerNativeReportRegistry,
} from "./native-intercom-owner.js";
import { MessageReceipts } from "../message-receipts/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundledTarget } from "./test-utils/management.js";
import { expect, test, vi } from "vitest";
import pino from "pino";
import { Session } from "../session.js";
import { SessionAuthorization, OWNER_PERMISSIONS } from "../authorization/index.js";
import { ManagementAuthority } from "./management.js";
import { PluginRuntime } from "./runtime.js";
import { createManagementContext } from "./plugin-management-context.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

// Keep the actual cache implementation when a read-only test cache supplies its older CJS export.
// This dependency is unrelated to parent admission; no checkout behavior is substituted.
vi.mock("@isaacs/ttlcache", async () => {
  const cache = await vi.importActual<{ TTLCache?: unknown; default?: unknown }>(
    "@isaacs/ttlcache",
  );
  return { ...cache, TTLCache: cache.TTLCache ?? cache.default };
});

function fixture(method = "list", commandInput: JsonValue = null) {
  const authority = new ManagementAuthority({
    enabled: () => true,
    validate: (command) => parseControllerCommand(command),
  });
  const dispatch = vi.fn(async () => null);
  authority.register("orca-organization-next", dispatch);
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.9.1");
  let context: ReturnType<typeof createManagementContext> | undefined;
  let settle: (() => void) | undefined;
  let hold = false;
  let retainedId = "";
  const pendingCalls = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const fromChild = (message: PluginProcessMessage) =>
    Reflect.get(runtime, "handleChildMessage").call(runtime, loaded, message);
  const child = {
    send(message: PluginProcessRequest, callback?: (error: Error | null) => void) {
      callback?.(null);
      if (message.type === "invoke") {
        retainedId = message.management?.invocationId ?? "";
        context = message.management
          ? createManagementContext(
              message.management,
              (callId, invocationId, command) =>
                new Promise((resolve, reject) => {
                  pendingCalls.set(callId, { resolve, reject });
                  fromChild({
                    type: "management.invoke",
                    callId,
                    invocationId,
                    command,
                  });
                }),
            )
          : undefined;
        const work = async () => {
          try {
            if (!context) throw new Error("management unavailable");
            if (hold)
              await new Promise<void>((resolve) => {
                settle = resolve;
              });
            const output = await context.context.invoke({ method, input: commandInput });
            fromChild({
              type: "result",
              requestId: message.requestId,
              output,
            });
          } catch (error) {
            fromChild({
              type: "error",
              requestId: message.requestId,
              error: String(error),
            });
          } finally {
            context?.close();
          }
        };
        void work();
      }
      if (message.type === "host.result") pendingCalls.get(message.callId)?.resolve(message.output);
      if (message.type === "host.error")
        pendingCalls.get(message.callId)?.reject(new Error(message.error));
      return true;
    },
  };
  const loaded = {
    id: "orca-organization-next",
    managementTarget: bundledTarget,
    methods: new Set(["manage"]),
    child,
    pending: new Map(),
  };
  Reflect.get(runtime, "plugins").set(loaded.id, loaded);
  const source = {};
  const messages: unknown[] = [];
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    managementSources: new Map(),
    managementInvocations: new Map(),
    authorization: new SessionAuthorization(OWNER_PERMISSIONS),
    agentManager: {
      trustedPlugins: {
        management: authority,
        rpc: (_token: unknown, run: () => unknown) => run(),
      },
    },
    delivery: {
      request: (_source: unknown, _msg: unknown, run: () => unknown) => run(),
    },
    inflightRequests: 0,
    peakInflightRequests: 0,
    sessionLogger: pino({ level: "silent" }),
    pluginRuntime: {
      managementTarget: runtime.managementTarget.bind(runtime),
      invokePluginRpc: runtime.invoke.bind(runtime),
    },
    dispatchIntegrationMessage: () => undefined,
    emit: (message: unknown) => {
      messages.push(message);
    },
  });
  const invoke = async (input: unknown = {}) => {
    (await Reflect.get(session, "dispatchPluginMessage").call(
      session,
      {
        type: "plugin.rpc.invoke.request",
        requestId: "request",
        pluginId: loaded.id,
        method: "manage",
        input,
      },
      source,
    )) as Promise<void>;
    return (messages.at(-1) as { payload?: { output?: JsonValue } })?.payload?.output;
  };
  return {
    authority,
    command(nextMethod: string, nextInput: JsonValue) {
      method = nextMethod;
      commandInput = nextInput;
    },
    dispatch,
    rawInvoke: () =>
      new Promise((resolve, reject) => {
        pendingCalls.set("retained", { resolve, reject });
        fromChild({
          type: "management.invoke",
          callId: "retained",
          invocationId: retainedId,
          command: { method: "list", input: null },
        });
      }),
    source,
    session,
    invoke,
    messages,
    authenticate(
      authentication:
        | "daemon-password"
        | "protected-local-ipc"
        | "paired-device" = "daemon-password",
    ) {
      session.admitManagementSource(source, {
        id: "owner",
        authentication,
        deviceId: authentication === "paired-device" ? "paired" : null,
      });
    },
    hold() {
      hold = true;
    },
    settle() {
      settle?.();
    },
  };
}

test("P6 actual Session RPC → runtime IPC → plugin invoke closure → host bridge", async () => {
  const f = fixture();
  await expect(f.invoke()).rejects.toThrow("unavailable");
  expect(f.dispatch).not.toHaveBeenCalled();
  f.authenticate();
  await f.invoke();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.dispatch.mock.calls[0]).toEqual([
    { method: "list", input: null },
    expect.objectContaining({ id: "owner", authentication: "daemon-password" }),
  ]);
  await f.invoke({ principal: { id: "forged" } });
  expect(f.dispatch.mock.calls[1]?.[1]).toMatchObject({ id: "owner" });
});
test("P6 revocation and disconnection during awaited handler fail before dispatch", async () => {
  for (const disconnect of [true, false]) {
    const f = fixture();
    f.authenticate();
    f.hold();
    const pending = f.invoke();
    await Promise.resolve();
    if (disconnect) f.session.revokeManagementSource(f.source);
    else Reflect.get(f.session, "authorization").replacePermissions([]);
    f.settle();
    await expect(pending).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
  }
});

test("P6 subprocess cannot return its own principal", async () => {
  const { PluginProcessMessageSchema } = await import("./plugin-process-protocol.js");
  expect(
    PluginProcessMessageSchema.safeParse({
      type: "management.invoke",
      callId: "call",
      invocationId: "d7ba0850-0079-4ac7-9e3f-85293d3445a2",
      command: { method: "list", input: null },
      principal: { id: "forged" },
    }).success,
  ).toBe(false);
});

test("P6 real Session request entry retains source authentication and authorizes before IPC", async () => {
  const f = fixture();
  // Keep the real request entry and plugin dispatch; unrelated domain routers are outside this fixture.
  Object.assign(f.session, {
    dispatchInboundMessage: (message: unknown, source: object) =>
      Reflect.get(f.session, "dispatchPluginMessage").call(f.session, message, source),
  });
  const frame = {
    type: "plugin.rpc.invoke.request",
    requestId: "entry",
    pluginId: "orca-organization-next",
    method: "manage",
    input: {},
  } as const;
  await f.session.handleMessage(frame, f.source);
  expect(f.messages).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
  expect(f.dispatch).not.toHaveBeenCalled();
  f.authenticate();
  await f.session.handleMessage(frame, f.source);
  expect(f.dispatch).toHaveBeenCalledOnce();
  await f.session.handleMessage(frame, {});
  expect(f.dispatch).toHaveBeenCalledOnce();
  Reflect.get(f.session, "authorization").replacePermissions([]);
  await f.session.handleMessage(frame, f.source);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

test("P6 plugin IPC cannot reuse a settled handler invocation", async () => {
  const f = fixture();
  f.authenticate();
  await f.invoke();
  await expect(f.rawInvoke()).rejects.toThrow();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

test("P6 a limited resumed admission cannot inherit a retained Session's owner permissions", async () => {
  const f = fixture();
  f.session.admitManagementSource(
    f.source,
    { id: "owner", authentication: "paired-device", deviceId: "limited-device" },
    ["daemon.manage"],
  );
  await expect(f.invoke()).rejects.toThrow("unavailable");
  expect(f.dispatch).not.toHaveBeenCalled();
});

test("removing daemon.manage immediately closes an in-flight handler", async () => {
  const f = fixture();
  f.authenticate();
  f.hold();
  const pending = f.invoke();
  await Promise.resolve();
  f.session.setPermissions(OWNER_PERMISSIONS.filter((p) => p !== "daemon.manage"));
  f.settle();
  await expect(pending).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});

// Actual native adapter + Session source reader + Runtime management IPC + distribution parser.
// No caller-provided authentication or no-op authorization callback reaches the ledger.
test("native maintenance IPC: only host-admitted owner gets global status through the real adapter", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-maintenance-ipc-"));
  try {
    for (const authentication of [
      "daemon-password",
      "protected-local-ipc",
      "paired-device",
    ] as const) {
      const f = fixture("intercom-receipt-maintenance");
      registerNativeReceiptMaintenance(f.authority, new MessageReceipts(directory));
      await expect(
        f.invoke({ authentication: "protected-local-ipc", deviceId: null, reportKind: "owner" }),
      ).rejects.toThrow();
      f.authenticate(authentication);
      if (authentication === "paired-device") {
        await expect(f.invoke()).rejects.toThrow();
      } else {
        await f.invoke();
        expect(f.messages).toContainEqual(
          expect.objectContaining({
            payload: expect.objectContaining({
              output: {
                recordedIds: 0,
                maxIds: 10000,
                maintenanceRequired: false,
                newIdsRefused: false,
                automaticPruning: false,
              },
            }),
          }),
        );
      }
      expect(f.dispatch).not.toHaveBeenCalled();
      f.session.revokeManagementSource(f.source);
      await expect(f.invoke()).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native maintenance IPC: source revocation after awaited request preparation prevents counts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-maintenance-ipc-"));
  const f = fixture("intercom-receipt-maintenance");
  registerNativeReceiptMaintenance(f.authority, new MessageReceipts(directory));
  try {
    f.authenticate("protected-local-ipc");
    f.hold();
    const pending = f.invoke();
    await Promise.resolve();
    f.session.revokeManagementSource(f.source);
    f.settle();
    await expect(pending).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native maintenance wire schema rejects credential promotion and destructive inputs", async () => {
  const { receiptMaintenanceRpc } =
    await import("../../../../../control/orca-organization/shared/intercom.js");
  expect(receiptMaintenanceRpc.name).toBe("organization.intercom.receipts.status");
  expect(receiptMaintenanceRpc.input.safeParse({}).success).toBe(true);
  for (const input of [
    { owner: true },
    { authentication: "protected-local-ipc" },
    { reportKind: "owner" },
    { prune: true },
    { maxIds: 20000 },
  ])
    expect(receiptMaintenanceRpc.input.safeParse(input).success).toBe(false);
});

async function registryFixture(operationLimit = 10000) {
  const directory = await mkdtemp(path.join(tmpdir(), "native-report-registry-"));
  const file = path.join(directory, "report-authority.json");
  const f = fixture();
  const identities = new Map<string, NativeReportIdentity>();
  const identity = () => {
    const value = {
      agentId: randomUUID(),
      instanceId: randomUUID(),
      sessionId: randomUUID(),
      boot: randomUUID(),
    };
    identities.set(value.agentId, value);
    return value;
  };
  const prime = identity(),
    child = identity(),
    grandchild = identity();
  const scope = { projectId: randomUUID(), taskId: randomUUID() };
  const registry = new NativeReportRegistry(
    file,
    (id) => identities.get(id) ?? null,
    operationLimit,
  );
  registerNativeReportRegistry(f.authority, registry);
  const call = async (method: string, input: JsonValue) => {
    f.command(method, input);
    return ReportRegistrationReceiptSchema.parse(await f.invoke());
  };
  const register = (expectedEpoch: string | null = null) =>
    call("report-prime-register", {
      messageId: randomUUID(),
      identity: prime,
      scopes: [scope],
      expectedEpoch,
    });
  const adopt = (source = child, parent = prime, expectedEpoch: string | null = null) =>
    call("report-parent-adopt", {
      messageId: randomUUID(),
      child: source,
      parent,
      scopes: [scope],
      expectedEpoch,
    });
  return {
    ...f,
    directory,
    file,
    identities,
    prime,
    child,
    grandchild,
    scope,
    registry,
    call,
    register,
    adopt,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("report registry owner IPC: unknown legacy fails closed and explicit prime/adoption creates scoped parent", async () => {
  const f = await registryFixture();
  try {
    expect(() => f.registry.requireParent(f.child, f.scope)).toThrow();
    await expect(f.register()).rejects.toThrow();
    f.authenticate("paired-device");
    await expect(f.register()).rejects.toThrow();
    f.authenticate();
    const prime = await f.register();
    const child = await f.adopt();
    expect(f.registry.requireParent(f.child, f.scope)).toEqual({
      sourceEpoch: child.epoch,
      parent: f.prime,
      parentEpoch: prime.epoch,
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("report registry owner IPC: equal ID body dedup survives restart, conflicts and implicit prime replacement refuse", async () => {
  const f = await registryFixture();
  try {
    f.authenticate();
    const input = {
      messageId: randomUUID(),
      identity: f.prime,
      scopes: [f.scope],
      expectedEpoch: null,
    };
    const receipt = await f.call("report-prime-register", input);
    expect(await f.call("report-prime-register", input)).toEqual({ ...receipt, duplicate: true });
    const restored = fixture("report-prime-register", input);
    registerNativeReportRegistry(
      restored.authority,
      new NativeReportRegistry(f.file, (id) => f.identities.get(id) ?? null),
    );
    restored.authenticate("protected-local-ipc");
    expect(ReportRegistrationReceiptSchema.parse(await restored.invoke())).toEqual({
      ...receipt,
      duplicate: true,
    });
    await expect(
      f.call("report-prime-register", { ...input, scopes: [{ ...f.scope, taskId: randomUUID() }] }),
    ).rejects.toThrow();
    await expect(f.register()).rejects.toThrow("Management refused");
  } finally {
    await f.cleanup();
  }
});

test("report registry owner IPC: forged identity, self-link, cycle, unknown parent and cross-task scope refuse", async () => {
  const f = await registryFixture();
  try {
    f.authenticate();
    await f.register();
    await expect(f.adopt({ ...f.child, instanceId: randomUUID() })).rejects.toThrow();
    await expect(f.adopt(f.child, f.child)).rejects.toThrow();
    const unknown = { ...f.prime, agentId: randomUUID() };
    await expect(f.adopt(f.child, unknown)).rejects.toThrow();
    await expect(
      f.call("report-parent-adopt", {
        messageId: randomUUID(),
        child: f.child,
        parent: f.prime,
        scopes: [{ ...f.scope, taskId: randomUUID() }],
        expectedEpoch: null,
      }),
    ).rejects.toThrow("Management refused");
    const child = await f.adopt();
    await f.adopt(f.grandchild, f.child);
    await expect(f.adopt(f.child, f.grandchild, child.epoch)).rejects.toThrow("Management refused");
    await expect(f.adopt(f.prime, f.child)).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("report registry owner IPC: prime rotation retains child relationships, unlink fences descendants and native replacement refuses", async () => {
  const f = await registryFixture();
  try {
    f.authenticate();
    const prime = await f.register();
    const child = await f.adopt();
    await f.adopt(f.grandchild, f.child);
    f.identities.set(f.prime.agentId, { ...f.prime, instanceId: randomUUID() });
    expect(() => f.registry.requireParent(f.child, f.scope)).toThrow("identity replaced");
    f.identities.set(f.prime.agentId, f.prime);
    const revoke = { messageId: randomUUID(), identity: f.child, expectedEpoch: child.epoch };
    expect(await f.call("report-registration-revoke", revoke)).toMatchObject({ current: false });
    expect(await f.call("report-registration-revoke", revoke)).toMatchObject({
      duplicate: true,
      current: false,
    });
    expect(() => f.registry.requireParent(f.grandchild, f.scope)).toThrow();
    await f.adopt();
    const rotated = await f.register(prime.epoch);
    expect(f.registry.requireParent(f.child, f.scope)).toMatchObject({
      parent: f.prime,
      parentEpoch: rotated.epoch,
    });
  } finally {
    await f.cleanup();
  }
});

test("report registry owner IPC: real owner revoke or identity replacement after awaited mkdir prevents file publication", async () => {
  for (const replace of [false, true]) {
    const f = await registryFixture();
    f.authenticate();
    const original = fsPromises.mkdir.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (replace) f.identities.set(f.prime.agentId, { ...f.prime, instanceId: randomUUID() });
      else f.session.revokeManagementSource(f.source);
      return result;
    });
    try {
      await expect(f.register()).rejects.toThrow();
      await expect(fsPromises.access(f.file)).rejects.toThrow();
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await f.cleanup();
    }
  }
});

test("report registry owner IPC: unsafe/corrupt private store never publishes authority or auto repairs", async () => {
  for (const kind of ["permissions", "orphan", "symlink"] as const) {
    const f = await registryFixture();
    const state = {
      version: 1,
      prime: null,
      links:
        kind === "orphan"
          ? [
              {
                identity: f.child,
                scopes: [f.scope],
                epoch: randomUUID(),
                creator: "owner",
                parent: f.prime,
                parentEpoch: randomUUID(),
              },
            ]
          : [],
      operations: [],
    };
    const data = JSON.stringify(state);
    if (kind === "symlink") {
      const target = path.join(f.directory, "private-target.json");
      await fsPromises.writeFile(target, data, { mode: 0o600 });
      await fsPromises.symlink(target, f.file);
    } else
      await fsPromises.writeFile(f.file, data, { mode: kind === "permissions" ? 0o644 : 0o600 });
    if (kind === "permissions") await fsPromises.chmod(f.file, 0o644);
    try {
      f.authenticate();
      await expect(f.register()).rejects.toThrow();
      await expect(f.register()).rejects.toThrow();
      expect(() => f.registry.requireParent(f.child, f.scope)).toThrow();
      expect(await fsPromises.readFile(f.file, "utf8")).toBe(data);
    } finally {
      await f.cleanup();
    }
  }
});

test("report registry owner IPC: finite operation exhaustion fences authority and preserves IDs after restart", async () => {
  const f = await registryFixture(1);
  try {
    f.authenticate();
    const input = {
      messageId: randomUUID(),
      identity: f.prime,
      scopes: [f.scope],
      expectedEpoch: null,
    };
    const receipt = await f.call("report-prime-register", input);
    expect(receipt).toMatchObject({ current: false, maintenanceRequired: true });
    await expect(f.register(receipt.epoch)).rejects.toThrow();
    expect(await f.call("report-prime-register", input)).toMatchObject({
      duplicate: true,
      current: false,
      maintenanceRequired: true,
    });
    expect(() => f.registry.requireParent(f.child, f.scope)).toThrow("maintenance required");
    const restored = fixture("report-prime-register", input);
    registerNativeReportRegistry(
      restored.authority,
      new NativeReportRegistry(f.file, (id) => f.identities.get(id) ?? null, 1),
    );
    restored.authenticate();
    expect(ReportRegistrationReceiptSchema.parse(await restored.invoke())).toMatchObject({
      duplicate: true,
      current: false,
      maintenanceRequired: true,
    });
    expect(JSON.parse(await fsPromises.readFile(f.file, "utf8")).operations).toHaveLength(1);
    expect(() => new NativeReportRegistry(f.file, () => null, 10001)).toThrow();
  } finally {
    await f.cleanup();
  }
});

test("report registry owner IPC: pending durable epoch publication fences old parent admission", async () => {
  const f = await registryFixture();
  let observed = false;
  try {
    f.authenticate();
    const prime = await f.register();
    await f.adopt();
    const original = fsPromises.mkdir.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (...args) => {
      observed = true;
      expect(() => f.registry.requireParent(f.child, f.scope)).toThrow("registration unavailable");
      return original(...args);
    });
    try {
      await f.register(prime.epoch);
    } finally {
      spy.mockRestore();
    }
    expect(observed).toBe(true);
    expect(f.registry.requireParent(f.child, f.scope)).toMatchObject({ parent: f.prime });
  } finally {
    await f.cleanup();
  }
});

test("native parent adoption requires a fresh owner transport, not labels or plugin identity", async () => {
  for (const state of ["owner", "missing", "device", "plugin", "revoked", "permission"] as const) {
    const f = fixture();
    f.authenticate();
    if (state === "device")
      f.session.admitManagementSource(f.source, {
        id: "device",
        authentication: "paired-device",
        deviceId: "device",
      });
    if (state === "plugin") Reflect.set(f.session, "pluginOriginId", "claimed-owner");
    const adopt = vi.fn(async (_input: unknown, current: () => boolean) => {
      await Promise.resolve();
      if (state === "revoked") f.session.revokeManagementSource(f.source);
      if (state === "permission") Reflect.get(f.session, "authorization").replacePermissions([]);
      if (!current()) throw new Error("Owner required");
    });
    Reflect.get(f.session, "agentManager").adoptAgentParent = adopt;
    Reflect.get(f.session, "agentManager").getAgent = () => null;
    Reflect.set(f.session, "agentStorage", { get: async () => null });
    Reflect.set(f.session, "emitWorkspaceUpdatesForWorkspaceIds", async () => undefined);
    await Reflect.get(f.session, "dispatchAgentRelationshipMessage").call(
      f.session,
      {
        type: "agent.parent.adopt.request",
        requestId: "adopt",
        agentId: "child",
        parentAgentId: "parent",
        expectedParentAgentId: null,
        childNativeSessionId: "child-native",
        parentNativeSessionId: "parent-native",
        labels: { role: "owner" },
      },
      state === "missing" ? {} : f.source,
    );
    expect(f.messages.at(-1)).toMatchObject({
      type: "agent.parent.adopt.response",
      payload: { accepted: state === "owner" },
    });
  }
});
