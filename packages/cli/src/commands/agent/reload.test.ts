import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { runReloadCommand } from "./reload.js";
import { connectToDaemon } from "../../utils/client.js";

vi.mock("../../utils/client.js", async (load) => ({
  ...(await load<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(),
}));

test("reload sends explicit restore intent for an archived stored ID and closes the client", async () => {
  const client = {
    fetchAgent: vi.fn(async () => null),
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
    refreshAgent: vi.fn(async () => ({ agentId: "11111111-1111-4111-8111-111111111111" })),
    close: vi.fn(async () => {}),
  };
  vi.mocked(connectToDaemon).mockResolvedValue(client as never);
  await expect(runReloadCommand("11111111", {}, new Command())).resolves.toMatchObject({
    data: { agentId: "11111111-1111-4111-8111-111111111111", status: "reloaded" },
  });
  expect(client.refreshAgent).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111",
    undefined,
    { restore: true },
  );
  expect(client.close).toHaveBeenCalledOnce();
});
