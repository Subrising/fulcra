import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { addSendOptions, runSendCommand } from "./send";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../../utils/client.js", () => ({ connectToDaemon: connection }));
const routes = vi.hoisted(() => ({
  readSendRoute: vi.fn(),
  sshSend: vi.fn(),
  readRemoteSendHost: vi.fn(),
}));
vi.mock("../../utils/send-route.js", () => routes);
const senderStamp = vi.hoisted(() => vi.fn((): { agentId: string } | null => null));
const senderHost = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../utils/send-sender.js", () => ({
  resolveSender: senderStamp,
  assertSenderDaemon: senderHost,
}));
const daemonTarget = { kind: "endpoint" as const, host: "fixture.test:1234" };
const messageId = "native-message-1";
let client: ReturnType<typeof fakeClient>;
function fakeClient() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    getLastServerInfoMessage: vi.fn(() => ({
      serverId: "source-host",
      features: { agentSendReceipts: true, agentSendReportingLines: true },
    })),
    checkAgentMessageRoute: vi.fn().mockResolvedValue({ kind: "outbound", inboundOnly: false }),
    sendAgentMessage: vi.fn().mockResolvedValue(undefined),
    sendNativeQueuedMessage: vi
      .fn()
      .mockResolvedValue({ messageId, state: "queued", pendingCount: 1 }),
    waitForFinish: vi.fn().mockResolvedValue({ status: "idle", final: { id: "resolved-target" } }),
    fetchAgent: vi.fn().mockResolvedValue({ agent: { id: "resolved-target" } }),
    listCommands: vi.fn().mockResolvedValue({ commands: [{ name: "compact" }] }),
    invokePluginRpc: vi.fn().mockResolvedValue({ ok: true, message: "Continued on Personal." }),
  };
}
async function parsedSend(flags: string[]) {
  let result: Awaited<ReturnType<typeof runSendCommand>> | undefined;
  const cmd = addSendOptions(new Command("send"));
  cmd.action(async (id, prompt, options, command) => {
    result = await runSendCommand(id, prompt, { ...options, daemonTarget }, command);
  });
  await cmd.parseAsync(["node", "send", ...flags]);
  return result!;
}
beforeEach(() => {
  client = fakeClient();
  connection.mockResolvedValue(client);
  routes.readSendRoute.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  senderStamp.mockReturnValue(null);
});

describe("agent queue and steer", () => {
  it.each([{ flags: [] }, { flags: ["--no-wait"] }, { flags: ["--steer"] }])(
    "returns held without waiting for a paused receiver: %j",
    async ({ flags }) => {
      client.sendAgentMessage.mockImplementation(async (_id, _prompt, options) => {
        options.onDelivery("Provider paused. Notice saved. No turn was started.", "held");
      });
      const result = await parsedSend(["target", "draft", ...flags]);
      expect(result.data.status).toBe("held");
      expect(result.data.message).toContain("No turn was started");
      expect(client.waitForFinish).not.toHaveBeenCalled();
    },
  );
  it.each(["accepted; delivered after the current turn", "accepted; delivered now"])(
    "prints the daemon receipt: %s",
    async (receipt) => {
      senderStamp.mockReturnValue({ agentId: "sender" });
      client.sendAgentMessage.mockImplementation(async (_id, _prompt, options) => {
        options.onDelivery(receipt);
      });
      const result = await parsedSend(["target", "draft", "--no-wait"]);
      expect(result.data.message).toBe(receipt);
      expect(client.waitForFinish).not.toHaveBeenCalled();
    },
  );
  it.each([{ flags: [] }, { flags: ["--queue"] }])(
    "queues agent sends by default: %j",
    async ({ flags }) => {
      senderStamp.mockReturnValue({ agentId: "sender" });
      await parsedSend(["target", "draft", "--no-wait", ...flags]);
      expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("target", "draft", {
        images: undefined,
        sender: { agentId: "sender" },
        queue: true,
        onDelivery: expect.any(Function),
      });
    },
  );
  it("requests native steering and shows a queue fallback", async () => {
    senderStamp.mockReturnValue({ agentId: "sender" });
    client.sendAgentMessage.mockImplementation(async (_id, _prompt, options) => {
      options.onDelivery("Native steering is unavailable. Message queued for the end of the turn.");
    });
    const result = await parsedSend(["target", "draft", "--steer", "--no-wait"]);
    expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("target", "draft", {
      images: undefined,
      sender: { agentId: "sender" },
      activeTurnBehavior: "steer",
      onDelivery: expect.any(Function),
    });
    expect(result.data.message).toBe(
      "Native steering is unavailable. Message queued for the end of the turn.",
    );
  });
  it("refuses conflicting modes before connecting", async () => {
    await expect(parsedSend(["target", "draft", "--queue", "--steer"])).rejects.toMatchObject({
      code: "CONFLICTING_SEND_MODE",
    });
    expect(connection).not.toHaveBeenCalled();
  });
  it("keeps the steer fallback note when waiting for completion", async () => {
    senderStamp.mockReturnValue({ agentId: "sender" });
    client.sendAgentMessage.mockImplementation(async (_id, _prompt, options) => {
      options.onDelivery("Native steering is unavailable. Message queued for the end of the turn.");
    });
    const result = await parsedSend(["target", "draft", "--steer"]);
    expect(result.data.message).toContain(
      "Native steering is unavailable. Message queued for the end of the turn.",
    );
  });
});

describe("configured SSH sends", () => {
  const selected = { agentId: "remote-target", route: { host: "remote host" } };
  const missing = { code: "AGENT_NOT_FOUND", message: "Agent not found: target" };
  it("keeps a local hit on the local daemon", async () => {
    routes.readSendRoute.mockResolvedValue(selected);
    await parsedSend(["target", "draft", "--no-wait"]);
    expect(routes.readSendRoute).not.toHaveBeenCalled();
    expect(routes.sshSend).not.toHaveBeenCalled();
  });
  it("uses the configured route only after a local AGENT_NOT_FOUND", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    senderStamp.mockReturnValue({ agentId: "sender" });
    routes.readSendRoute.mockResolvedValue(selected);
    routes.sshSend.mockResolvedValue({
      agentId: "remote-target",
      status: "held",
      message: "Paused.",
    });
    const result = await parsedSend(["target", "draft", "--no-wait"]);
    expect(routes.sshSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...selected,
        sender: { agentId: "sender" },
        localServerId: "source-host",
        prompt: "draft",
      }),
    );
    expect(result.data.status).toBe("held");
    expect(client.waitForFinish).not.toHaveBeenCalled();
  });
  it("asks the source before any SSH and preserves its one-level restriction", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    senderStamp.mockReturnValue({ agentId: "worker" });
    routes.readSendRoute.mockResolvedValue(selected);
    const policy = {
      kind: "outbound",
      inboundOnly: true,
      refusal: "Send this to your lead, Lead (lead-1).",
    };
    client.checkAgentMessageRoute.mockResolvedValue(policy);
    routes.readRemoteSendHost.mockImplementationOnce(async () => {
      expect(client.checkAgentMessageRoute).toHaveBeenCalledExactlyOnceWith({
        kind: "outbound",
        senderId: "worker",
        targetId: selected.agentId,
      });
      expect(routes.sshSend).not.toHaveBeenCalled();
      return { serverId: "remote", mainAssistantId: selected.agentId };
    });
    routes.sshSend.mockResolvedValue({
      agentId: selected.agentId,
      status: "refused",
      message: policy.refusal,
    });
    const result = await parsedSend(["role:main-assistant", "draft", "--no-wait"]);
    expect(result.data.message).toBe(policy.refusal);
    expect(routes.sshSend).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: { agentId: "worker", inboundOnly: true, refusal: policy.refusal },
      }),
    );
  });
  it("takes the own-lead mark only from the source check, never from a typed flag (FU-402)", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    senderStamp.mockReturnValue({ agentId: "worker", serverId: "book" });
    routes.readSendRoute.mockResolvedValue(selected);
    routes.readRemoteSendHost.mockResolvedValue({ serverId: "remote", mainAssistantId: null });
    routes.sshSend.mockResolvedValue({ agentId: selected.agentId, status: "sent", message: "" });
    client.checkAgentMessageRoute.mockResolvedValue({
      kind: "outbound",
      inboundOnly: true,
      refusal: "Send this to your lead.",
    });
    await parsedSend([
      "target",
      "draft",
      "--no-wait",
      "--from",
      "worker@book",
      "--outbound-parent",
      `${selected.agentId}@remote`,
    ]);
    expect(routes.sshSend.mock.calls[0]![0].sender).not.toHaveProperty("outboundParent");
    client.checkAgentMessageRoute.mockResolvedValue({
      kind: "outbound",
      inboundOnly: false,
      outboundServerOnly: "remote",
      outboundParent: `${selected.agentId}@remote`,
    });
    await parsedSend(["target", "draft", "--no-wait"]);
    expect(routes.sshSend.mock.calls[1]![0].sender).toMatchObject({
      outboundParent: `${selected.agentId}@remote`,
    });
  });
  it("does not contact SSH when the source cannot verify its sender", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    senderStamp.mockReturnValue({ agentId: "worker" });
    routes.readSendRoute.mockResolvedValue(selected);
    client.checkAgentMessageRoute.mockRejectedValue(new Error("Unknown source sender"));
    await expect(parsedSend(["target", "draft"])).rejects.toThrow("Unknown source sender");
    expect(routes.readRemoteSendHost).not.toHaveBeenCalled();
    expect(routes.sshSend).not.toHaveBeenCalled();
  });
  it("refuses a stamped sender on another selected daemon before sending", async () => {
    senderStamp.mockReturnValue({ agentId: "worker" });
    senderHost.mockRejectedValueOnce({ code: "SENDER_HOST_MISMATCH" });
    await expect(parsedSend(["target", "draft"])).rejects.toMatchObject({
      code: "SENDER_HOST_MISMATCH",
    });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(routes.sshSend).not.toHaveBeenCalled();
  });
  it("checks restricted receiver admission without input", async () => {
    client.checkAgentMessageRoute.mockResolvedValue({
      kind: "inbound",
      allowed: false,
      reason: "Send this to your lead.",
    });
    await expect(parsedSend(["target", "draft", "--check-only"])).rejects.toMatchObject({
      code: "SEND_REFUSED",
      message: "Send this to your lead.",
    });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });
  it("reports a local miss without a route", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    await expect(parsedSend(["target", "draft"])).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("local daemon"),
    });
    expect(routes.sshSend).not.toHaveBeenCalled();
  });
  it("requires the source receipt capability before using a route", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    routes.readSendRoute.mockResolvedValue(selected);
    client.getLastServerInfoMessage.mockReturnValue({
      serverId: "source-host",
      features: { agentSendReceipts: false, agentSendReportingLines: false },
    });
    await expect(parsedSend(["target", "draft"])).rejects.toThrow("Update the source host");
    expect(routes.sshSend).not.toHaveBeenCalled();
  });
  it("never starts another SSH route from the destination", async () => {
    vi.stubEnv("FULCRA_SEND_RELAYED", "1");
    client.sendAgentMessage.mockRejectedValue(missing);
    routes.readSendRoute.mockResolvedValue(selected);
    await expect(parsedSend(["target", "draft"])).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    expect(routes.readSendRoute).not.toHaveBeenCalled();
    expect(routes.sshSend).not.toHaveBeenCalled();
  });
  it.each([new Error("disconnected"), { code: "REFUSED", message: "Wrong reporting line" }])(
    "never routes a transport or reporting refusal: %j",
    async (error) => {
      client.sendAgentMessage.mockRejectedValue(error);
      await expect(parsedSend(["target", "draft"])).rejects.toBeDefined();
      expect(routes.readSendRoute).not.toHaveBeenCalled();
      expect(routes.sshSend).not.toHaveBeenCalled();
    },
  );
  it("keeps the remote identity refusal visible", async () => {
    client.sendAgentMessage.mockRejectedValue(missing);
    routes.readSendRoute.mockResolvedValue(selected);
    routes.sshSend.mockRejectedValue({
      code: "SEND_FAILED",
      message: "Remote reporting line refused.",
    });
    await expect(parsedSend(["target", "draft"])).rejects.toMatchObject({
      message: "Remote reporting line refused.",
    });
    expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe("send slash commands", () => {
  it.each(["/Volumes/x", "/Volumes/work/repo/foo.ts fix this", "/tmp/x.log why did this fail"])(
    "sends leading absolute paths as ordinary prompts: %s",
    async (prompt) => {
      await parsedSend(["target", prompt, "--no-wait"]);
      expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("target", prompt, {
        images: undefined,
        onDelivery: expect.any(Function),
      });
      expect(client.listCommands).not.toHaveBeenCalled();
      expect(client.invokePluginRpc).not.toHaveBeenCalled();
    },
  );
  it("switches accounts through the fenced plugin RPC without messaging the model", async () => {
    const result = await parsedSend(["target", "/account Personal"]);
    expect(client.invokePluginRpc).toHaveBeenCalledExactlyOnceWith(
      "orca-organization-next",
      "organization.accounts.switch",
      { agentId: "resolved-target", account: "Personal" },
    );
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).not.toHaveBeenCalled();
    expect(result.data.message).toBe("Continued on Personal.");
  });
  it("lists accounts without changing the session or messaging the model", async () => {
    client.invokePluginRpc.mockResolvedValue({
      accounts: [{ id: "personal", name: "Personal", status: { state: "ok" } }],
    });
    const result = await parsedSend(["target", "/account list"]);
    expect(client.invokePluginRpc).toHaveBeenCalledExactlyOnceWith(
      "orca-organization-next",
      "organization.accounts.session",
      { agentId: "resolved-target" },
    );
    expect(result.data.message).toBe("Personal: ok");
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });
  it("accepts /compact for a Claude session whose provider list lacks it", async () => {
    client.listCommands.mockResolvedValue({ commands: [{ name: "init" }] });
    client.fetchAgent.mockResolvedValue({ agent: { id: "resolved-target", provider: "claude" } });
    await parsedSend(["target", "/compact", "--no-wait"]);
    expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
  });
  it("still refuses /compact for a non-Claude session that lacks it", async () => {
    client.listCommands.mockResolvedValue({ commands: [{ name: "init" }] });
    client.fetchAgent.mockResolvedValue({ agent: { id: "resolved-target", provider: "codex" } });
    await expect(parsedSend(["target", "/compact"])).rejects.toMatchObject({ code: "SEND_FAILED" });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });
  it.each(["/foo", "/unknown"])(
    "refuses an unknown slash command and never falls through to the model: %s",
    async (prompt) => {
      await expect(parsedSend(["target", prompt])).rejects.toMatchObject({ code: "SEND_FAILED" });
      expect(client.sendAgentMessage).not.toHaveBeenCalled();
    },
  );
});

describe("send explicit native queue", () => {
  it.each([{ waitFlags: [] }, { waitFlags: ["--no-wait"] }])(
    "returns only a truthful queue receipt without completion waiting: %j",
    async ({ waitFlags }) => {
      const result = await parsedSend([
        "target",
        "retained draft",
        "--native-queue",
        "--message-id",
        messageId,
        ...waitFlags,
      ]);
      expect(client.sendNativeQueuedMessage).toHaveBeenCalledExactlyOnceWith(
        "target",
        "retained draft",
        { messageId },
      );
      expect(client.sendAgentMessage).not.toHaveBeenCalled();
      expect(client.waitForFinish).not.toHaveBeenCalled();
      expect(result.data).toEqual({
        agentId: "target",
        status: "queued",
        messageId,
        pendingCount: 1,
        message: "Message queued; not yet delivered or provider accepted",
      });
      expect(client.close).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves a queued receipt when connection cleanup fails", async () => {
    client.close.mockRejectedValue(new Error("cleanup failed"));
    const result = await parsedSend([
      "target",
      "draft",
      "--native-queue",
      "--message-id",
      messageId,
    ]);
    expect(result.data.status).toBe("queued");
    expect(result.data.messageId).toBe(messageId);
    expect(client.sendNativeQueuedMessage).toHaveBeenCalledTimes(1);
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });
  it("keeps no-wait alone as ordinary background send", async () => {
    const result = await parsedSend(["target", "ordinary", "--no-wait"]);
    expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("target", "ordinary", {
      images: undefined,
      onDelivery: expect.any(Function),
    });
    expect(client.sendNativeQueuedMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).not.toHaveBeenCalled();
    expect(result.data.status).toBe("sent");
  });
  it("waits with the identity of its own queued message", async () => {
    senderStamp.mockReturnValue({ agentId: "sender" });
    await parsedSend(["target", "second task"]);
    const options = client.sendAgentMessage.mock.calls[0]![2];
    expect(options.messageId).toEqual(expect.any(String));
    expect(client.waitForFinish).toHaveBeenCalledExactlyOnceWith("target", 600000, {
      messageId: options.messageId,
    });
  });
  it("preserves ordinary send completion waiting", async () => {
    const result = await parsedSend(["target", "ordinary"]);
    expect(client.sendNativeQueuedMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).toHaveBeenCalledExactlyOnceWith("target", 600000, {
      messageId: expect.any(String),
    });
    expect(result.data.status).toBe("completed");
    expect(result.data.agentId).toBe("resolved-target");
  });
  it.each([
    ["target", "draft", "--native-queue"],
    ["target", "draft", "--native-queue", "--message-id", " "],
    ["target", "draft", "--message-id", messageId],
    ["target", "/command", "--native-queue", "--message-id", messageId],
    ["target", "draft", "--native-queue", "--message-id", messageId, "--image", "/not-read.png"],
  ])("refuses invalid queue form before connection: %j", async (...flags) => {
    await expect(parsedSend(flags)).rejects.toMatchObject({ code: "NATIVE_QUEUE_INVALID" });
    expect(connection).not.toHaveBeenCalled();
  });
  it("preserves uncertain ID without replay, ordinary fallback or completion wait", async () => {
    const error = Object.assign(new Error("Retain the draft and message ID"), {
      code: "NATIVE_QUEUE_UNCERTAIN",
      messageId,
    });
    client.sendNativeQueuedMessage.mockRejectedValue(error);
    await expect(
      parsedSend(["target", "draft", "--native-queue", "--message-id", messageId]),
    ).rejects.toBe(error);
    expect(client.sendNativeQueuedMessage).toHaveBeenCalledTimes(1);
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
  it("propagates an exact authorization refusal and original draft without minting or replay", async () => {
    const refusal = Object.assign(new Error("Authenticated delegated operation required"), {
      code: "NATIVE_QUEUE_REFUSED",
      messageId,
    });
    const draft = Object.freeze({ agentId: "target", text: "private retained draft", messageId });
    Object.defineProperty(refusal, "draft", { value: draft, enumerable: false });
    client.sendNativeQueuedMessage.mockRejectedValue(refusal);
    await expect(
      parsedSend(["target", "private retained draft", "--native-queue", "--message-id", messageId]),
    ).rejects.toBe(refusal);
    expect(client.sendNativeQueuedMessage).toHaveBeenCalledExactlyOnceWith(
      "target",
      "private retained draft",
      { messageId },
    );
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).not.toHaveBeenCalled();
    expect(JSON.stringify(refusal)).not.toContain("private retained draft");
  });
  it("does not fallback on unsupported host", async () => {
    client.sendNativeQueuedMessage.mockRejectedValue({
      code: "NATIVE_QUEUE_UNSUPPORTED",
      message: "Update host",
    });
    await expect(
      parsedSend(["target", "draft", "--native-queue", "--message-id", messageId]),
    ).rejects.toMatchObject({ code: "NATIVE_QUEUE_UNSUPPORTED" });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });
  it.each(["dispatching", "delivered", "refused", "cancelled", "uncertain"])(
    "preserves host %s rather than claiming completion",
    async (state) => {
      client.sendNativeQueuedMessage.mockResolvedValue({ messageId, state, pendingCount: 0 });
      const result = await parsedSend([
        "target",
        "draft",
        "--native-queue",
        "--message-id",
        messageId,
      ]);
      expect(result.data.status).toBe(state);
      expect(result.data.messageId).toBe(messageId);
      expect(client.waitForFinish).not.toHaveBeenCalled();
    },
  );
});

describe("send reporting lines", () => {
  it("passes the sending chat to the daemon, and sends nothing extra for the owner", async () => {
    senderStamp.mockReturnValueOnce({ agentId: "lead-1" });
    await parsedSend(["target", "hello", "--no-wait"]);
    expect(client.sendAgentMessage).toHaveBeenLastCalledWith("target", "hello", {
      images: undefined,
      sender: { agentId: "lead-1" },
      queue: true,
      onDelivery: expect.any(Function),
    });
    await parsedSend(["target", "hello", "--no-wait"]);
    expect(client.sendAgentMessage).toHaveBeenLastCalledWith("target", "hello", {
      images: undefined,
      onDelivery: expect.any(Function),
    });
  });

  it("passes the selected home or endpoint to sender identity validation", async () => {
    senderStamp.mockReturnValue({ agentId: "source" });
    await parsedSend(["target", "hello", "--no-wait"]);
    expect(senderHost).toHaveBeenCalledExactlyOnceWith({
      sender: { agentId: "source" },
      serverId: "source-host",
      target: daemonTarget,
    });
  });

  it("does not connect when the sender is refused", async () => {
    senderStamp.mockImplementationOnce(() => {
      throw {
        code: "SENDER_UNKNOWN",
        message: "This send comes from a chat with no identity; send it from your own chat",
      };
    });
    await expect(parsedSend(["target", "hello"])).rejects.toMatchObject({ code: "SENDER_UNKNOWN" });
    expect(connection).not.toHaveBeenCalled();
  });
});

it("explicit opt-out reaches the daemon for sends and steers", async () => {
  senderStamp.mockReturnValue({ agentId: "sender" });
  for (const flags of [[], ["--steer"]]) {
    await parsedSend(["target", "quiet", "--no-wait", "--no-notify-on-finish", ...flags]);
    expect(client.sendAgentMessage).toHaveBeenLastCalledWith(
      "target",
      "quiet",
      expect.objectContaining({ notifyOnFinish: false }),
    );
  }
});

it("remote parent sends keep their message identity and return for the finish notice", async () => {
  senderStamp.mockReturnValue({ agentId: "sender" });
  const result = await parsedSend(["22222222-2222-4222-8222-222222222222@remote", "follow-up"]);
  expect(result.data.status).toBe("sent");
  expect(client.sendAgentMessage).toHaveBeenCalledWith(
    "22222222-2222-4222-8222-222222222222@remote",
    "follow-up",
    expect.objectContaining({ messageId: expect.any(String) }),
  );
  expect(client.waitForFinish).not.toHaveBeenCalled();
});

it("waits for local titles containing @", async () => {
  senderStamp.mockReturnValue({ agentId: "sender" });
  const result = await parsedSend(["Child @ home", "local task"]);
  expect(result.data.status).toBe("completed");
  expect(client.waitForFinish).toHaveBeenCalledOnce();
});

describe("closed receiver refusal", () => {
  it.each([{ flags: [] }, { flags: ["--queue"] }, { flags: ["--steer"] }])(
    "returns the daemon error with --no-wait: %j",
    async ({ flags }) => {
      client.sendAgentMessage.mockRejectedValue(
        new Error("session closed: reload it or start a new worker"),
      );
      await expect(parsedSend(["target", "draft", "--no-wait", ...flags])).rejects.toMatchObject({
        message: expect.stringContaining("session closed: reload it or start a new worker"),
      });
      expect(client.waitForFinish).not.toHaveBeenCalled();
    },
  );
});
