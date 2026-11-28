import type { ChildProcess } from "node:child_process";
import * as os from "node:os";
import type { ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

<<<<<<< HEAD
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
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import { claudeQuery, type ClaudeQueryFactory } from "./query.js";

export type ClaudeRuntimeModel = ModelInfo;

export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 20_000;
// Long enough for the CLI to finish an OAuth token refresh it started before the probe ended.
const PROBE_EXIT_GRACE_MS = 60_000;

// Probe processes left to exit on their own after the probe ended (FU-810, upstream #9855).
const exitingProbes = new Map<ChildProcess, () => Promise<void>>();

export interface ClaudeModelProbeInput {
  claudeBinary: string;
=======
const DISCOVERY_WAIT_MS = 5_000;
// Long enough for the CLI to finish an OAuth token refresh it started before the wait ended.
const DISCOVERY_EXIT_GRACE_MS = 60_000;

interface ClaudeModelDiscoveryOptions {
  resolveBinary: () => Promise<string>;
>>>>>>> refs/remotes/upstream/tags/v0.16.2
  runtimeSettings?: ProviderRuntimeSettings;
  queryFactory?: ClaudeQueryFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ClaudeModelProbe = (input: ClaudeModelProbeInput) => Promise<ClaudeRuntimeModel[]>;

<<<<<<< HEAD
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
  input.signal?.throwIfAborted();
  let releasePrompt: () => void = () => {};
  const promptHeld = new Promise<void>((resolve) => {
    releasePrompt = resolve;
=======
type DiscoveryQuery = ReturnType<OpenDiscoveryQuery>;

// Discovery processes left to exit on their own after their caller stopped waiting.
const exitingDiscoveries = new Map<ChildProcess, () => Promise<void>>();

// The curated catalog survives a failed or slow probe. This process never receives
// a prompt and must not persist a session or launch user MCP servers/hooks.
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery = claudeQuery,
): Promise<ModelInfo[]> {
  const waitController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, waitController.signal])
    : waitController.signal;
  const timer = setTimeout(
    () => waitController.abort(new Error("Claude model discovery timed out")),
    DISCOVERY_WAIT_MS,
  );
  let endInput!: () => void;
  const ended = new Promise<void>((resolve) => {
    endInput = resolve;
>>>>>>> refs/remotes/upstream/tags/v0.16.2
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
<<<<<<< HEAD
  let child: ChildProcess | undefined;
  let childExit: Promise<void> | undefined;
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
=======
  let query: DiscoveryQuery | undefined;
  let child: ChildProcess | undefined;
  try {
    signal.throwIfAborted();
    const binary = await raceProviderRefreshAbort(signal, options.resolveBinary());
    query = openQuery(
      {
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: os.homedir(),
          env: options.env,
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: ["user"],
          settings: { disableAllHooks: true },
          // No abortController: the SDK kills the process when it aborts, and the end of
          // the wait must not.
        },
>>>>>>> refs/remotes/upstream/tags/v0.16.2
      },
    },
    {
      runtimeSettings: input.runtimeSettings,
      queryFactory: input.queryFactory,
      onChildProcess: (spawned) => {
        child = spawned;
        childExit = new Promise<void>((resolve) => {
          const settled = () => {
            spawned.removeListener("exit", settled);
            spawned.removeListener("close", settled);
            resolve();
          };
          spawned.once("exit", settled);
          // A failed spawn may close without an exit event; no process remains.
          spawned.once("close", settled);
        });
      },
<<<<<<< HEAD
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
    input.signal?.throwIfAborted();
    const models = await Promise.race([query.supportedModels(), bounded]);
    input.signal?.throwIfAborted();
    if (!Array.isArray(models)) {
      throw new Error("Claude model probe returned no model list");
    }
    return models;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    // Ending the prompt stream lets the CLI exit on its own.
    releasePrompt();
    if (child && child.exitCode === null && child.signalCode === null) {
      // The CLI may be refreshing an expired OAuth token, even after it has answered.
      // Claude Code rotates the refresh token before saving the new pair, so killing it now
      // leaves a revoked token on disk and signs the account out (upstream #9314). With its
      // input ended it exits once that work is done; the grace period and daemon shutdown
      // bound the wait.
      letProbeExit(query, child);
      // Keep the catalog flight occupied until this exact probe child exits; the outer
      // refresh deadline bounds its caller. Standalone callers do not wait.
      if (input.signal) await childExit;
    } else {
      closeProbeQuery(query);
=======
    );
    return await raceProviderRefreshAbort(signal, query.supportedModels());
  } finally {
    clearTimeout(timer);
    endInput();
    if (query && child && !hasExited(child)) {
      // The CLI may be refreshing an expired OAuth token, even after it has answered.
      // Claude Code rotates the refresh token before saving the new pair, so killing it now
      // leaves a revoked token on disk and logs the user out (#9314). With its input ended
      // it exits once that work is done; the grace period and daemon shutdown bound the wait.
      letDiscoveryExit(query, child);
    } else {
      await retireDiscovery(query, child);
>>>>>>> refs/remotes/upstream/tags/v0.16.2
    }
  }
}

<<<<<<< HEAD
/** Kills probe processes still exiting after their probe ended. Called on daemon shutdown. */
export async function killExitingClaudeModelDiscoveries(): Promise<void> {
  await Promise.all(Array.from(exitingProbes.values(), (kill) => kill()));
}

function closeProbeQuery(query: { close(): void }): void {
  try {
    query.close();
  } catch {
    // Already closed.
  }
}

function letProbeExit(query: { close(): void }, child: ChildProcess): void {
  function forget(): void {
    clearTimeout(graceTimer);
    child.off("exit", onExit);
    exitingProbes.delete(child);
  }
  function onExit(): void {
    forget();
    closeProbeQuery(query);
  }
  async function kill(): Promise<void> {
    forget();
    closeProbeQuery(query);
    await terminateWithTreeKill(child, { gracefulTimeoutMs: 200, forceTimeoutMs: 200 });
  }
  const graceTimer = setTimeout(() => void kill(), PROBE_EXIT_GRACE_MS);
  graceTimer.unref();
  child.once("exit", onExit);
  exitingProbes.set(child, kill);
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
=======
/** Kills discovery processes still exiting after their wait ended. Called on daemon shutdown. */
export async function killExitingClaudeModelDiscoveries(): Promise<void> {
  await Promise.all(Array.from(exitingDiscoveries.values(), (kill) => kill()));
}

function letDiscoveryExit(query: DiscoveryQuery, child: ChildProcess): void {
  function forget(): void {
    clearTimeout(graceTimer);
    child.off("exit", onExit);
    exitingDiscoveries.delete(child);
  }
  function onExit(): void {
    forget();
    query.close();
  }
  async function kill(): Promise<void> {
    forget();
    await retireDiscovery(query, child);
  }
  const graceTimer = setTimeout(() => void kill(), DISCOVERY_EXIT_GRACE_MS);
  graceTimer.unref();
  child.once("exit", onExit);
  exitingDiscoveries.set(child, kill);
}

async function retireDiscovery(
  query: DiscoveryQuery | undefined,
  child: ChildProcess | undefined,
): Promise<void> {
  try {
    query?.close();
  } finally {
    if (child) {
      await terminateWithTreeKill(child, { gracefulTimeoutMs: 200, forceTimeoutMs: 200 });
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
>>>>>>> refs/remotes/upstream/tags/v0.16.2
}
