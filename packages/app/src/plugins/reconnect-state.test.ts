import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { PluginReconnectState } from "./reconnect-state";

it("restores opted local choices into a new client without retaining activity or mutations", () => {
  const source = new QueryClient(),
    target = new QueryClient();
  const view = { graphOpen: true, selected: "chosen", frozen: true, search: "Book" };
  const observer = new QueryObserver(source, {
    queryKey: ["view", "host"],
    queryFn: skipToken,
    enabled: false,
    meta: { paseoLocalView: true },
    initialData: view,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  source.setQueryData(["activity"], { permission: "stale" });
  source.getMutationCache().build(source, { mutationFn: async () => "must not replay" });
  const cache = new PluginReconnectState();
  cache.save("host", "plugin", "bundle", "*", source);
  source.clear();
  cache.restore("host", "plugin", "bundle", "*", target);
  expect(target.getQueryData(["view", "host"])).toEqual(view);
  expect(target.getQueryData(["activity"])).toBeUndefined();
  expect(target.getMutationCache().getAll()).toEqual([]);
  expect(
    target
      .getQueryCache()
      .getAll()
      .map((q) => q.options.queryFn),
  ).toEqual([undefined]);
  unsubscribe();
  target.clear();
});

function local(client: QueryClient, value: unknown, options = {}) {
  return new QueryObserver(client, {
    queryKey: ["view"],
    queryFn: skipToken,
    enabled: false,
    meta: { paseoLocalView: true },
    initialData: value,
    ...options,
  });
}

it.each([{ meta: undefined }, { queryFn: async () => "network" }, { queryFn: undefined }])(
  "excludes a query unless every local-state condition holds: %o",
  (options) => {
    const source = new QueryClient(),
      target = new QueryClient(),
      cache = new PluginReconnectState();
    local(source, "old", options);
    cache.save("h", "p", "bundle", undefined, source);
    cache.restore("h", "p", "bundle", undefined, target);
    expect(target.getQueryData(["view"])).toBeUndefined();
    source.clear();
    target.clear();
  },
);

it.each([
  new Date(),
  new Map(),
  () => 1,
  BigInt(1),
  Infinity,
  { value: undefined },
  "界".repeat(12000),
])("rejects non-JSON or oversized data", (value) => {
  const source = new QueryClient(),
    target = new QueryClient(),
    cache = new PluginReconnectState();
  local(source, { value });
  cache.save("h", "p", "bundle", undefined, source);
  cache.restore("h", "p", "bundle", undefined, target);
  expect(target.getQueryCache().getAll()).toEqual([]);
  source.clear();
  target.clear();
});

it("never invokes accessors or toJSON and bounds cycles", () => {
  const getter = vi.fn(() => "secret"),
    toJSON = vi.fn(() => "secret");
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const value of [
    Object.defineProperty({}, "data", { get: getter, enumerable: true }),
    { toJSON },
    cycle,
  ]) {
    const source = new QueryClient(),
      target = new QueryClient(),
      cache = new PluginReconnectState();
    local(source, value);
    cache.save("h", "p", "bundle", undefined, source);
    cache.restore("h", "p", "bundle", undefined, target);
    expect(target.getQueryCache().getAll()).toEqual([]);
    source.clear();
    target.clear();
  }
  expect(getter).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
});

it.each(["host", "plugin", "bundle", "requirement", "expired", "removed"])(
  "does not restore after %s changes",
  (change) => {
    let now = 0;
    const cache = new PluginReconnectState(() => now),
      source = new QueryClient(),
      target = new QueryClient();
    local(source, { search: "old" });
    cache.save("h", "p", "b", "r", source);
    if (change === "expired") now = 30 * 60 * 1000;
    if (change === "removed") cache.removeHost("h");
    cache.restore(
      change === "host" ? "other" : "h",
      change === "plugin" ? "other" : "p",
      change === "bundle" ? "other" : "b",
      change === "requirement" ? "other" : "r",
      target,
    );
    expect(target.getQueryData(["view"])).toBeUndefined();
    source.clear();
    target.clear();
  },
);

it("copies data and restores once before a new observer applies its defaults", () => {
  const cache = new PluginReconnectState(),
    source = new QueryClient(),
    target = new QueryClient(),
    view = { search: "saved" };
  local(source, view);
  cache.save("h", "p", "b", undefined, source);
  view.search = "mutated";
  cache.restore("h", "p", "b", undefined, target);
  const observer = local(target, { search: "default" });
  expect(observer.getCurrentResult().data).toEqual({ search: "saved" });
  target.clear();
  cache.restore("h", "p", "b", undefined, target);
  expect(target.getQueryData(["view"])).toBeUndefined();
  source.clear();
  target.clear();
});

it("bounds retained plugins and source-bundle memory", () => {
  const source = new QueryClient(),
    target = new QueryClient(),
    cache = new PluginReconnectState();
  local(source, "saved");
  for (let i = 0; i < 65; i++) cache.save("h", String(i), "b", undefined, source);
  cache.restore("h", "0", "b", undefined, target);
  expect(target.getQueryData(["view"])).toBeUndefined();
  cache.restore("h", "64", "b", undefined, target);
  expect(target.getQueryData(["view"])).toBe("saved");
  target.clear();
  const oversized = "x".repeat(4 * 1024 * 1024);
  cache.save("large", "p", oversized, undefined, source);
  cache.restore("large", "p", oversized, undefined, target);
  expect(target.getQueryData(["view"])).toBeUndefined();
  source.clear();
  target.clear();
});
