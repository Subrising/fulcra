import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { loadTrustedPlugins } from "./trusted.js";
import { PluginRuntime } from "./runtime.js";
import { PluginService } from "./index.js";
import { createStub } from "../test-utils/class-mocks.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";

// POSIX ownership admission; the paired Win32 case below asserts host refusal.
test.runIf(process.platform !== "win32").each(["orca-organization-next", "qualified-controller"])(
  "M1 %s distribution provenance pins the runtime instance and refuses ordinary installs, enables and overrides",
  async (pluginId) => {
    const root = await mkdtemp(path.join(process.cwd(), ".cc-management-fixture-"));
    const bundles = path.join(root, "bundles"),
      directory = path.join(bundles, pluginId),
      impostor = path.join(root, "user-plugin");
    await mkdir(directory, { recursive: true });
    await mkdir(impostor);
    for (const dir of [directory, impostor]) {
      await writeFile(
        path.join(dir, "paseo-plugin.json"),
        JSON.stringify({ id: pluginId, requirements: { paseo: ">=0.8.0" } }),
      );
      await writeFile(path.join(dir, "index.client.ts"), "export default function setup() {}");
    }
    await writeFile(
      path.join(directory, "index.host.js"),
      'export const hostContract="1.1";export default sdk=>sdk.managementBridge.register(async()=>null);',
    );
    const enabledTargets: unknown[] = [];
    const host = await loadTrustedPlugins(bundles, path.join(root, "home"), [], {
      controllerPluginId: pluginId,
      enabled: (target) => {
        enabledTargets.push(target);
        return true;
      },
      validate: (c) => c,
    });
    const runtime = new PluginRuntime(pino({ level: "silent" }), "0.9.1", { trustedBundles: host });
    try {
      await expect(runtime.startPlugin(pluginId, impostor)).rejects.toThrow("distribution bundle");
      const service = new PluginService(
        pino({ level: "silent" }),
        createStub({
          get: () => ({ pluginsEnabled: false, plugins: {} }),
          onChange: () => () => {},
          patch: () => {
            throw new Error("must not write config");
          },
        }),
        "0.9.1",
        { runtime, trustedBundles: host },
      );
      await expect(service.installDirectory({ path: impostor })).rejects.toThrow(
        "distribution-owned",
      );
      await expect(service.installDirectory({ path: impostor, id: "override" })).rejects.toThrow(
        "distribution-owned",
      );
      await expect(service.enablePlugin(pluginId)).rejects.toThrow("distribution-owned");
      await runtime.startPlugin(pluginId, directory);
      const target = runtime.managementTarget(pluginId)!;
      const invocation = host.management.open(target, () => ({
        id: "owner",
        authentication: "daemon-password",
        deviceId: null,
        permissions: OWNER_PERMISSIONS,
      }))!;
      expect(invocation).toBeDefined();
      expect(enabledTargets).toContain(target);
      await invocation.invoke("before-swap", { method: "list", input: null });
      await runtime.stopAll();
      await runtime.startPlugin(pluginId, directory);
      expect(runtime.managementTarget(pluginId)).not.toBe(target);
      await expect(
        invocation.invoke("after-swap", { method: "list", input: null }),
      ).rejects.toThrow();
      await runtime.stopAll();
      await rm(path.join(directory, "index.client.ts"));
      await symlink(
        path.join(impostor, "index.client.ts"),
        path.join(directory, "index.client.ts"),
      );
      await expect(runtime.startPlugin(pluginId, directory)).rejects.toThrow("escaped bundle");
    } finally {
      await runtime.stopAll();
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

test.runIf(process.platform === "win32")(
  "Windows management distribution admission refuses before granting hooks",
  async () => {
    await expect(
      loadTrustedPlugins(process.cwd(), path.join(process.cwd(), "unused-home")),
    ).rejects.toMatchObject({ code: "TRUSTED_PLUGIN_HOST_UNSUPPORTED" });
  },
);
