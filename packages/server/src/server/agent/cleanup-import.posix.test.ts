import { expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => state.home || actual.homedir() };
});
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

test("an active deletion refuses import before the provider can start", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fu340-import-")));
  state.home = root;
  try {
    mkdirSync(join(root, ".config/fulcra/cleanup-v1/deletion"), { recursive: true });
    const clients = createTestAgentClients();
    const provider = vi.fn(async () => { throw new Error("The provider must not start."); });
    clients.codex!.importSession = provider;
    const logger = createTestLogger();
    const storage = new AgentStorage(join(root, "agents"), logger);
    const manager = new AgentManager({ clients, registry: storage, logger });
    await expect(manager.importProviderSession({
      provider: "codex", providerHandleId: "fixture-session", cwd: root, workspaceId: "fixture-workspace",
    })).rejects.toThrow("Cleanup is in progress");
    expect(provider).not.toHaveBeenCalled();
    expect(await storage.list()).toEqual([]);
  } finally {
    state.home = "";
    rmSync(root, { recursive: true });
  }
});
