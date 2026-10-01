// Update-7 W3: the Codex model list follows the live CLI catalog (`codex debug models`), so a model the app-server's
// cached list has not caught up with (gpt-6.1-sol) appears without a release; with no usable CLI catalog the
// app-server's own list is used exactly as before.
import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LIVE_CATALOG_TIMEOUT_MS,
  mergeLiveCodexModels,
  parseCodexDebugModels,
  readCodexLiveCatalog,
  resetCodexLiveCatalogCache,
  type RunCatalogCli,
} from "./live-model-catalog.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { buildProviderRegistry } from "../../provider-registry.js";

const level = (effort: string) => ({ effort, description: `${effort} effort` });
const CATALOG = {
  models: [
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      description: "Newest",
      default_reasoning_level: "low",
      supported_reasoning_levels: ["low", "medium", "high"].map(level),
      visibility: "list",
    },
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Frontier",
      default_reasoning_level: "low",
      supported_reasoning_levels: ["low", "medium"].map(level),
      visibility: "list",
    },
    {
      slug: "codex-auto-review",
      display_name: "Auto review",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [level("medium")],
      visibility: "hide",
    },
  ],
};
const APP_SERVER = [
  {
    id: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    isDefault: true,
    model: "gpt-6-astra",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
  },
];

describe("codex live model catalog", () => {
  test("parses the CLI catalog: listed models only, with their efforts", () => {
    const models = parseCodexDebugModels(JSON.stringify(CATALOG));
    expect(models?.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
    expect(models?.[0]).toMatchObject({
      displayName: "GPT-6.1-Sol",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
    });
    expect(parseCodexDebugModels("not json")).toBeNull();
    expect(parseCodexDebugModels(JSON.stringify({ other: [] }))).toBeNull();
  });

  test("adds a model only the live CLI reports; the app-server's own entries are kept as they are", () => {
    const merged = mergeLiveCodexModels(APP_SERVER, parseCodexDebugModels(JSON.stringify(CATALOG)));
    expect(merged.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
    expect(merged[0]).toBe(APP_SERVER[0]);
    expect(merged[1].isDefault).toBe(false);
    expect(mergeLiveCodexModels(APP_SERVER, null)).toBe(APP_SERVER);
  });

  test("custom provider homes do not share a live model catalog cache", async () => {
    resetCodexLiveCatalogCache();
    const run = vi.fn<RunCatalogCli>(async (_command, _args, env) =>
      JSON.stringify({
        models: [
          {
            slug: env?.CODEX_HOME === "/fake/work" ? "work-model" : "personal-model",
            visibility: "list",
          },
        ],
      }),
    );
    const read = (home: string) =>
      readCodexLiveCatalog({
        command: "codex",
        args: [],
        env: { CODEX_HOME: home },
        run,
        now: () => 1000,
      });
    expect((await read("/fake/work"))?.map((model) => model.id)).toEqual(["work-model"]);
    expect((await read("/fake/personal"))?.map((model) => model.id)).toEqual(["personal-model"]);
    await read("/fake/work");
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("an explicit refresh bypasses a cached live catalog", async () => {
    resetCodexLiveCatalogCache();
    let runs = 0;
    const run: RunCatalogCli = async () =>
      JSON.stringify({ models: [{ slug: `model-${++runs}`, visibility: "list" }] });
    const options = { command: "codex-refresh", args: [], run, now: () => 1000 };
    expect((await readCodexLiveCatalog(options))?.[0].id).toBe("model-1");
    expect((await readCodexLiveCatalog(options))?.[0].id).toBe("model-1");
    expect((await readCodexLiveCatalog({ ...options, force: true }))?.[0].id).toBe("model-2");
  });

  test("reads the CLI once per cache window and falls back plainly when the CLI is missing", async () => {
    resetCodexLiveCatalogCache();
    let now = 1_000,
      runs = 0;
    const run = async (command: string, args: string[]) => {
      runs++;
      expect(args.slice(-2)).toEqual(["debug", "models"]);
      return JSON.stringify(CATALOG);
    };
    const first = await readCodexLiveCatalog({ command: "codex", args: [], run, now: () => now });
    expect(first?.map((m) => m.id)).toContain("gpt-6.1-sol");
    await readCodexLiveCatalog({ command: "codex", args: [], run, now: () => now + 60_000 });
    expect(runs).toBe(1);
    now += 11 * 60_000;
    await readCodexLiveCatalog({ command: "codex", args: [], run, now: () => now });
    expect(runs).toBe(2);

    resetCodexLiveCatalogCache();
    const missing = async () => {
      throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    };
    expect(
      await readCodexLiveCatalog({ command: "codex", args: [], run: missing, now: () => now }),
    ).toBeNull();
    const old = async () => {
      throw new Error("error: unrecognized subcommand 'debug'");
    };
    expect(
      await readCodexLiveCatalog({ command: "codex-old", args: [], run: old, now: () => now }),
    ).toBeNull();
  });
});

// End to end through the provider: one fake Codex answers `app-server` with a stale list and `debug models` with the
// live catalog. The provider's model list carries gpt-6.1-sol; a CLI with no catalog leaves the stale list as it was.
function fakeCodex(dir: string, debugModels: string | null): string {
  const file = path.join(dir, "fake-codex.cjs");
  writeFileSync(
    file,
    `
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.159.1\\n"); process.exit(0); }
if (args[0] === "debug" && args[1] === "models") {
  ${debugModels === null ? 'process.stderr.write("error: unrecognized subcommand debug\\n"); process.exit(2);' : `process.stdout.write(${JSON.stringify(debugModels)}); process.exit(0);`}
}
let buffer = "";
const result = (method) => method === "model/list" ? { data: ${JSON.stringify(APP_SERVER)} } : method === "config/read" ? { config: {} } : {};
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const i = buffer.indexOf("\\n"); if (i === -1) break;
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue;
    const m = JSON.parse(line); if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: result(m.method) }) + "\\n");
  }
});
`,
  );
  return file;
}
async function listThroughProvider(debugModels: string | null) {
  resetCodexLiveCatalogCache();
  const dir = mkdtempSync(path.join(tmpdir(), "codex-live-catalog-"));
  try {
    const registry = buildProviderRegistry(createTestLogger(), {
      providerOverrides: {
        "codex-live": {
          extends: "codex",
          label: "Codex live",
          command: [process.execPath, fakeCodex(dir, debugModels)],
        },
      },
    });
    const catalog = await registry["codex-live"].createClient(createTestLogger()).fetchCatalog!({
      scope: "global",
      force: true,
    });
    return catalog.models.map((m) => m.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("codex provider model list", () => {
  test("includes a model only the live CLI catalog reports", async () => {
    expect(await listThroughProvider(JSON.stringify(CATALOG))).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
    ]);
  }, 30_000);
  test("falls back to the app-server list when the CLI has no catalog", async () => {
    expect(await listThroughProvider(null)).toEqual(["gpt-6-astra"]);
  }, 30_000);
});

// R1 W3-5: a CLI that hangs costs a provider refresh a few seconds at most, then the app-server list is used.
describe("codex live catalog wait", () => {
  test("is bounded to a few seconds, and a hanging CLI falls back", async () => {
    expect(LIVE_CATALOG_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    resetCodexLiveCatalogCache();
    const dir = mkdtempSync(path.join(tmpdir(), "codex-live-hang-"));
    try {
      const hang = path.join(dir, "hang.cjs");
      writeFileSync(hang, "setInterval(() => {}, 1000);\n");
      const started = Date.now();
      const out = await readCodexLiveCatalog({
        command: process.execPath,
        args: [hang],
        timeoutMs: 300,
      });
      expect(out).toBeNull();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
