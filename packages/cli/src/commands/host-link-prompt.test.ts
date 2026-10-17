import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { promptHostLink } from "./host-link.js";

const connection = vi.hoisted(() => vi.fn());
const stamp = vi.hoisted(() => vi.fn((): { agentId: string } | null => ({ agentId: "parent" })));
vi.mock("../utils/client.js", () => ({ connectToDaemon: connection }));
vi.mock("../utils/send-sender.js", () => ({ resolveSender: stamp }));
afterEach(() => {
  vi.clearAllMocks();
  stamp.mockReturnValue({ agentId: "parent" });
});

test.each([false, true])(
  "host-link prompt uses its parent daemon and retains the message ID; steer=%s",
  async (steer) => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-prompt-cli-"));
    const client = {
      sendAgentMessage: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    connection.mockResolvedValue(client);
    const messageId = "22222222-2222-4222-8222-222222222222";
    try {
      const receiptFile = path.join(root, "receipt.json");
      const promptFile = path.join(root, "prompt.txt");
      await writeFile(
        receiptFile,
        JSON.stringify({
          serverId: "remote",
          agentId: "child",
          state: "created",
          messageId,
          token: "synthetic-private-token",
          endpoint: "https://remote.test/",
        }),
        { mode: 0o600 },
      );
      await writeFile(promptFile, "Next task.", { mode: 0o600 });
      const daemonTarget = { kind: "instance" as const, home: root };
      expect(
        await promptHostLink({
          receiptFile,
          promptFile,
          messageId,
          daemonTarget,
          steer,
          notifyOnFinish: !steer,
        }),
      ).toEqual({ agentId: "child", messageId, state: "admitted" });
      expect(connection).toHaveBeenCalledWith({ target: daemonTarget });
      expect(client.sendAgentMessage).toHaveBeenCalledWith("child@remote", "Next task.", {
        sender: { agentId: "parent" },
        messageId,
        ...(steer ? { activeTurnBehavior: "steer", notifyOnFinish: false } : {}),
      });
      expect(client.close).toHaveBeenCalledOnce();
      stamp.mockReturnValue(null);
      await expect(
        promptHostLink({ receiptFile, promptFile, messageId, daemonTarget }),
      ).rejects.toThrow("parent chat on the parent host");
      expect(connection).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
