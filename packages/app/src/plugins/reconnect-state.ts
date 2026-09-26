import { QueryClient, skipToken, type QueryKey } from "@tanstack/react-query";

const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_BYTES = 32 * 1024;
const MAX_PLUGINS = 64;
const MAX_TOTAL_CHARS = 4 * 1024 * 1024;
interface Choice {
  key: QueryKey;
  value: unknown;
}
interface Saved {
  bundle: string;
  requirement?: string;
  expires: number;
  choices: string;
}

// Only explicitly opted, non-fetching local UI state survives runtime disposal.
// RPC queries, mutations, callbacks and query options never enter this cache.
export class PluginReconnectState {
  private readonly hosts = new Map<string, Map<string, Saved>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  save(
    host: string,
    plugin: string,
    bundle: string,
    requirement: string | undefined,
    client: QueryClient,
  ): void {
    this.prune();
    const choices = client
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.meta?.paseoLocalView === true &&
          query.options.queryFn === skipToken &&
          query.isDisabled() &&
          query.state.status === "success",
      )
      .map((query) => ({ key: query.queryKey, value: query.state.data }));
    if (!choices.length) return;
    let serialized: string;
    let remaining = MAX_BYTES;
    const copy = (value: unknown, depth = 0): unknown => {
      remaining -= 1 + (typeof value === "string" ? value.length : 0);
      if (remaining < 0 || depth > 32) throw new Error("Local view too large");
      if (value === null || ["string", "boolean"].includes(typeof value)) return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value !== "object") throw new Error("Non-JSON local view");
      const array = Array.isArray(value);
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error("Non-JSON local view");
      if (Object.getOwnPropertySymbols(value).length) throw new Error("Non-JSON local view");
      const keys = Object.keys(value);
      if (keys.length > remaining || (array && value.length !== keys.length))
        throw new Error("Non-JSON local view");
      const result: object = array ? [] : Object.create(null);
      for (const key of keys) {
        remaining -= key.length;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("Non-JSON local view");
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    };
    try {
      serialized = JSON.stringify(copy(choices));
      if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) return;
    } catch {
      return;
    }
    const plugins = this.hosts.get(host) ?? new Map<string, Saved>();
    plugins.set(plugin, {
      bundle,
      requirement,
      expires: this.now() + MAX_AGE_MS,
      choices: serialized,
    });
    this.hosts.set(host, plugins);
    while (
      [...this.hosts.values()].reduce((sum, entries) => sum + entries.size, 0) > MAX_PLUGINS ||
      [...this.hosts].reduce(
        (sum, [id, entries]) =>
          sum +
          id.length +
          [...entries].reduce(
            (n, [key, v]) =>
              n + key.length + v.bundle.length + (v.requirement?.length ?? 0) + v.choices.length,
            0,
          ),
        0,
      ) > MAX_TOTAL_CHARS
    ) {
      const oldest = this.hosts.entries().next().value;
      if (!oldest) break;
      oldest[1].delete(oldest[1].keys().next().value!);
      if (!oldest[1].size) this.hosts.delete(oldest[0]);
    }
  }

  restore(
    host: string,
    plugin: string,
    bundle: string,
    requirement: string | undefined,
    client: QueryClient,
  ): void {
    this.prune();
    const plugins = this.hosts.get(host),
      saved = plugins?.get(plugin);
    plugins?.delete(plugin);
    if (plugins && !plugins.size) this.hosts.delete(host);
    if (!saved || saved.bundle !== bundle || saved.requirement !== requirement) return;
    for (const { key, value } of JSON.parse(saved.choices) as Choice[])
      client.setQueryData(key, value);
  }

  removeHost(host: string): void {
    this.hosts.delete(host);
  }

  private prune(): void {
    const now = this.now();
    for (const [host, plugins] of this.hosts) {
      for (const [id, saved] of plugins) if (saved.expires <= now) plugins.delete(id);
      if (!plugins.size) this.hosts.delete(host);
    }
  }
}
