import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalTrustedPayload,
  isTrustedCatalogV11,
  type TrustedPayloadV11,
  type TrustedInputKind,
  type Sha256,
} from "@getpaseo/protocol/trusted-input";
import type { TrustedPluginServerV11, TrustedAgentV11 } from "@getpaseo/plugin/server";
import { TrustedPlugins } from "./trusted.js";
import { AgentManager } from "../agent/agent-manager.js";
import { promptPayload, commandPayload } from "../agent/trusted-operation.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const noop = () => undefined;
const id = "11111111-1111-4111-8111-111111111111";
const parentId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const hosts: TrustedPlugins[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
});
function fixture(setup: (server: TrustedPluginServerV11) => void = () => undefined) {
  const host = new TrustedPlugins();
  hosts.push(host);
  host.initializeKnownAgents([id, parentId]);
  let api!: TrustedPluginServerV11;
  host.registerV11("orca-organization-next", true, (server) => {
    api = server;
    setup(server);
  });
  const provider = vi.fn(() => undefined);
  const permission = vi.fn(async () => {
    throw new Error("provider received response");
  });
  const live = {
    id,
    instanceId: "44444444-4444-4444-8444-444444444444",
    provider: "claude",
    cwd: "/fixture",
    archivedAt: null,
    labels: {},
    lifecycle: "idle",
    activeTurnId: null,
    activeForegroundTurnId: null,
    config: { model: "model-a" },
    runtimeInfo: { model: "model-a", sessionId: "native-a" },
    features: [],
    lastUserMessageAt: new Date("2030-01-01T00:00:00Z"),
    pendingPermissions: new Map([
      [
        "request",
        {
          id: "request",
          provider: "claude",
          name: "Write",
          kind: "tool",
          input: { file_path: "/owned/safe.txt" },
          metadata: { generation: 1 },
        },
      ],
    ]),
    inFlightPermissionResponses: new Set<string>(),
    bufferedPermissionResolutions: new Map(),
    session: { tryHandleOutOfBand: provider, respondToPermission: permission },
  };
  const manager = new AgentManager({ logger: createTestLogger(), trustedPlugins: host });
  Reflect.get(manager, "agents").set(id, live);
  const token = (
    payload: TrustedPayloadV11,
    kind: TrustedInputKind = "prompt",
    messageId: string | null = "orca-control:example",
  ) =>
    api.issueProvenance({
      agentId: id,
      kind,
      messageId,
      attemptId,
      payloadDigest: createHash("sha256")
        .update(canonicalTrustedPayload({ agentId: id, kind, messageId, payload }))
        .digest("hex") as Sha256,
    });
  return { host, api, manager, live, provider, permission, token };
}

test("P1: changed text/options and caller digest cannot reach actual manager provider work", () => {
  const f = fixture((server) =>
    server.admission.onInput((_agent, input) =>
      input.provenance?.pluginId === "orca-organization-next" ? "allow" : "deny",
    ),
  );
  const options = { clientMessageId: "orca-control:example" };
  const approved = promptPayload("approved", options);
  const send = (token: string, text: string, extra = {}) =>
    f.host.rpc(token, () => f.manager.tryRunOutOfBand(id, text, { ...options, ...extra }));
  expect(send(f.token(approved), "approved")).toBe(false);
  expect(f.provider).toHaveBeenCalledExactlyOnceWith("approved");
  f.provider.mockClear();
  const changed = f.token(approved);
  expect(() => send(changed, "altered")).toThrow(/provenance|payload/i);
  expect(() => send(changed, "approved")).toThrow(/provenance|replayed/i);
  expect(() => send(f.token(approved), "approved", { maxThinkingTokens: 42 })).toThrow(
    /provenance|payload/i,
  );
  expect(() =>
    send(f.token(approved), "altered", {
      payloadDigest: canonicalTrustedPayload({
        agentId: id,
        kind: "prompt",
        messageId: options.clientMessageId,
        payload: approved,
      }),
    }),
  ).toThrow();
  expect(f.provider).not.toHaveBeenCalled();
});

test("P1: changed permission response with identical capability refuses before provider submission", async () => {
  const f = fixture((server) =>
    server.guard("agent.permission_respond", () => ({ requestId: "request" })),
  );
  const payload: TrustedPayloadV11 = {
    type: "permission",
    requestId: "intent",
    response: { behavior: "allow", updatedInput: { file_path: "/owned/safe.txt" } },
  };
  await expect(
    f.host.rpc(f.token(payload, "permission", "intent"), () =>
      f.manager.respondToPermission(id, "intent", {
        behavior: "allow",
        updatedInput: { file_path: "/private/secret" },
      }),
    ),
  ).rejects.toThrow(/provenance/);
  expect(f.permission).not.toHaveBeenCalled();
});

test("P2: canonical request contents are distinct, copied and deeply frozen", async () => {
  const observed: TrustedAgentV11[] = [];
  const f = fixture((server) =>
    server.guard("agent.permission_respond", (agent) => {
      observed.push(agent);
      return "deny";
    }),
  );
  await expect(
    f.manager.respondToPermission(id, "request", { behavior: "allow" }),
  ).rejects.toThrow();
  f.live.pendingPermissions.get("request")!.input.file_path = "/private/secret";
  await expect(
    f.manager.respondToPermission(id, "request", { behavior: "allow" }),
  ).rejects.toThrow();
  expect(observed).toHaveLength(2);
  expect(observed[0].permissions).not.toEqual(observed[1].permissions);
  expect(observed[0].permissions).toMatchObject({
    status: "known",
    requests: [{ input: { file_path: "/owned/safe.txt" } }],
    inFlightRequestIds: [],
  });
  if (observed[0].permissions.status !== "known") throw Error("Expected known permissions");
  expect(Object.isFrozen(observed[0].permissions.requests[0].input)).toBe(true);
  expect(f.permission).not.toHaveBeenCalled();
});

test("P2: changed same-ID request during guard and duplicate rewritten submission refuse", async () => {
  let mutate = true;
  const f = fixture((server) =>
    server.guard("agent.permission_respond", () => {
      if (mutate) f.live.pendingPermissions.get("request")!.input.file_path = "/private/secret";
      return { requestId: "request" };
    }),
  );
  await expect(f.manager.respondToPermission(id, "intent", { behavior: "allow" })).rejects.toThrow(
    /changed/,
  );
  mutate = false;
  f.live.inFlightPermissionResponses.add("request");
  await expect(
    f.manager.respondToPermission(id, "intent", { behavior: "allow" }),
  ).rejects.toThrow();
  f.live.inFlightPermissionResponses.clear();
  await expect(f.manager.respondToPermission(id, "intent", { behavior: "allow" })).rejects.toThrow(
    "provider received response",
  );
  expect(f.permission).toHaveBeenCalledExactlyOnceWith("request", { behavior: "allow" });
});

test.each(["model", "nativeSessionId", "serviceTier", "instanceId", "lastUserMessageAt"] as const)(
  "P3: changed %s refuses prepared intent",
  (field) => {
    const expected = {
      status: "known",
      instanceId: "44444444-4444-4444-8444-444444444444",
      nativeSessionId: "native-a",
      model: "model-a",
      serviceTier: null,
      lastUserMessageAt: "2030-01-01T00:00:00.000Z",
    };
    const f = fixture((server) =>
      server.admission.onInput((agent) =>
        JSON.stringify(agent.runtime) === JSON.stringify(expected) ? "allow" : "deny",
      ),
    );
    if (field === "model") f.live.runtimeInfo.model = "model-b";
    if (field === "nativeSessionId") f.live.runtimeInfo.sessionId = "native-b";
    if (field === "instanceId") f.live.instanceId = "55555555-5555-4555-8555-555555555555";
    if (field === "lastUserMessageAt") f.live.lastUserMessageAt = new Date("2030-01-02T00:00:00Z");
    if (field === "serviceTier") {
      f.live.provider = "codex";
      (f.live.features as unknown[]).push({ id: "fast_mode", type: "toggle", value: true });
    }
    expect(() => f.manager.tryRunOutOfBand(id, "work")).toThrow();
    expect(f.provider).not.toHaveBeenCalled();
  },
);

test("P4: authoritative parent human fence refuses worker send, permission and MCP; unknown IDs never allocate", async () => {
  let api!: TrustedPluginServerV11;
  const f = fixture((server) => {
    api = server;
    const allowed = () => api.inputObservations.require(parentId).humanAt === 0;
    server.admission.onInput((agent) => (agent.id === parentId || allowed() ? "allow" : "deny"));
    server.guard("agent.permission_respond", () => (allowed() ? "allow" : "deny"));
    server.admission.mcpRefresh(() => ({ allowed: allowed(), revision: "one" }));
  });
  expect(api.inputObservations.require(parentId)).toEqual({ boot: f.host.boot, humanAt: 0 });
  f.host.rpc(undefined, () =>
    f.host.input(
      { ...f.live, id: parentId },
      "prompt",
      undefined,
      () => undefined,
      promptPayload("human"),
    ),
  );
  expect(() => f.manager.tryRunOutOfBand(id, "worker")).toThrow();
  await expect(
    f.manager.respondToPermission(id, "request", { behavior: "allow" }),
  ).rejects.toThrow();
  expect(() => f.host.mcpRefresh(f.live)).toThrow();
  for (let i = 0; i < 3; i++) expect(() => api.inputObservations.require("missing")).toThrow();
  expect(Reflect.get(f.host, "sequences").has("missing")).toBe(false);
  f.host.deleteKnownAgent(parentId);
  expect(() => api.inputObservations.require(parentId)).toThrow();
  expect(() => f.host.addKnownAgent(parentId)).toThrow();
  const restarted = new TrustedPlugins();
  hosts.push(restarted);
  restarted.initializeKnownAgents([id]);
  expect(restarted.boot).not.toBe(f.host.boot);
  expect(() => restarted.requireSequence(parentId)).toThrow();
});

test("P1: explicit nesting preserves one primary operation; ambient callbacks cannot borrow it", () => {
  const seen: string[] = [];
  const f = fixture((server) =>
    server.admission.onInput((_agent, input) => {
      seen.push(input.operation.operationId);
      return "allow";
    }),
  );
  const payload = promptPayload("work", { clientMessageId: "orca-control:example" });
  let handle: ReturnType<TrustedPlugins["captureOperation"]>;
  f.host.rpc(f.token(payload), () =>
    f.host.input(
      f.live,
      "prompt",
      "orca-control:example",
      () => {
        handle = f.host.captureOperation();
        f.host.input(f.live, "prompt", "orca-control:example", noop, payload, handle);
        f.host.input(f.live, "prompt", "human-follow-up", noop, promptPayload("human"));
      },
      payload,
    ),
  );
  expect(seen).toHaveLength(3);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[2]).not.toBe(seen[0]);
  expect(f.host.requireSequence(id).humanAt).toBe(0);
  expect(() =>
    f.host.input(
      f.live,
      "prompt",
      "orca-control:example",
      () => undefined,
      promptPayload("changed"),
      handle,
    ),
  ).toThrow(/changed/);
  expect(() =>
    f.host.input(
      { ...f.live, id: parentId },
      "prompt",
      "orca-control:example",
      () => undefined,
      payload,
      handle,
    ),
  ).toThrow(/boundaries|cross/);
});

test("P4: incomplete index, deleted ID, closed host and exhausted counter fail closed", () => {
  const unindexed = new TrustedPlugins();
  hosts.push(unindexed);
  expect(() => unindexed.registerV11("fixture", true, () => undefined)).toThrow(/index/);
  const f = fixture();
  Reflect.get(f.host, "sequences").set(id, { boot: f.host.boot, humanAt: Number.MAX_SAFE_INTEGER });
  expect(() => f.api.inputObservations.require(id)).toThrow(/counter/);
  f.host.close();
  expect(() => f.api.inputObservations.require(parentId)).toThrow(/unavailable/);
});

test("P7: V1.1 requires atomic Codex callbacks and distinguishes legacy report", () => {
  const f = fixture((server) => {
    server.admission.onInput(() => "allow");
    server.guard("agent.permission_respond", () => "allow");
    server.claude.deny(() => []);
    server.admission.mcpRefresh(() => ({ allowed: true, revision: "one" }));
    server.admission.codexTurn({ check: () => "allow", onQuotaReadFailure: () => undefined });
  });
  expect(f.host.catalog()).toEqual([
    {
      id: "orca-organization-next",
      contract: "1.1",
      hooks: ["input", "permission", "deny", "mcp", "codex"],
    },
  ]);
  f.host.register("legacy", true, (server) => server.admission.codexTurn(() => "allow"));
  expect(f.host.catalog().find((item) => item.id === "legacy")).not.toHaveProperty("contract");
  const broken = new TrustedPlugins();
  hosts.push(broken);
  broken.initializeKnownAgents([]);
  expect(() =>
    broken.registerV11("bad", true, (server) =>
      server.admission.codexTurn({ check: () => "allow" } as never),
    ),
  ).toThrow(/callbacks/);
});

test("P7: captured Book catalog with automatic policy preserves all admission fences", () => {
  const f = fixture((server) => {
    server.permissions.automatic(() => "ask");
    server.admission.onInput(() => "allow");
    server.guard("agent.permission_respond", () => "allow");
    server.admission.nativeQueuedReceipt(noop);
    server.claude.deny(() => []);
    server.admission.mcpRefresh(() => ({ allowed: true, revision: "one" }));
    server.admission.codexTurn({ check: () => "allow", onQuotaReadFailure: () => undefined });
  });
  const activate = (catalog: unknown) =>
    isTrustedCatalogV11(catalog, "orca-organization-next", f.host.boot);
  const complete = {
    // Real Book catalog shape; runtime boot and bundle content are inert here.
    plugins: [{ id: "orca-organization-next", clientBundle: " ".repeat(844107) }],
    trustedHost: { contract: "1.1", boot: f.host.boot },
    trustedPlugins: f.host.catalog(),
  };
  expect(activate(complete)).toBe(true);
  expect(complete.trustedPlugins[0]?.hooks).toContain("queuedReceipt");
  expect(complete.trustedPlugins[0]?.hooks).toEqual([
    "automatic",
    "input",
    "permission",
    "queuedReceipt",
    "deny",
    "mcp",
    "codex",
  ]);
  const capturedHookOrder = [
    "automatic",
    "input",
    "permission",
    "queuedReceipt",
    "deny",
    "mcp",
    "codex",
  ];
  expect(
    activate({
      ...complete,
      trustedPlugins: [{ ...complete.trustedPlugins[0], hooks: capturedHookOrder }],
    }),
  ).toBe(true);
  for (const hooks of [
    ["input", "permission", "deny", "mcp", "queuedReceipt"],
    ["input", "permission", "deny", "mcp", "codex", "queuedReceipt", "queuedReceipt"],
    ["input", "permission", "deny", "mcp", "codex", "unknown"],
  ]) {
    expect(
      activate({
        ...complete,
        trustedPlugins: [{ ...complete.trustedPlugins[0], hooks }],
      }),
    ).toBe(false);
  }
  expect(activate({})).toBe(false);
  expect(activate({ ...complete, trustedHost: { contract: "1.1", boot: "old" } })).toBe(false);
  expect(
    activate({ ...complete, trustedPlugins: [{ ...complete.trustedPlugins[0], id: "foreign" }] }),
  ).toBe(false);
  expect(
    activate({
      ...complete,
      trustedPlugins: [complete.trustedPlugins[0], complete.trustedPlugins[0]],
    }),
  ).toBe(false);
  expect(
    activate({
      ...complete,
      trustedPlugins: [
        { ...complete.trustedPlugins[0], hooks: ["input", "permission", "deny", "mcp"] },
      ],
    }),
  ).toBe(false);
  expect(
    activate({
      ...complete,
      trustedPlugins: [{ ...complete.trustedPlugins[0], contract: undefined }],
    }),
  ).toBe(false);
});

test("P1: an unverified controller prefix is denied and advances the human fence", () => {
  const f = fixture((server) =>
    server.admission.onInput((_agent, input) =>
      input.provenance?.pluginId === "orca-organization-next" ? "allow" : "deny",
    ),
  );
  expect(() =>
    f.host.rpc(undefined, () =>
      f.manager.tryRunOutOfBand(id, "work", { clientMessageId: "orca-control:forged" }),
    ),
  ).toThrow();
  expect(f.host.requireSequence(id).humanAt).toBe(1);
  expect(f.provider).not.toHaveBeenCalled();
});

test.each(["input", "name", "root", "generation", "actions"] as const)(
  "P2: changed %s under an unchanged provider ID invalidates permission intent",
  async (field) => {
    const f = fixture((server) =>
      server.guard("agent.permission_respond", (agent) => {
        if (agent.permissions.status !== "known") return "deny";
        const expected = {
          id: "request",
          provider: "claude",
          name: "Write",
          kind: "tool",
          input: { file_path: "/owned/safe.txt" },
          metadata: { generation: 1 },
        };
        return JSON.stringify(agent.permissions.requests[0]) === JSON.stringify(expected)
          ? { requestId: "request" }
          : "deny";
      }),
    );
    const request = f.live.pendingPermissions.get("request")!;
    if (field === "input") request.input.file_path = "/private/secret";
    if (field === "name") request.name = "Delete";
    if (field === "generation") request.metadata.generation = 2;
    if (field === "root") Object.assign(request.metadata, { root: "/foreign" });
    if (field === "actions")
      Object.assign(request, {
        actions: [{ id: "destructive", label: "Delete", behavior: "allow" }],
      });
    await expect(
      f.manager.respondToPermission(id, "intent", { behavior: "allow" }),
    ).rejects.toThrow();
    expect(f.permission).not.toHaveBeenCalled();
  },
);

test("P1: bound unarchive cannot smuggle new workspace or label effects", () => {
  const f = fixture((server) => server.admission.onInput(() => "allow"));
  const payload = promptPayload(
    "work",
    { clientMessageId: "orca-control:example" },
    { unarchive: true },
  );
  const handle = f.host.rpc(f.token(payload), () =>
    f.host.input(
      f.live,
      "prompt",
      "orca-control:example",
      () => f.host.captureOperation(),
      payload,
    ),
  );
  expect(() =>
    f.host.input(f.live, "unarchive", undefined, noop, commandPayload("unarchive"), handle),
  ).not.toThrow();
  for (const arguments_ of [{ workspaceId: "other" }, { labels: { owner: "other" } }]) {
    expect(() =>
      f.host.input(
        f.live,
        "unarchive",
        undefined,
        noop,
        commandPayload("unarchive", arguments_),
        handle,
      ),
    ).toThrow(/Unbound/);
  }
});

test("R1 M4: resuming a handle without actual payload refuses before work", () => {
  const f = fixture();
  const payload = promptPayload("work");
  const handle = f.host.input(
    f.live,
    "prompt",
    undefined,
    () => f.host.captureOperation(),
    payload,
  );
  const effect = vi.fn();
  expect(() => f.host.input(f.live, "prompt", undefined, effect, undefined, handle)).toThrow(
    /payload unavailable/,
  );
  expect(effect).not.toHaveBeenCalled();
});

test.each(["legacy-first", "modern-first"])(
  "R1 M2: %s tokens stay unattributed to modern hooks",
  (order) => {
    const host = new TrustedPlugins();
    hosts.push(host);
    host.initializeKnownAgents([id]);
    let legacy!: import("@getpaseo/plugin/server").TrustedPluginServer;
    let modern!: TrustedPluginServerV11;
    const legacySeen = vi.fn<Parameters<typeof legacy.admission.onInput>[0]>(() => "allow");
    const seen = vi.fn<Parameters<TrustedPluginServerV11["admission"]["onInput"]>[0]>(
      () => "allow",
    );
    const old = () =>
      host.register("legacy", true, (server) => {
        legacy = server;
        server.admission.onInput(legacySeen);
      });
    const next = () =>
      host.registerV11("modern", true, (server) => {
        modern = server;
        server.admission.onInput(seen);
      });
    if (order === "legacy-first") {
      old();
      next();
    } else {
      next();
      old();
    }
    const payload = promptPayload("work");
    host.rpc(legacy.issueProvenance({ agentId: id, kind: "prompt", messageId: null }), () =>
      host.input({ id }, "prompt", undefined, noop, payload),
    );
    expect(seen.mock.calls[0]?.[1]).toMatchObject({
      source: "human",
      provenance: null,
      operation: { pluginId: null, attemptId: null },
    });
    const token = modern.issueProvenance({
      agentId: id,
      kind: "prompt",
      messageId: null,
      attemptId,
      payloadDigest: createHash("sha256")
        .update(canonicalTrustedPayload({ agentId: id, kind: "prompt", messageId: null, payload }))
        .digest("hex") as Sha256,
    });
    host.rpc(token, () => host.input({ id }, "prompt", undefined, noop, payload));
    expect(seen.mock.calls[1]?.[1]).toMatchObject({
      source: "plugin",
      provenance: { pluginId: "modern" },
      operation: { pluginId: "modern" },
    });
    expect(legacySeen.mock.calls[0]?.[1]).toMatchObject({
      source: "plugin",
      provenance: { pluginId: "legacy" },
    });
    expect(legacySeen.mock.calls[1]?.[1]).toMatchObject({
      source: "plugin",
      provenance: { pluginId: "modern" },
    });
    expect(host.requireSequence(id).humanAt).toBe(1);
  },
);

test("R1 minor 1: strict prompt and index validation activates only for V1.1", () => {
  const host = new TrustedPlugins();
  hosts.push(host);
  expect(() => host.initializeKnownAgents(["legacy-id"])).not.toThrow();
  const manager = new AgentManager({ logger: createTestLogger(), trustedPlugins: host });
  const provider = vi.fn();
  vi.spyOn(manager, "getAgent").mockReturnValue({
    id,
    session: { tryHandleOutOfBand: provider },
  } as never);
  // withInput loads through getAgent; the OOB implementation uses its live map.
  Reflect.get(manager, "agents").set(id, {
    id,
    session: { tryHandleOutOfBand: provider },
  });
  expect(() => manager.tryRunOutOfBand(id, { text: "legacy" } as never)).not.toThrow();
  expect(provider).toHaveBeenCalled();
  expect(() => host.registerV11("modern", true, noop)).toThrow();
  const f = fixture();
  expect(() => f.manager.tryRunOutOfBand(id, { text: "legacy" } as never)).toThrow();
  expect(f.provider).not.toHaveBeenCalled();
});

test("R1 M4: verified context missing its handle still requires actual payload", () => {
  const f = fixture();
  const payload = promptPayload("work", { clientMessageId: "orca-control:example" });
  const effect = vi.fn();
  const check = () => {
    Reflect.get(f.host, "context").getStore().handle = undefined;
    expect(() =>
      Reflect.get(f.host, "admitInput").call(
        f.host,
        f.live,
        "prompt",
        "orca-control:example",
        effect,
      ),
    ).toThrow(/payload unavailable/);
  };
  f.host.rpc(f.token(payload), () =>
    f.host.input(f.live, "prompt", "orca-control:example", check, payload),
  );
  expect(effect).not.toHaveBeenCalled();
});

test("V4 stale provider recovery permits only a configuration-preserving reload", () => {
  const f = fixture((server) => server.admission.onInput(() => "allow"));
  const payload = promptPayload("work", { clientMessageId: "orca-control:example" });
  const handle = f.host.rpc(f.token(payload), () =>
    f.host.input(
      f.live,
      "prompt",
      "orca-control:example",
      () => f.host.captureOperation(),
      payload,
    ),
  );
  const effect = vi.fn(() => expect(f.host.captureOperation()).toBe(handle));
  expect(() =>
    f.host.input(f.live, "configure", undefined, effect, commandPayload("reload"), handle),
  ).not.toThrow();
  expect(effect).toHaveBeenCalledOnce();
  for (const args of [
    { overrides: { model: "other" } },
    { options: { rehydrateFromDisk: true } },
    { overrides: {} },
  ]) {
    expect(() =>
      f.host.input(f.live, "configure", undefined, effect, commandPayload("reload", args), handle),
    ).toThrow(/Unbound/);
  }
  expect(() =>
    f.host.input(f.live, "cancel", undefined, effect, commandPayload("cancel"), handle),
  ).toThrow(/Unbound/);
  expect(effect).toHaveBeenCalledOnce();
});

// W1 row 9 (H7b): the host's orderly-shutdown closure is visible to trusted plugins by its call path; nothing else is.
test("W1 H7b: shutdownClosure input carries cause shutdown for every agent it closes; other input is unchanged", async () => {
  const seen: { agent: string; source: string; cause: unknown; keys: string }[] = [];
  const f = fixture((server) =>
    server.admission.onInput((agent, input) => {
      seen.push({
        agent: agent.id,
        source: input.source,
        cause: input.cause,
        keys: Object.keys(input).join(),
      });
      return "allow";
    }),
  );
  const close = (agentId: string) =>
    f.host.input({ ...f.live, id: agentId }, "close", undefined, noop, commandPayload("close"));
  // One shared closure context, as closeAllAgents: the second close is admitted as a follow-up and keeps the cause.
  await f.host.shutdownClosure(async () => {
    close(id);
    await Promise.resolve();
    close(parentId);
  });
  expect(seen.map(({ agent, source, cause }) => [agent, source, cause])).toEqual([
    [id, "daemon", "shutdown"],
    [parentId, "daemon", "shutdown"],
  ]);
  expect(f.host.requireSequence(id).humanAt).toBe(0);
  seen.length = 0;
  f.host.daemon(() => close(id)); // e.g. provider retirement: an ordinary daemon close
  f.host.rpc(undefined, () => close(id));
  f.host.agentInput(() => close(id));
  expect(seen.map(({ source, cause, keys }) => [source, cause, keys])).toEqual([
    ["daemon", undefined, "kind,messageId,source,provenance,operation"],
    ["human", undefined, "kind,messageId,source,provenance,operation"],
    ["agent", undefined, "kind,messageId,source,provenance,operation"],
  ]);
});

// Review W1-2: cause belongs to the host's own closure input only, never to a verified plugin's input. No public path
// gives the closure context a capability today, so the test injects one to pin the invariant (mutation P3).
test("W1-2: a verified plugin input admitted inside shutdownClosure carries no cause", () => {
  const seen: Record<string, unknown>[] = [];
  const f = fixture((server) =>
    server.admission.onInput((_agent, input) => {
      seen.push({ ...input });
      return "allow";
    }),
  );
  const payload = commandPayload("close");
  const token = f.token(payload, "close", null);
  f.host.shutdownClosure(() => {
    Reflect.get(f.host, "context").getStore().token = token;
    f.host.input(f.live, "close", undefined, noop, payload);
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.source).toBe("plugin");
  expect("cause" in (seen[0] ?? {})).toBe(false);
});

test("the plugin's context-rotation answer reaches the manager; absent or false refuses", () => {
  let rotate: boolean | undefined = true;
  const f = fixture((server) =>
    server.admission.mcpRefresh(() => ({
      allowed: true,
      revision: "one",
      ...(rotate === undefined ? {} : { contextRotationAllowed: rotate }),
    })),
  );
  expect(f.host.mcpRefresh(f.live).contextRotationAllowed).toBe(true);
  rotate = false;
  expect(f.host.mcpRefresh(f.live).contextRotationAllowed).toBe(false);
  rotate = undefined;
  expect(f.host.mcpRefresh(f.live).contextRotationAllowed).toBe(false);
});
