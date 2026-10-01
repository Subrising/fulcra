import { execFile } from "node:child_process";

// Update-7 W3: the live Codex model catalog. The app-server's `model/list` answers from the model cache in the Codex
// home, which an older Codex client sharing that home can leave behind the installed CLI: `gpt-6.1-sol` was missing
// from Fulcra's list while `codex debug models` (the same binary's catalog, bundled plus refreshed) had it. Fulcra
// merges that catalog in, so a new model appears without a Fulcra release.
// - Only models the catalog marks `visibility: "list"` are added, and only ones the app-server did not list; the
//   app-server's own entries (and its default) are never replaced.
// - Cached per command for CACHE_MS, so a provider refresh does not spawn the CLI every time.
// - Plain fallback: a missing CLI, one without `debug models`, a timeout or unreadable output all mean "no live
//   catalog", and the app-server list is used exactly as before.

export interface LiveCodexModel {
  id: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  model?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>;
}
export type RunCatalogCli = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
) => Promise<string>;

const CACHE_MS = 10 * 60_000;
const FAILURE_CACHE_MS = 60_000;
// R1 W3-5: a hanging CLI costs a provider refresh a few seconds at most (a failure is then cached for a minute).
export const LIVE_CATALOG_TIMEOUT_MS = 5_000;
const cache = new Map<string, { at: number; ttl: number; models: LiveCodexModel[] | null }>();

function runCli(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = LIVE_CATALOG_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    // Nothing is sent: a CLI that would wait for input ends at once rather than at the timeout.
    child.stdin?.end();
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseCodexDebugModels(output: string): LiveCodexModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const models = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(models)) return null;
  const out: LiveCodexModel[] = [];
  for (const entry of models) {
    const slug = text(entry?.slug);
    if (!slug || entry?.visibility !== "list") continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
      : [];
    out.push({
      id: slug,
      displayName: text(entry.display_name),
      description: text(entry.description),
      isDefault: false,
      model: slug,
      defaultReasoningEffort: text(entry.default_reasoning_level),
      supportedReasoningEfforts: levels
        .map((level: { effort?: unknown; description?: unknown }) => ({
          reasoningEffort: text(level?.effort),
          description: text(level?.description),
        }))
        .filter((level: { reasoningEffort?: string }) => level.reasoningEffort),
    });
  }
  return out;
}

export async function readCodexLiveCatalog(options: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  run?: RunCatalogCli;
  now?: () => number;
  timeoutMs?: number;
  force?: boolean;
}): Promise<LiveCodexModel[] | null> {
  const now = options.now ?? Date.now;
  // Custom providers can share a binary while reading different model catalogs. Only
  // home identity belongs in this in-memory key; never include credential environment values.
  const key = JSON.stringify([
    options.command,
    options.args,
    options.env?.CODEX_HOME ?? null,
    options.env?.HOME ?? null,
  ]);
  const hit = cache.get(key);
  if (!options.force && hit && now() - hit.at < hit.ttl) return hit.models;
  let models: LiveCodexModel[] | null;
  try {
    models = parseCodexDebugModels(
      await (options.run ?? runCli)(
        options.command,
        [...options.args, "debug", "models"],
        options.env,
        options.timeoutMs ?? LIVE_CATALOG_TIMEOUT_MS,
      ),
    );
  } catch {
    models = null;
  }
  cache.set(key, { at: now(), ttl: models ? CACHE_MS : FAILURE_CACHE_MS, models });
  return models;
}

export function mergeLiveCodexModels<T extends { id: string }>(
  appServer: T[],
  live: LiveCodexModel[] | null,
): T[] {
  if (!live?.length) return appServer;
  const known = new Set(appServer.map((model) => model.id));
  const added = live.filter((model) => !known.has(model.id));
  return added.length ? [...appServer, ...(added as unknown as T[])] : appServer;
}

export function resetCodexLiveCatalogCache(): void {
  cache.clear();
}
