import { createPluginHosts } from "./hosts";
import { expect, test } from "vitest";
import { QueryObserver, skipToken } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginRegistry } from "./registry";

function registry() {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "plugin-lifetime-test" });
  const released: string[] = [];
  const plugins = new PluginRegistry({
    version: "0.8.0",
    createRuntime: (installation) => {
      // The registry owns each installation's API scope; record when it is released.
      const api = installation.paseo;
      const dispose = api.dispose.bind(api);
      installation.paseo = {
        ...api,
        dispose: async () => {
          released.push(installation.id);
          await dispose();
        },
      };
      return {
        hosts: createPluginHosts(
          {
            getHosts: () => [],
            getSnapshot: () => null,
            subscribeAll: () => () => {},
            subscribeHostList: () => () => {},
          },
          installation.lifetime.signal,
        ),
        paseo: installation.paseo,
        rpc: async () => {
          throw new Error("Unexpected plugin RPC");
        },
        openSurface: () => {},
        openScreen: () => {},
        openSettings: () => {},
        openPanel: () => {},
        addComposerPill: () => ({ update() {}, remove() {} }),
        addHeaderButton: () => ({ update() {}, remove() {} }),
        playAudio: async () => {},
      };
    },
  });
  return { client, released, plugins };
}

function catalog(id: string, body: string) {
  return {
    id,
    requirements: { paseo: ">=0.8.0" },
    clientBundle: `(function() { return { default: function(plugin) { ${body} } }; })`,
  };
}

test("failed plugin initialization disposes its API scope", async () => {
  const h = registry();
  h.plugins.installCatalog("host", [catalog("failed", 'throw new Error("setup failed");')], {
    client: h.client,
  });
  await expect.poll(() => h.released).toEqual(["failed"]);
  expect(h.plugins.getSnapshot()).toEqual([]);
});

test("unloading releases the API even when plugin cleanup throws, preserving another plugin", async () => {
  const h = registry();
  const failing = catalog("failing", 'return function() { throw new Error("cleanup failed"); };');
  const surviving = catalog("surviving", "return function() {};");
  h.plugins.installCatalog("host", [failing, surviving], { client: h.client });
  h.plugins.installCatalog("host", [surviving], { client: h.client });
  await expect.poll(() => h.released).toEqual(["failing"]);
  expect(h.plugins.getSnapshot().map((plugin) => plugin.id)).toEqual(["surviving"]);
  h.plugins.removeHost("host");
  await expect.poll(() => h.released).toEqual(["failing", "surviving"]);
});

test("an invalid async client entry is disposed and its rejected continuation is observed", async () => {
  const h = registry();
  h.plugins.installCatalog(
    "host",
    [catalog("async-entry", 'return Promise.reject(new Error("asynchronous setup failed"));')],
    { client: h.client },
  );
  await expect.poll(() => h.released).toEqual(["async-entry"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.plugins.getSnapshot()).toEqual([]);
});

test("reconnect disposes the old API scope while restoring only opted-in view state", async () => {
  const h = registry();
  const entry = catalog("retained-view", "return function() {};");
  h.plugins.installCatalog("host", [entry], { client: h.client });
  const first = h.plugins.getSnapshot()[0]!;
  const observer = new QueryObserver(first.queryClient, {
    queryKey: ["view"],
    queryFn: skipToken,
    enabled: false,
    meta: { paseoLocalView: true },
    initialData: { selected: "book", zoom: 1.25 },
  });
  expect(observer.getCurrentResult().data).toEqual({ selected: "book", zoom: 1.25 });
  first.queryClient.setQueryData(["authority"], { owner: "old" });
  h.plugins.suspendHost("host");
  await expect.poll(() => h.released).toEqual(["retained-view"]);
  expect(first.queryClient.getQueryCache().getAll()).toEqual([]);
  h.plugins.installCatalog("host", [entry], { client: h.client });
  const current = h.plugins.getSnapshot()[0]!;
  expect(current.queryClient).not.toBe(first.queryClient);
  expect(current.queryClient.getQueryData(["view"])).toEqual({ selected: "book", zoom: 1.25 });
  expect(current.queryClient.getQueryData(["authority"])).toBeUndefined();
  h.plugins.removeHost("host");
  await expect.poll(() => h.released).toEqual(["retained-view", "retained-view"]);
  expect(h.plugins.getSnapshot()).toEqual([]);
});
