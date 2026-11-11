import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";
import { mergeClaudeRuntimeCatalog, type ClaudeRuntimeModel } from "./model-discovery.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

const MANIFEST_GAP_LOG_INTERVAL_MS = 60 * 60 * 1000;
const manifestGapLoggedAt = new Map<string, number>();

/** Test hook: forget which gaps were already logged. */
export function resetClaudeManifestGapLogForTests(): void {
  manifestGapLoggedAt.clear();
}

/**
 * Claude Code decides which models exist, so an account can get a list without a model the manifest
 * knows (FU-777: Fable 5.2 missing on one host). When the probe returned models and a manifest model that
 * this Claude Code version supports is absent, log one warn line with what the probe really returned.
 * Only model ids, the Fulcra account id and the version are logged; never tokens or env values.
 * Rate limit: once per hour per missing set. Models that need discovery (Mythos) are expected to be absent.
 */
export function logClaudeManifestGap(input: {
  logger: Logger;
  runtimeModels: readonly ClaudeRuntimeModel[] | null | undefined;
  claudeCodeVersion?: string;
  accountId?: string | null;
  now?: () => number;
}): void {
  const { runtimeModels } = input;
  if (!runtimeModels?.length) return;
  const discovered = new Set(
    runtimeModels
      .map((model) => normalizeClaudeRuntimeModelId(model.resolvedModel ?? model.value))
      .filter((id): id is string => id !== null),
  );
  // Passing the discovered ids drops discovery-only models (Mythos) that the probe did not report.
  const missing = getClaudeManifestModels(input.claudeCodeVersion, discovered)
    .filter((model) => model.isSelectable !== false)
    .map((model) => model.id)
    .filter((id) => !discovered.has(id))
    .sort();
  if (missing.length === 0) return;
  const now = (input.now ?? Date.now)();
  const key = missing.join(",");
  const last = manifestGapLoggedAt.get(key);
  if (last !== undefined && now - last < MANIFEST_GAP_LOG_INTERVAL_MS) return;
  manifestGapLoggedAt.set(key, now);
  input.logger.warn(
    {
      missingManifestModelIds: missing,
      probeModelIds: runtimeModels.map((model) => model.resolvedModel ?? model.value),
      accountId: input.accountId ?? null,
      claudeCodeVersion: input.claudeCodeVersion ?? null,
    },
    "Claude probe omitted manifest models that this Claude Code version supports",
  );
}

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export function getClaudeContextWindowMaxTokens(
  modelId: string | null | undefined,
): number | undefined {
  if (modelId?.trim().toLowerCase().endsWith("[1m]")) {
    return 1_000_000;
  }
  return findClaudeModel(modelId)?.contextWindowMaxTokens;
}

/**
 * The Claude catalog: the models Claude Code reported (runtimeModels) overlaid with the manifest, or the
 * manifest alone when there is no report (the probe failed or timed out). Models that need discovery
 * (Mythos) are offered only when Claude Code reported them. Models named in Claude settings.json are
 * appended either way.
 */
export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir: string,
  claudeCodeVersion?: string,
  runtimeModels?: readonly ClaudeRuntimeModel[] | null,
  signal?: AbortSignal,
): Promise<AgentModelDefinition[]> {
  signal?.throwIfAborted();
  const discoveredModelIds = new Set(
    (runtimeModels ?? [])
      .map((model) => normalizeClaudeRuntimeModelId(model.resolvedModel ?? model.value))
      .filter((id): id is string => id !== null),
  );
  const manifestModels = getClaudeManifestModels(claudeCodeVersion, discoveredModelIds);
  const baseModels = runtimeModels?.length
    ? mergeClaudeRuntimeCatalog({ runtimeModels, manifestModels })
    : manifestModels;
  const settingsModels = await readClaudeSettingsModels(logger, configDir, signal);
  signal?.throwIfAborted();
  if (settingsModels.length === 0) {
    return baseModels;
  }

  const models = [...baseModels];

  for (const model of settingsModels) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    const manifestModel = getClaudeModels(claudeCodeVersion).find(
      (candidate) => candidate.id === model.id,
    );
    models.push({ ...manifestModel, ...model });
  }

  return models;
}

async function readClaudeSettingsModels(
  logger: Logger,
  configDir: string,
  signal?: AbortSignal,
): Promise<AgentModelDefinition[]> {
  const settingsPath = path.join(configDir, "settings.json");

  let parsed: unknown;
  try {
    signal?.throwIfAborted();
    const rawSettings = await fs.readFile(settingsPath, { encoding: "utf8", signal });
    signal?.throwIfAborted();
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    signal?.throwIfAborted();
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return [];
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return [];
  }

  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, parsed.model, "model");

  const env = parsed.env;
  if (env === undefined) {
    return models;
  }
  if (!isRecord(env)) {
    logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    return models;
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return models;
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
