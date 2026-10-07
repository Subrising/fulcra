import { admissionCheck, admissionDiagnostic, admissionOutcome } from "./admission-outcome.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalTrustedPayload, type Sha256 } from "@getpaseo/protocol/trusted-input";
import { RpcErrorMessageSchema, type SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { TrustedPluginServerV11 } from "@getpaseo/plugin/server";
import { TrustedPlugins, AdmissionDeniedError } from "./trusted.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { Session } from "../session.js";
import { MessageReceipts } from "../message-receipts/index.js";
import { promptPayload } from "../agent/trusted-operation.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "host-refusal-")),
    logger = createTestLogger();
  const storage = new AgentStorage(join(home, "agents"), logger);
  await storage.initialize();
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  let api!: TrustedPluginServerV11,
    deny = false,
    effects = 0,
    effect: (() => void) | undefined;
  host.registerV11("fixture", true, (server) => {
    api = server;
    server.admission.onInput(() => (deny ? "deny" : "allow"));
  });
  const manager = new AgentManager({
    registry: storage,
    logger,
    trustedPlugins: host,
    clients: {
      claude: createTestAgentClient("claude", {
        onStartTurn: () => {
          effects++;
          effect?.();
        },
      }),
    },
  });
  const agent = await manager.createAgent(
    { provider: "claude", model: "fixture-model", cwd: home },
    undefined,
    { workspaceId: undefined },
  );
  const messages: SessionOutboundMessage[] = [];
  const emit = (message: SessionOutboundMessage) => {
    messages.push(message);
  };
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    agentManager: manager,
    agentStorage: storage,
    sessionLogger: logger,
    authorization: { allowsInbound: () => true },
    inflightRequests: 0,
    peakInflightRequests: 0,
    messageReceipts: new MessageReceipts(join(home, "receipts")),
    emit,
    delivery: {
      request: (_source: unknown, _message: unknown, run: () => unknown) => run(),
      requestSignal: new AbortController().signal,
      isModern: () => true,
      reply: emit,
    },
  });
  cleanup.push(async () => {
    deny = false;
    effect = undefined;
    const live = manager.getAgent(agent.id);
    if (live) {
      live.runtimeInfo.model = "fixture-model";
      await host.daemon(() => manager.closeAgent(agent.id));
    }
    await manager.flush();
    host.close();
    await rm(home, { recursive: true, force: true });
  });
  const text = "Owned instruction",
    messageId = randomUUID();
  const token = () =>
    api.issueProvenance({
      agentId: agent.id,
      kind: "prompt",
      messageId,
      attemptId: randomUUID(),
      payloadDigest: createHash("sha256")
        .update(
          canonicalTrustedPayload({
            agentId: agent.id,
            kind: "prompt",
            messageId,
            payload: promptPayload(
              text,
              { clientMessageId: messageId, clearPendingPermissions: true },
              { unarchive: true, replaceRunning: true, activeTurnBehavior: "interrupt" },
            ),
          }),
        )
        .digest("hex") as Sha256,
    });
  const send = async (inputProvenance?: string, id = messageId) => {
    messages.length = 0;
    await session.handleMessage({
      type: "send_agent_message_request",
      requestId: randomUUID(),
      agentId: agent.id,
      text,
      messageId: id,
      inputProvenance,
    });
    return messages.find(
      (m) => m.type === "rpc_error" || m.type === "send_agent_message_response",
    )!;
  };
  return {
    host,
    manager,
    agent,
    api,
    session,
    messages,
    send,
    token,
    deny: () => {
      deny = true;
    },
    effect: (run: () => void) => {
      effect = run;
    },
    effects: () => effects,
  };
}
const refused = (message: SessionOutboundMessage) =>
  expect(message).toMatchObject({
    type: "rpc_error",
    payload: { code: "admission_refused", nativeDispatched: false },
  });
test("input hook denial produces a host-generated no-dispatch RPC outcome", async () => {
  const f = await fixture();
  f.deny();
  refused(await f.send());
  expect(f.effects()).toBe(0);
});
test("missing host facts produce a typed refusal", async () => {
  const f = await fixture();
  f.host.registerV11("facts", true, (s) =>
    s.admission.onInput((a) => {
      if (a.runtime.status !== "known" || a.runtime.model === null)
        throw Error("Required runtime missing");
      return "allow";
    }),
  );
  f.manager.getAgent(f.agent.id)!.runtimeInfo.model = null;
  f.manager.getAgent(f.agent.id)!.config.model = undefined;
  refused(await f.send());
  expect(f.effects()).toBe(0);
});
test("invalid and replayed provenance produce typed refusals", async () => {
  const f = await fixture();
  refused(await f.send("invalid", randomUUID()));
  const token = f.token();
  f.deny();
  refused(await f.send(token));
  refused(await f.send(token, randomUUID()));
  expect(f.effects()).toBe(0);
});
test("trusted permission guard denial produces a typed refusal", async () => {
  const f = await fixture();
  f.host.registerV11("permission", true, (s) => s.guard("agent.permission_respond", () => "deny"));
  await f.session.handleMessage({
    type: "agent_permission_response",
    agentId: f.agent.id,
    requestId: "permission",
    response: { behavior: "allow" },
  });
  refused(f.messages.find((m) => m.type === "rpc_error")!);
  expect(f.effects()).toBe(0);
});
for (const kind of ["text", "forged-class", "after-start"] as const)
  test(`provider ${kind} failure cannot claim a no-dispatch outcome`, async () => {
    const f = await fixture();
    f.effect(() => {
      if (kind === "after-start") {
        f.deny();
        f.host.input(f.agent, "cancel", undefined, () => undefined, {
          type: "command",
          command: "cancel",
          arguments: {},
        });
      }
      throw kind === "forged-class"
        ? new AdmissionDeniedError("refused")
        : Error("Orca native admission refused: provider failure");
    });
    const result = await f.send();
    expect(f.effects()).toBe(1);
    expect(result).toBeDefined();
    expect(result.payload).not.toHaveProperty("nativeDispatched");
    expect(result.payload).not.toHaveProperty("code", "admission_refused");
  });
test("a frozen old RPC error schema ignores the optional refusal field", () => {
  const old = z.object({
    type: z.literal("rpc_error"),
    payload: z.object({
      requestId: z.string(),
      requestType: z.string().optional(),
      error: z.string(),
      code: z.string().optional(),
    }),
  });
  const message = {
    type: "rpc_error",
    payload: {
      requestId: "r",
      error: "Admission refused",
      code: "admission_refused",
      nativeDispatched: false,
    },
  };
  expect(old.parse(message).payload).not.toHaveProperty("nativeDispatched");
  expect(RpcErrorMessageSchema.parse(message).payload).toHaveProperty("nativeDispatched", false);
});

for (const type of [
  "cancel_agent_request",
  "archive_agent_request",
  "agent.detach.request",
] as const) {
  test(`${type} preserves an input admission refusal`, async () => {
    const f = await fixture();
    f.deny();
    await f.session.handleMessage({ type, agentId: f.agent.id, requestId: randomUUID() });
    refused(f.messages.find((message) => message.type === "rpc_error")!);
    expect(f.effects()).toBe(0);
  });
}

test("native archive restore marks dispatch before a nested admission failure", async () => {
  const f = await fixture();
  await f.manager.archiveAgent(f.agent.id);
  let restores = 0;
  Reflect.set(
    f.manager,
    "syncNativeArchiveState",
    async (_provider: unknown, _handle: unknown, action: string) => {
      expect(action).toBe("restore");
      restores++;
      admissionCheck(() => {
        throw new Error("refused after native restore");
      });
    },
  );
  await f.host.rpc(undefined, async () => {
    try {
      await f.manager.unarchiveSnapshot(f.agent.id);
      throw new Error("Expected restore failure");
    } catch (error) {
      expect(restores).toBe(1);
      expect(admissionOutcome(error)).toBeUndefined();
    }
  });
});

test("a refusal with no request to carry it back is logged with the plugin's reason", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    admissionDiagnostic(new AdmissionDeniedError(), "Live runtime or permission facts unavailable");
    expect(warn).toHaveBeenCalledWith(
      "[trusted-plugin] input hook refused: Live runtime or permission facts unavailable",
    );
  } finally {
    warn.mockRestore();
  }
});
