import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { test, expect, vi } from "vitest";
const f = vi.hoisted(() => ({ bundle: "" }));
vi.mock("./compiler.js", () => ({
  compilePlugin: async () => ({ clientBundle: f.bundle }),
}));
import { PluginRuntime } from "./runtime.js";
test("oversize plugin catalog entry is excluded with a visible error; healthy plugins stay available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "catalog-cap-"));
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.9.1");
  try {
    await writeFile(
      path.join(root, "paseo-plugin.json"),
      JSON.stringify({ id: "fixture", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(path.join(root, "index.client.ts"), "export default ()=>{};");
    f.bundle = "export default ()=>{};";
    await runtime.startPlugin("healthy", root);
    const overhead = Buffer.byteLength(
      JSON.stringify({ id: "edge", clientBundle: "", requirements: { paseo: ">=0.8.0" } }),
    );
    f.bundle = "x".repeat(1024 * 1024 - overhead);
    await runtime.startPlugin("edge", root);
    f.bundle = "x".repeat(1024 * 1024);
    await expect(runtime.startPlugin("oversize", root)).rejects.toThrow(/catalog.*1 MiB/i);
    expect(runtime.catalog().map((x) => x.id)).toEqual(["edge", "healthy"]);
    f.bundle = "界".repeat(400000);
    await expect(runtime.startPlugin("unicode", root)).rejects.toThrow(/catalog.*1 MiB/i);
    expect(runtime.getLogs("oversize").some((x) => JSON.stringify(x).includes("catalog"))).toBe(
      true,
    );
  } finally {
    await runtime.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
