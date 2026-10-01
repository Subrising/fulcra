import { expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrustedPlugins, trustedClaudeDenyRules } from "./trusted.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const boundary = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("../agent/provider-runtime.js", () => ({ createAgentProviderRuntime: boundary.provider }));
vi.mock("../orchestration-skills/index.js", () => ({
  createOrchestrationSkills: () => ({ autoUpdate: async () => undefined }),
}));
vi.mock("../integrations/host-integrations.js", () => ({
  createHostIntegrations: () => ({ services: {}, dispose() {} }),
}));

test("R1 M3: createPaseoDaemon indexes before setup and installs deny before provider startup", async () => {
  const { createPaseoDaemon } = await import("../bootstrap.js");
  const root = await mkdtemp(join(tmpdir(), "trusted-daemon-"));
  const bundle = join(root, "bundle");
  const plugin = join(bundle, "fixture");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "paseo-plugin.json"), JSON.stringify({ id: "fixture" }));
  const id = "11111111-1111-4111-8111-111111111111";
  await writeFile(
    join(plugin, "index.host.js"),
    `export const hostContract='1.1'; export default server=>{ server.inputObservations.require('${id}'); server.claude.deny(()=>['Read(/fixture/private/**)']); };`,
  );
  const order: string[] = [];
  const hosts = new Set<TrustedPlugins>();
  vi.spyOn(AgentStorage.prototype, "initialize").mockImplementation(async () => {
    order.push("index-initialize");
  });
  vi.spyOn(AgentStorage.prototype, "list").mockImplementation(async () => {
    order.push("index-list");
    return [{ id } as never];
  });
  const register = TrustedPlugins.prototype.registerV11;
  vi.spyOn(TrustedPlugins.prototype, "registerV11").mockImplementation(function (
    this: TrustedPlugins,
    ...args
  ) {
    hosts.add(this);
    order.push("trusted-setup");
    return register.apply(this, args);
  });
  boundary.provider.mockImplementation(() => {
    order.push("provider-boundary");
    expect(trustedClaudeDenyRules()).toContain("Read(/fixture/private/**)");
    throw Error("fixture-provider-stop");
  });
  try {
    await expect(
      createPaseoDaemon(
        {
          listen: "127.0.0.1:0",
          paseoHome: join(root, "home"),
          corsAllowedOrigins: [],
          hostnames: true,
          mcpEnabled: false,
          staticDir: root,
          mcpDebug: false,
          agentClients: {},
          agentStoragePath: join(root, "agents"),
          relayEnabled: false,
          appBaseUrl: "https://example.invalid",
          bundledPluginsDirectory: bundle,
        },
        createTestLogger(),
        { credentialBackend: null },
      ),
    ).rejects.toThrow("fixture-provider-stop");
    expect(order.slice(0, 3)).toEqual(["index-initialize", "index-list", "trusted-setup"]);
    expect(order.at(-1)).toBe("provider-boundary");
    expect(boundary.provider).toHaveBeenCalledOnce();
  } finally {
    for (const host of hosts) host.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
