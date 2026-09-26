import type { ChildProcess } from "node:child_process";
import * as os from "node:os";
import type { ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import { createProviderEnv, type ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  buildClaudeThinkingOptions,
  CLAUDE_DEFAULT_THINKING_OPTION_ID,
  CLAUDE_DISABLED_THINKING_OPTION_ID,
  CLAUDE_STANDARD_EFFORT_LEVELS,
  type ClaudeEffortLevel,
  normalizeClaudeRuntimeModelId,
} from "./model-manifest.js";
import { claudeQuery, type ClaudeQueryFactory } from "./query.js";

export type ClaudeRuntimeModel = ModelInfo;

export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 20_000;

export interface ClaudeModelProbeInput {
  claudeBinary: string;
  runtimeSettings?: ProviderRuntimeSettings;
  queryFactory?: ClaudeQueryFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ClaudeModelProbe = (input: ClaudeModelProbeInput) => Promise<ClaudeRuntimeModel[]>;

/**
 * Ask the installed Claude Code which models this account can use, without a model turn.
 *
 * The prompt stream never yields, so the CLI initializes and answers control requests but never sends
 * a message. Measured on Claude Code 2.1.280: ~0.8 s to initialize, no /v1/messages request. Hooks and MCP
 * servers are switched off because a catalog read must not run the user's SessionStart hooks or start
 * their MCP servers, which it otherwise does. Only user settings load: the catalog is host-scoped.
 */
export async function probeClaudeModels(
  input: ClaudeModelProbeInput,
): Promise<ClaudeRuntimeModel[]> {
  let releasePrompt: () => void = () => {};
  const promptHeld = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  // A prompt stream that ends only when released, having yielded nothing.
  const noPrompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await promptHeld;
        return { done: true, value: undefined };
      },
    }),
  };
  let child: ChildProcess | undefined;
  const query = claudeQuery(
    {
      prompt: noPrompt,
      options: {
        cwd: os.tmpdir(),
        pathToClaudeCodeExecutable: input.claudeBinary,
        settingSources: ["user"],
        settings: { disableAllHooks: true },
        extraArgs: { "strict-mcp-config": null },
        persistSession: false,
        env: createProviderEnv({ baseEnv: process.env, runtimeSettings: input.runtimeSettings }),
      },
    },
    {
      runtimeSettings: input.runtimeSettings,
      queryFactory: input.queryFactory,
      onChildProcess: (spawned) => {
        child = spawned;
      },
    },
  );
  // Nothing is sent, but the stream still has to be drained for control responses to arrive.
  void (async () => {
    try {
      for await (const _message of query) {
        // Discard: a catalog-only query produces no turn.
      }
    } catch {
      // Closing the query ends the stream with an error; nothing to report.
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeoutMs = input.timeoutMs ?? CLAUDE_MODEL_PROBE_TIMEOUT_MS;
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Claude model probe timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      onAbort = () => reject(input.signal?.reason ?? new Error("Claude model probe aborted"));
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const models = await Promise.race([query.supportedModels(), bounded]);
    if (!Array.isArray(models)) {
      throw new Error("Claude model probe returned no model list");
    }
    return models;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    releasePrompt();
    try {
      query.close();
    } catch {
      // Already closed.
    }
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }
}

interface RuntimeModelGroup {
  id: string;
  rows: ClaudeRuntimeModel[];
}

/** The id a runtime row stands for: its resolved model, normalized; an id the manifest does not know stays raw. */
export function claudeRuntimeModelId(row: ClaudeRuntimeModel): string | null {
  const raw = (row.resolvedModel ?? row.value).trim();
  if (!raw) return null;
  return normalizeClaudeRuntimeModelId(raw) ?? raw;
}

function groupRuntimeModels(runtimeModels: readonly ClaudeRuntimeModel[]): RuntimeModelGroup[] {
  const groups = new Map<string, RuntimeModelGroup>();
  for (const row of runtimeModels) {
    const id = claudeRuntimeModelId(row);
    if (!id) continue;
    const group = groups.get(id) ?? { id, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function isEffortLevel(value: string): value is ClaudeEffortLevel {
  return (CLAUDE_STANDARD_EFFORT_LEVELS as readonly string[]).includes(value) || value === "xhigh";
}

function resolveGroupEffortLevels(
  group: RuntimeModelGroup,
  manifest: AgentModelDefinition | undefined,
): ClaudeEffortLevel[] | undefined {
  if (!group.rows.some((row) => row.supportsEffort === true)) return undefined;
  const runtimeLevels = group.rows.find(
    (row) => row.supportedEffortLevels?.length,
  )?.supportedEffortLevels;
  if (runtimeLevels) return runtimeLevels.filter(isEffortLevel);
  const manifestLevels = manifest?.thinkingOptions
    ?.map((option) => option.id)
    .filter(isEffortLevel);
  // A model the manifest does not describe gets the conservative set every Claude effort model accepts.
  return manifestLevels?.length ? manifestLevels : [...CLAUDE_STANDARD_EFFORT_LEVELS];
}

function resolveDefaultEffort(
  levels: readonly ClaudeEffortLevel[],
  manifest: AgentModelDefinition | undefined,
): ClaudeEffortLevel {
  const manifestDefault = manifest?.defaultThinkingOptionId;
  if (manifestDefault && isEffortLevel(manifestDefault) && levels.includes(manifestDefault)) {
    return manifestDefault;
  }
  if (levels.includes(CLAUDE_DEFAULT_THINKING_OPTION_ID)) return CLAUDE_DEFAULT_THINKING_OPTION_ID;
  return levels[0]!;
}

// The row that names the model rather than a role: "Default (recommended)" describes the slot, not the model.
function describingRow(group: RuntimeModelGroup): ClaudeRuntimeModel {
  return group.rows.find((row) => row.value !== "default") ?? group.rows[0]!;
}

/**
 * Build the Claude catalog from what Claude Code reports, overlaid with the manifest.
 *
 * The runtime decides WHICH models exist and their effort levels, fast mode and auto mode. The manifest
 * only fills what ModelInfo does not carry: a versioned label, the context window, whether thinking can be
 * switched off, and the model's default effort. Rows are deduped by the model they resolve to, so
 * "default" and "opus[1m]" become one Opus entry that keeps both as aliases.
 */
export function mergeClaudeRuntimeCatalog(input: {
  runtimeModels: readonly ClaudeRuntimeModel[];
  manifestModels: readonly AgentModelDefinition[];
}): AgentModelDefinition[] {
  const manifestById = new Map(
    input.manifestModels
      .filter((model) => model.isSelectable !== false)
      .map((model) => [model.id, model]),
  );
  const groups = groupRuntimeModels(input.runtimeModels);
  const defaultRow = input.runtimeModels.find((row) => row.value === "default");
  const defaultId =
    (defaultRow ? claudeRuntimeModelId(defaultRow) : null) ??
    input.manifestModels.find((model) => model.isDefault && groups.some((g) => g.id === model.id))
      ?.id ??
    groups[0]?.id;

  return groups.map((group) => {
    const manifest = manifestById.get(group.id);
    const row = describingRow(group);
    const aliases = [
      ...new Set(
        group.rows
          .flatMap((candidate) => [candidate.value, candidate.resolvedModel ?? ""])
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value !== group.id),
      ),
    ];
    const definition: AgentModelDefinition = {
      provider: "claude",
      id: group.id,
      label: manifest?.label ?? (row.displayName.trim() || group.id),
      description: row.description.trim() || manifest?.description || "",
      metadata: {
        supportsFastMode: group.rows.some((candidate) => candidate.supportsFastMode === true),
        supportsAutoMode: group.rows.some((candidate) => candidate.supportsAutoMode === true),
      },
    };
    if (aliases.length > 0) definition.aliases = aliases;
    if (group.id === defaultId) definition.isDefault = true;
    if (manifest?.contextWindowMaxTokens !== undefined) {
      definition.contextWindowMaxTokens = manifest.contextWindowMaxTokens;
    }
    const levels = resolveGroupEffortLevels(group, manifest);
    if (levels?.length) {
      const defaultEffort = resolveDefaultEffort(levels, manifest);
      const supportsThinkingDisabled =
        manifest?.thinkingOptions?.some(
          (option) => option.id === CLAUDE_DISABLED_THINKING_OPTION_ID,
        ) === true;
      definition.thinkingOptions = buildClaudeThinkingOptions(
        levels,
        supportsThinkingDisabled,
        defaultEffort,
      );
      definition.defaultThinkingOptionId = defaultEffort;
    }
    return definition;
  });
}

// ---------------------------------------------------------------------------------------------------------
// Runtime fast-mode support, shared with sessions. Sessions gate the fast toggle per model but never see the
// catalog, so the last successful probe is recorded here; the manifest answers only for models it did not list.
// ---------------------------------------------------------------------------------------------------------
let runtimeFastModeById: ReadonlyMap<string, boolean> | null = null;

export function recordClaudeRuntimeModels(models: readonly AgentModelDefinition[] | null): void {
  if (!models) {
    runtimeFastModeById = null;
    return;
  }
  const byId = new Map<string, boolean>();
  for (const model of models) {
    // Only what the probe described: settings.json models carry no report, so the manifest still answers.
    if (typeof model.metadata?.supportsFastMode !== "boolean") continue;
    const supports = model.metadata.supportsFastMode;
    for (const reference of [model.id, ...(model.aliases ?? [])]) {
      byId.set(reference, supports);
    }
  }
  runtimeFastModeById = byId;
}

/** Fast-mode support Claude Code reported for this model, or undefined when the last probe did not list it. */
export function claudeRuntimeFastModeSupport(
  modelId: string | null | undefined,
): boolean | undefined {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  if (!trimmed || !runtimeFastModeById) return undefined;
  return (
    runtimeFastModeById.get(trimmed) ??
    runtimeFastModeById.get(normalizeClaudeRuntimeModelId(trimmed) ?? trimmed)
  );
}
