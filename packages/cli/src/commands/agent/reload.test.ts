import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { runReloadCommand } from "./reload.js";
import { connectToDaemon } from "../../utils/client.js";

vi.mock("../../utils/client.js", async (load) => ({
  ...(await load<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(),
}));

test("reload skips an archived ID before refresh and closes the client", async () => {
  const client = {
    fetchAgents: vi.fn(async () => ({
      entries: [
        {
          agent: {
            id: "11111111-1111-4111-8111-111111111111",
            title: "Archive fixture",
            archivedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    })),
    refreshAgent: vi.fn(),
    close: vi.fn(async () => {}),
  };
  vi.mocked(connectToDaemon).mockResolvedValue(client as never);
  await expect(runReloadCommand("11111111", {}, new Command())).rejects.toMatchObject({
    code: "AGENT_ARCHIVED",
  });
  expect(client.refreshAgent).not.toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledOnce();
});
