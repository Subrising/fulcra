// Warmup compiles the web bundle before the first test navigates. A cold CI runner builds the
// whole graph here, so the bound is a startup allowance, not a per-test timeout: a shard that
// aborts mid-compile reports no failing test and no compiler error, only a bare TimeoutError.
const LOCAL_TIMEOUT_MS = 120_000;
const CI_TIMEOUT_MS = 300_000;
const HEARTBEAT_MS = 30_000;
const PROGRESS = /(\d+(?:\.\d+)?)%\s*\((\d+)\/(\d+)\)/g;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function warmupTimeoutMs(env = process.env) {
  const override = env.E2E_METRO_WARMUP_TIMEOUT_MS;
  if (override !== undefined && override !== "") {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `E2E_METRO_WARMUP_TIMEOUT_MS must be a positive integer of milliseconds, got ${override}`,
      );
    }
    return parsed;
  }
  // A cold Metro graph measured ~238s on this project, so the local 120s allowance aborts CI
  // part-way through compilation. 300s clears that profile with headroom and stays far inside
  // the job budget: the Playwright shards set no timeout-minutes and the config sets no
  // globalTimeout, so the only outer deadline is the 360 minute GitHub default.
  return env.CI ? CI_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
}

/**
 * @param {string | undefined} output
 * @returns {string | null}
 */
export function lastMetroProgress(output) {
  if (!output) return null;
  const matches = [...output.matchAll(PROGRESS)];
  const last = matches.at(-1);
  return last ? `${last[1]}% (${last[2]}/${last[3]})` : null;
}

/**
 * @param {number} port
 * @param {{
 *   timeoutMs?: number,
 *   getRecentOutput?: () => string,
 *   log?: (line: string) => void,
 *   heartbeatMs?: number,
 * }} [options]
 */
export async function warmMetro(port, options = {}) {
  const {
    timeoutMs = warmupTimeoutMs(),
    getRecentOutput,
    log = console.log,
    heartbeatMs = HEARTBEAT_MS,
  } = options;
  const origin = `http://127.0.0.1:${port}`;
  const duration = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);
  const progressSuffix = () => {
    const progress = lastMetroProgress(getRecentOutput?.());
    return progress ? ` Last Metro progress: ${progress}.` : "";
  };

  /**
   * @param {URL | string} url
   * @param {string} label
   */
  const fetchWithAllowance = async (url, label) => {
    const started = Date.now();
    // Silence during a multi-minute compile reads like a hang; report liveness instead.
    const heartbeat = setInterval(() => {
      const elapsed = duration(Date.now() - started);
      log(`[e2e] ${label} still compiling after ${elapsed}.${progressSuffix()}`);
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(
          `Metro ${label} did not finish within the ${duration(timeoutMs)} warmup allowance ` +
            `(elapsed ${duration(Date.now() - started)}).${progressSuffix()} ` +
            `Set E2E_METRO_WARMUP_TIMEOUT_MS to raise the allowance if the graph grew.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  };

  const documentResponse = await fetchWithAllowance(origin, "document warmup");
  if (!documentResponse.ok) {
    throw new Error(`Metro document warmup failed with HTTP ${documentResponse.status}`);
  }
  const document = await documentResponse.text();
  const scriptSources = [...document.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (scriptSources.length === 0) {
    throw new Error("Metro document warmup found no scripts to compile");
  }
  for (const source of scriptSources) {
    const scriptUrl = new URL(source, origin);
    if (scriptUrl.origin !== origin) continue;
    const response = await fetchWithAllowance(scriptUrl, `bundle warmup for ${scriptUrl.pathname}`);
    if (!response.ok) {
      throw new Error(
        `Metro bundle warmup failed for ${scriptUrl.pathname}: HTTP ${response.status}`,
      );
    }
    await response.arrayBuffer();
  }
}
