import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
const f = vi.hoisted(() => ({ invoke: vi.fn(), evaluate: vi.fn(), desktop: true }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => (f.desktop ? { invoke: f.invoke } : null),
}));
vi.mock("./client-runtime", () => ({
  createPluginClientRuntime: () => ({ paseo: { dispose: async () => {} } }),
}));
vi.mock("./evaluate", () => ({ runPluginClientBundle: f.evaluate }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, source: string) =>
    createHash("sha256").update(source).digest("hex"),
}));
vi.mock("./bundle-trust-policy", () => import("./bundle-trust-policy.electron"));
import { preparePluginCatalog } from "./bundle-trust";
import { PluginRegistry } from "./registry";
import { createPluginClientRuntime } from "./client-runtime";
const client = {} as DaemonClient;
const source = "(() => ({default() {}}))";
const hash = createHash("sha256").update(source).digest("hex");
beforeEach(() => {
  vi.clearAllMocks();
  f.desktop = true;
  f.invoke.mockResolvedValue({ example: hash });
  f.evaluate.mockReturnValue({ cleanup: () => {} });
});
it("D27 refuses an unknown remote hash before evaluation", () => {
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  registry.installCatalog(
    "remote",
    [
      {
        id: "example",
        requirements: { paseo: ">=1.0.0" },
        clientBundle: source + " /* modified */",
      },
    ],
    { client },
  );
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(registry.getEvaluationError("remote", "example")).toContain(
    "Plugin not trusted on this Mac",
  );
});

it("D27 evaluates a remote entry matching this app's bundled manifest", async () => {
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  const entries = await preparePluginCatalog([
    { id: "example", requirements: { paseo: ">=1.0.0" }, clientBundle: source },
  ]);
  registry.installCatalog("remote", entries, { client });
  expect(f.invoke).toHaveBeenCalledWith("desktop_bundled_plugin_pins");
  expect(f.evaluate).toHaveBeenCalledOnce();
  expect(registry.getSnapshot()).toHaveLength(1);
});
it("D27 rejects a modified prepared bundle and disposes an earlier matching installation", async () => {
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  const entry = { id: "example", requirements: { paseo: ">=1.0.0" }, clientBundle: source };
  registry.installCatalog("remote", await preparePluginCatalog([entry]), { client });
  const installed = registry.getSnapshot()[0];
  f.evaluate.mockClear();
  registry.installCatalog(
    "remote",
    await preparePluginCatalog([{ ...entry, clientBundle: source + "modified" }]),
    { client },
  );
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(installed.lifetime.signal.aborted).toBe(true);
  expect(registry.getSnapshot()).toEqual([]);
  expect(registry.getEvaluationError("remote", "example")).toContain(
    "Plugin not trusted on this Mac",
  );
});
it("D27 cannot transfer trust by mutating or copying a verified entry", async () => {
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  const [entry] = await preparePluginCatalog([
    { id: "example", requirements: { paseo: ">=1.0.0" }, clientBundle: source },
  ]);
  expect(Object.isFrozen(entry)).toBe(true);
  registry.installCatalog("remote", [{ ...entry, clientBundle: source + "changed" }], { client });
  expect(f.evaluate).not.toHaveBeenCalled();
});
it("D27 fails closed when the app manifest is unavailable", async () => {
  f.invoke.mockRejectedValue(Error("missing resources"));
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  registry.installCatalog(
    "remote",
    await preparePluginCatalog([{ id: "example", clientBundle: source }]),
    { client },
  );
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(registry.getEvaluationError("remote", "example")).toContain(
    "Plugin not trusted on this Mac",
  );
});

it("m1 desktop target fails closed without the preload bridge", async () => {
  f.desktop = false;
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  registry.installCatalog(
    "remote",
    await preparePluginCatalog([
      { id: "example", requirements: { paseo: ">=1.0.0" }, clientBundle: source },
    ]),
    { client },
  );
  expect(f.evaluate).not.toHaveBeenCalled();
});
it("m2 binds each of two pins to its ID, never any matching hash", async () => {
  const other = source + " /* other */";
  f.invoke.mockResolvedValue({
    example: hash,
    other: createHash("sha256").update(other).digest("hex"),
  });
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  registry.installCatalog(
    "remote",
    await preparePluginCatalog([
      { id: "example", requirements: { paseo: ">=1.0.0" }, clientBundle: other },
      { id: "other", requirements: { paseo: ">=1.0.0" }, clientBundle: source },
    ]),
    { client },
  );
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(registry.getSnapshot()).toEqual([]);
});
it("m2 disposes the same earlier bytes when pins disappear", async () => {
  f.evaluate.mockReturnValueOnce({
    cleanup: () => {},
    sidebarItems: [{ id: "main", title: "Example", icon: "Blocks", surface: "main" }],
  });
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  const entry = { id: "example", requirements: { paseo: ">=1.0.0" }, clientBundle: source };
  registry.installCatalog("remote", await preparePluginCatalog([entry]), { client });
  const installed = registry.getSnapshot()[0];
  f.invoke.mockResolvedValue({});
  f.evaluate.mockClear();
  registry.installCatalog("remote", await preparePluginCatalog([entry]), { client });
  expect(installed.lifetime.signal.aborted).toBe(true);
  expect(registry.getUntrustedSnapshot()[0].sidebarItems).toEqual([
    { id: "main", title: "Example", icon: "Blocks", surface: "main" },
  ]);
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(registry.getSnapshot()).toEqual([]);
});
it("F1.2 retains an untrusted sidebar row without evaluating the refused code", async () => {
  const registry = new PluginRegistry({
    version: "1.0.0",
    createRuntime: createPluginClientRuntime,
  });
  registry.installCatalog(
    "remote",
    await preparePluginCatalog([
      { id: "orca-organization-next", clientBundle: source + "modified" },
    ]),
    { client },
  );
  expect(f.evaluate).not.toHaveBeenCalled();
  expect(registry.getUntrustedSnapshot()).toMatchObject([
    {
      id: "orca-organization-next",
      serverId: "remote",
      sidebarItems: [{ id: "organization", title: "Command Centre" }],
    },
  ]);
  expect(registry.getEvaluationError("remote", "orca-organization-next")).toContain(
    "Update Fulcra",
  );
});
