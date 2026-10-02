import { expect, test } from "vitest";
import pino from "pino";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginService } from "./index.js";
import { PluginRuntime } from "./runtime.js";

type RuntimePort = NonNullable<ConstructorParameters<typeof PluginService>[3]["runtime"]>;
function service(runtime: RuntimePort): PluginService {
  const config = new DaemonConfigStore(
    "/unused-l17-port-fixture",
    {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      notificationMode: "primes",
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      pluginsEnabled: true,
      plugins: {},
    },
    undefined,
    { startupPersisted: {} },
  );
  return new PluginService(pino({ enabled: false }), config, "0.10.2", { runtime });
}

test("L17 runtime port returns the exact concrete guarded pager, never a replacement", () => {
  const runtime = new PluginRuntime(pino({ enabled: false }), "0.10.2");
  const port: RuntimePort = runtime;
  const adapter = service(port);
  expect(adapter.catalogPaging()).toBe(runtime.catalogPaging);
  expect(adapter.catalogPaging()).toBe(adapter.catalogPaging());
});

test("L17 legacy injected port has no paging availability or substitute pager", () => {
  const port: RuntimePort = {
    catalog: () => [],
    invoke: async () => undefined,
    getLogs: () => [],
    clearLogs() {},
    connectProvider: async () => {
      throw Error("Unsupported provider");
    },
    startPlugin: async () => {},
    stopPluginById: async () => false,
    stopAll: async () => {},
    subscribe: () => () => {},
    bindPaseoSessionHost() {},
  };
  const adapter = service(port);
  expect(adapter.catalog()).toEqual([]);
  expect(adapter.catalogPaging()).toBeUndefined();
});
