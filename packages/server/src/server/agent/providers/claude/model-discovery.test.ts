import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeModelSupportsFastMode } from "./feature-definitions.js";
import {
  mergeClaudeRuntimeCatalog,
  probeClaudeModels,
  recordClaudeRuntimeModels,
  type ClaudeModelProbe,
  type ClaudeRuntimeModel,
} from "./model-discovery.js";
import { getClaudeManifestModels, normalizeClaudeRuntimeModelId } from "./model-manifest.js";
import { resolveObservedClaudeModelId } from "./models.js";
import type { ClaudeQueryFactory, ClaudeQueryInput } from "./query.js";

// What Claude Code 2.1.280 reported for a subscription account on 2026-09-24 (X6-REPORT.md §1).
const MEASURED_ROWS: ClaudeRuntimeModel[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

const tempDirs: string[] = [];
afterEach(async () => {
  recordClaudeRuntimeModels(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function emptyConfigDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "x6-claude-config-"));
  tempDirs.push(dir);
  return dir;
}

async function catalogWith(probe: ClaudeModelProbe) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    resolveVersion: async () => "2.1.280",
    configDir: await emptyConfigDir(),
    modelProbe: probe,
  });
  return client.fetchCatalog({ scope: "workspace", cwd: os.tmpdir(), force: false });
}

function merge(rows: ClaudeRuntimeModel[]) {
  return mergeClaudeRuntimeCatalog({
    runtimeModels: rows,
    manifestModels: getClaudeManifestModels("2.1.280"),
  });
}

describe("X6: probe success — Claude Code decides which models exist", () => {
  it("builds the catalog from the probe, not the 15-entry manifest", async () => {
    const { models } = await catalogWith(async () => MEASURED_ROWS);

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    // The host's default is what Claude Code calls "default", with its model's default effort (X2/X4).
    const defaultModel = models.find((model) => model.isDefault);
    expect(defaultModel?.id).toBe("claude-opus-5-5");
    expect(defaultModel?.defaultThinkingOptionId).toBe("medium");
  });
});

describe("X6: probe failure — the manifest is the full fallback", () => {
  it("returns the manifest when discovery throws", async () => {
    const { models } = await catalogWith(async () => {
      throw new Error("Claude model probe timed out after 20000ms");
    });

    expect(models).toEqual(getClaudeManifestModels("2.1.280"));
  });

  it("returns the manifest when discovery reports nothing", async () => {
    const { models } = await catalogWith(async () => []);

    expect(models).toEqual(getClaudeManifestModels("2.1.280"));
  });
});

describe("X6: aliases are deduped by the model they resolve to", () => {
  it("folds 'default' and 'opus[1m]' into one Opus 5.5 entry that keeps both names", () => {
    const models = merge(MEASURED_ROWS);
    const opus = models.filter((model) => model.id === "claude-opus-5-5");

    expect(opus).toHaveLength(1);
    expect(opus[0]?.aliases).toEqual(["default", "claude-opus-5-5[1m]", "opus[1m]"]);
    expect(opus[0]?.isDefault).toBe(true);
    // A dated resolved id normalizes to its manifest id and stays reachable as an alias.
    expect(models.find((model) => model.id === "claude-haiku-4-5")?.aliases).toEqual([
      "haiku",
      "claude-haiku-4-5-20251001",
    ]);
  });
});

describe("X6: an id the manifest does not know is kept raw", () => {
  const NEW_OPUS: ClaudeRuntimeModel = {
    value: "claude-opus-5-6",
    displayName: "Opus 5.6",
    description: "A newer Opus",
    supportsEffort: true,
  };

  it("lists an unknown model under its own id with a safe default effort set", () => {
    const model = merge([NEW_OPUS]).find((candidate) => candidate.label === "Opus 5.6");

    expect(model?.id).toBe("claude-opus-5-6");
    expect(model?.thinkingOptions?.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(model?.defaultThinkingOptionId).toBe("high");
  });

  it("never renames a newer minor release to the older model of its family", () => {
    expect(normalizeClaudeRuntimeModelId("claude-opus-5-6")).toBeNull();
    expect(normalizeClaudeRuntimeModelId("us.anthropic.claude-opus-5-6-20270101-v1:0")).toBeNull();
    expect(resolveObservedClaudeModelId("claude-opus-5-6")).toBe("claude-opus-5-6");
    // Known ids and dated single-segment ids are unchanged.
    expect(normalizeClaudeRuntimeModelId("us.anthropic.claude-opus-5-20260724-v1:0")).toBe(
      "claude-opus-5",
    );
    expect(normalizeClaudeRuntimeModelId("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("X6: overlay precedence — runtime capabilities win, the manifest fills gaps", () => {
  it("takes effort levels from the runtime even where the manifest lists more", () => {
    const [opus] = merge([
      { ...MEASURED_ROWS[1]!, supportedEffortLevels: ["low", "medium", "high"] },
    ]);

    expect(opus?.thinkingOptions?.map((option) => option.id)).toEqual(["low", "medium", "high"]);
  });

  it("drops effort entirely when the runtime says the model has none", () => {
    const [opus] = merge([
      { ...MEASURED_ROWS[1]!, supportsEffort: false, supportedEffortLevels: undefined },
    ]);

    expect(opus?.thinkingOptions).toBeUndefined();
    expect(opus?.defaultThinkingOptionId).toBeUndefined();
  });

  it("fills the label, context window, default effort and thinking-off from the manifest", () => {
    const models = merge(MEASURED_ROWS);
    const opus = models.find((model) => model.id === "claude-opus-5-5");
    const sonnet = models.find((model) => model.id === "claude-sonnet-5");

    expect(opus?.label).toBe("Opus 5.5");
    expect(opus?.contextWindowMaxTokens).toBe(1_000_000);
    expect(opus?.defaultThinkingOptionId).toBe("medium");
    expect(sonnet?.thinkingOptions?.[0]?.id).toBe("off");
  });

  it("lets the runtime's fast-mode report override the manifest", () => {
    // The manifest says Opus 5.5 supports fast mode; this account's Claude Code says it does not.
    expect(claudeModelSupportsFastMode("claude-opus-5-5")).toBe(true);
    recordClaudeRuntimeModels(merge([{ ...MEASURED_ROWS[1]!, supportsFastMode: false }]));

    expect(claudeModelSupportsFastMode("claude-opus-5-5")).toBe(false);
    // A model the probe did not list still answers from the manifest.
    expect(claudeModelSupportsFastMode("claude-opus-5")).toBe(true);
  });
});

describe("X6: the catalogue cache follows the Claude Code version", () => {
  it("changes the cache key when the CLI version changes, and not before the version is rechecked", async () => {
    let version = "2.1.280";
    let now = 0;
    let versionCalls = 0;
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveVersion: async () => {
        versionCalls += 1;
        return version;
      },
      modelProbe: async () => MEASURED_ROWS,
      now: () => now,
    });
    const options = { scope: "workspace" as const, cwd: os.tmpdir(), force: false };

    const first = await client.getCatalogCacheKey(options);
    version = "2.1.281"; // Claude Code upgraded
    const withinTtl = await client.getCatalogCacheKey(options);
    now = 61_000;
    const afterTtl = await client.getCatalogCacheKey(options);

    expect(first).toBe("host:2.1.280");
    expect(withinTtl).toBe("host:2.1.280");
    expect(afterTtl).toBe("host:2.1.281");
    expect(versionCalls).toBe(2);
  });

  it("keeps the host key when the version cannot be resolved", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveVersion: async () => {
        throw new Error("claude not found");
      },
      modelProbe: async () => MEASURED_ROWS,
    });

    expect(
      await client.getCatalogCacheKey({ scope: "workspace", cwd: os.tmpdir(), force: false }),
    ).toBe("host");
  });
});

describe("X6: the probe is catalog-only and bounded", () => {
  function fakeQuery(supportedModels: () => Promise<ClaudeRuntimeModel[]>) {
    const calls = { closed: 0, input: undefined as ClaudeQueryInput | undefined };
    const factory = ((input: ClaudeQueryInput) => {
      calls.input = input;
      return {
        supportedModels,
        close: () => {
          calls.closed += 1;
        },
        async *[Symbol.asyncIterator]() {},
      };
    }) as unknown as ClaudeQueryFactory;
    return { factory, calls };
  }

  it("reads the model list without hooks, MCP servers or a persisted session, then closes", async () => {
    const { factory, calls } = fakeQuery(async () => MEASURED_ROWS);

    const rows = await probeClaudeModels({ claudeBinary: "/test/claude", queryFactory: factory });

    expect(rows).toEqual(MEASURED_ROWS);
    expect(calls.closed).toBe(1);
    expect(calls.input?.options).toMatchObject({
      settings: { disableAllHooks: true },
      extraArgs: { "strict-mcp-config": null },
      persistSession: false,
      settingSources: ["user"],
    });
  });

  it("gives up after its time bound and still closes the query", async () => {
    const { factory, calls } = fakeQuery(() => new Promise<never>(() => {}));

    await expect(
      probeClaudeModels({ claudeBinary: "/test/claude", queryFactory: factory, timeoutMs: 50 }),
    ).rejects.toThrow("timed out after 50ms");
    expect(calls.closed).toBe(1);
  });
});
