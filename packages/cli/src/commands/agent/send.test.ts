import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { addSendOptions, runSendCommand } from "./send";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../../utils/client.js", () => ({ connectToDaemon: connection }));
const daemonTarget = { kind: "endpoint" as const, host: "fixture.test:1234" };
const messageId = "native-message-1";
let client: ReturnType<typeof fakeClient>;
function fakeClient() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
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
});
afterEach(() => vi.clearAllMocks());

describe("send slash commands", () => {
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
  it("refuses an unknown slash command and never falls through to the model", async () => {
    await expect(parsedSend(["target", "/unknown"])).rejects.toMatchObject({ code: "SEND_FAILED" });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });
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
    });
    expect(client.sendNativeQueuedMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).not.toHaveBeenCalled();
    expect(result.data.status).toBe("sent");
  });
  it("preserves ordinary send completion waiting", async () => {
    const result = await parsedSend(["target", "ordinary"]);
    expect(client.sendNativeQueuedMessage).not.toHaveBeenCalled();
    expect(client.waitForFinish).toHaveBeenCalledExactlyOnceWith("target", 600000);
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
