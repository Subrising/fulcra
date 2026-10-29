// FU-590: a fetch per repository every 3 minutes was a large share of the load on a host with many
// workspaces. The default is now 10 minutes, and a host can turn background fetch off.
export const DEFAULT_BACKGROUND_GIT_FETCH_INTERVAL_MS = 600_000;
export const MIN_BACKGROUND_GIT_FETCH_INTERVAL_MS = 60_000;

export interface BackgroundGitFetchConfig {
  enabled: boolean;
  intervalMs: number;
}

export const DEFAULT_BACKGROUND_GIT_FETCH_CONFIG: BackgroundGitFetchConfig = {
  enabled: true,
  intervalMs: DEFAULT_BACKGROUND_GIT_FETCH_INTERVAL_MS,
};

function parseBackgroundFetchSwitch(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") return false;
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  return undefined;
}

function parseBackgroundFetchInterval(value: number | string | undefined): number | undefined {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return Math.max(MIN_BACKGROUND_GIT_FETCH_INTERVAL_MS, parsed);
}

/**
 * Per-host background fetch setting. The environment wins over the persisted config:
 * PASEO_GIT_BACKGROUND_FETCH (off|on) and PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MS, then
 * daemon.git.backgroundFetch and daemon.git.backgroundFetchIntervalMs.
 */
export function resolveBackgroundGitFetchConfig(input: {
  env: NodeJS.ProcessEnv;
  persisted?: { backgroundFetch?: boolean; backgroundFetchIntervalMs?: number };
}): BackgroundGitFetchConfig {
  return {
    enabled:
      parseBackgroundFetchSwitch(input.env.PASEO_GIT_BACKGROUND_FETCH) ??
      input.persisted?.backgroundFetch ??
      DEFAULT_BACKGROUND_GIT_FETCH_CONFIG.enabled,
    intervalMs:
      parseBackgroundFetchInterval(input.env.PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MS) ??
      parseBackgroundFetchInterval(input.persisted?.backgroundFetchIntervalMs) ??
      DEFAULT_BACKGROUND_GIT_FETCH_CONFIG.intervalMs,
  };
}
