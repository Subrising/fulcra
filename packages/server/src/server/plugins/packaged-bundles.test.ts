import { mkdtemp, writeFile, mkdir, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { readPackagedBundles } from "./packaged-bundles.js";
import { packagedPluginsDirectory } from "./packaged-directory.js";

// POSIX ownership admission; the paired Win32 case below asserts host refusal.
test.runIf(process.platform !== "win32")(
  "bundled resolver reads only verified precompiled artifacts; no ancestor dependency fallback",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packaged-plugin-"));
    try {
      const digest = createHash("sha256").update("fixture").digest("hex");
      await writeFile(
        path.join(root, "runtime-manifest.json"),
        JSON.stringify({ version: 1, sdkVersion: "fixture", client: digest, server: digest }),
      );
      for (const name of ["client", "server"])
        await writeFile(path.join(root, `runtime.${name}.js`), "fixture");
      expect(await readPackagedBundles(root, "fixture")).toEqual({
        clientBundle: "fixture",
        serverBundle: "fixture",
      });
      await expect(readPackagedBundles(root, "other")).rejects.toThrow("version");
      await writeFile(path.join(root, "runtime.server.js"), "changed");
      await expect(readPackagedBundles(root, "fixture")).rejects.toThrow("digest");
      await rm(path.join(root, "runtime.server.js"));
      await symlink(path.join(root, "runtime.client.js"), path.join(root, "runtime.server.js"));
      await expect(readPackagedBundles(root, "fixture")).rejects.toThrow("Unsafe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
// POSIX ownership admission; the paired Win32 case below asserts host refusal.
test.runIf(process.platform !== "win32")(
  "off loads no bundle; on derives immutable resources from the packaged worker only",
  async () => {
    expect(packagedPluginsDirectory("file:///fixture/outside.js", false)).toBeUndefined();
    expect(() => packagedPluginsDirectory("file:///fixture/outside.js", true)).toThrow();
    const root = await mkdtemp(path.join(tmpdir(), "cc-app-"));
    try {
      const resources = path.join(root, "Fixture.app/Contents/Resources");
      await mkdir(path.join(resources, "bundled-plugins"), { recursive: true });
      const entry = pathToFileURL(path.join(resources, "app.asar/worker.js")).href;
      expect(packagedPluginsDirectory(entry, true)).toContain("bundled-plugins");
      await rm(path.join(resources, "bundled-plugins"), { recursive: true });
      await symlink(root, path.join(resources, "bundled-plugins"));
      expect(() => packagedPluginsDirectory(entry, true)).toThrow("escaped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("trusted host entry refuses writable-by-others code before import", async () => {
  const { loadTrustedPlugins } = await import("./trusted.js");
  const root = await mkdtemp(path.join(tmpdir(), "cc-entry-"));
  try {
    const bundles = path.join(root, "bundles"),
      plugin = path.join(bundles, "fixture");
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "paseo-plugin.json"), JSON.stringify({ id: "fixture" }));
    const entry = path.join(plugin, "index.host.js");
    await writeFile(entry, "export default () => {};", { mode: 0o666 });
    await chmod(entry, 0o666);
    await expect(loadTrustedPlugins(bundles, path.join(root, "home"))).rejects.toThrow("ownership");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "win32")(
  "Windows cannot obtain trusted packaged bundles or a controller distribution path",
  async () => {
    await expect(readPackagedBundles(process.cwd(), "fixture")).rejects.toMatchObject({
      code: "TRUSTED_PLUGIN_HOST_UNSUPPORTED",
    });
    expect(packagedPluginsDirectory(import.meta.url, false)).toBeUndefined();
    expect(() => packagedPluginsDirectory(import.meta.url, true)).toThrow(
      "Trusted plugin admission unavailable on Windows",
    );
  },
);
