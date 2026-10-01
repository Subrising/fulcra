import { expect, test, vi } from "vitest";
import type { TrustedPluginServer } from "@getpaseo/plugin/server";
import { Session } from "./session.js";
import { AgentManager } from "./agent/agent-manager.js";
import { TrustedPlugins } from "./plugins/trusted.js";
import { createTestLogger } from "../test-utils/test-logger.js";

test("trusted Session RPC scope verifies daemon provenance instead of message prefixes", async () => {
  const authority = new TrustedPlugins();
  let sdk!: TrustedPluginServer;
  const seen = vi.fn<Parameters<TrustedPluginServer["admission"]["onInput"]>[0]>(() => "allow");
  authority.register("fixture-guard", true, (server) => {
    sdk = server;
    server.admission.onInput(seen);
  });
  const manager = new AgentManager({ logger: createTestLogger(), trustedPlugins: authority });
  vi.spyOn(manager, "getAgent").mockReturnValue({ id: "fixture", provider: "codex" } as never);
  // Exercise the real entry method without starting transports or integrations.
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    agentManager: manager,
    delivery: {
      request: (_source: unknown, _message: unknown, operation: () => unknown) => operation(),
    },
    handleRequest: (message: { messageId?: string }) =>
      manager.withInput("fixture", "prompt", message.messageId, () => undefined),
  });
  try {
    await session.handleMessage({
      type: "send_agent_message",
      agentId: "fixture",
      text: "input",
      messageId: "orca-control:fake",
    });
    expect(seen.mock.calls[0]?.[1]).toMatchObject({ provenance: null, source: "human" });
    const inputProvenance = sdk.issueProvenance({
      agentId: "fixture",
      kind: "prompt",
      messageId: "bound",
    });
    await session.handleMessage({
      type: "send_agent_message",
      agentId: "fixture",
      text: "input",
      messageId: "bound",
      inputProvenance,
    });
    expect(seen.mock.calls[1]?.[1]).toMatchObject({
      provenance: { pluginId: "fixture-guard" },
      source: "plugin",
    });
    expect(authority.sequence("fixture").humanAt).toBe(1);
  } finally {
    authority.close();
  }
});

test("trusted Session interruption rejects before consulting or cancelling a runtime", async () => {
  for (const decision of ["deny", "throw"] as const) {
    const authority = new TrustedPlugins();
    authority.register("fixture-guard", true, (server) =>
      server.admission.onInput((_agent, input) => {
        expect(input.kind).toBe("interrupt");
        if (decision === "throw") throw new Error("fixture failure");
        return "deny";
      }),
    );
    const read = vi.fn(() => null);
    const cancel = vi.fn();
    const session = Object.create(Session.prototype) as Session;
    Object.assign(session, {
      agentManager: {
        withInput: (
          _id: string,
          kind: "interrupt",
          messageId: undefined,
          operation: () => unknown,
        ) => authority.input({ id: "fixture" }, kind, messageId, operation),
        getAgent: read,
        cancelAgentRun: cancel,
      },
    });
    try {
      await expect(
        Reflect.get(session, "interruptAgentIfRunning").call(session, "fixture"),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      authority.close();
    }
  }
});

test("R1 P7: real Session catalog request emits trustedHost in the wire response", async () => {
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  host.registerV11("fixture", true, (server) => server.admission.onInput(() => "allow"));
  const manager = new AgentManager({ logger: createTestLogger(), trustedPlugins: host });
  const emit = vi.fn();
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    agentManager: manager,
    sessionLogger: createTestLogger(),
    authorization: { allowsInbound: () => true },
    emit,
    pluginRuntime: { catalog: () => [] },
    delivery: {
      request: (_source: unknown, _message: unknown, operation: () => unknown) => operation(),
    },
  });
  try {
    await session.handleMessage({
      type: "plugin.catalog.get.request",
      requestId: "catalog-roundtrip",
    });
    expect(emit).toHaveBeenCalledWith({
      type: "plugin.catalog.get.response",
      payload: {
        requestId: "catalog-roundtrip",
        plugins: [],
        trustedHost: { contract: "1.1", boot: host.boot },
        trustedPlugins: host.catalog(),
      },
    });
  } finally {
    host.close();
  }
});
