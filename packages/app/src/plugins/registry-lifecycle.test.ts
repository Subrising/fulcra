import { filePanelTitle } from "@/file-panels/choice/presentation";
import { i18n } from "@/i18n/i18next";
import { createPluginHosts } from "./hosts";
import { expect, test } from "vitest";
import { QueryObserver, skipToken } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginRegistry } from "./registry";

<<<<<<< HEAD
function registry() {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "plugin-lifetime-test" });
  const released: string[] = [];
=======
const audio = { play: async () => 0 };

/** A host client that records open event observations by their first event name. */
function observingClient() {
  const open = new Set<string>();
  const client = {
    observeEvents(events: string[]) {
      const [name] = events;
      open.add(name);
      return {
        ready: Promise.resolve({ subscriptionId: name }),
        subscribe: () => () => undefined,
        release: async () => {
          open.delete(name);
        },
      };
    },
    invokePluginRpc: async () => null,
  } as unknown as DaemonClient;
  return { client, open };
}

function registry(
  localeSource: import("@getpaseo/plugin/client/host").PluginLocaleSource = {
    getLocale: () => "en",
    subscribe: () => () => {},
  },
) {
  const setupClients = new Map<string, PaseoApi>();
>>>>>>> refs/remotes/upstream/tags/v0.14.0
  const plugins = new PluginRegistry({
    localeSource,
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
        i18n: installation.i18n,
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

<<<<<<< HEAD
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
  expect(current.queryClient).toBe(first.queryClient);
  expect(current.queryClient.getQueryData(["view"])).toEqual({ selected: "book", zoom: 1.25 });
  expect(current.queryClient.getQueryData(["authority"])).toBeUndefined();
  h.plugins.removeHost("host");
  await expect.poll(() => h.released).toEqual(["retained-view", "retained-view"]);
  expect(h.plugins.getSnapshot()).toEqual([]);
=======
test("locale snapshots preserve installation state and observations, then release locale subscriptions", async () => {
  let locale = "en";
  const listeners = new Set<() => void>();
  const h = registry({
    getLocale: () => locale,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const translated = {
    ...catalog("notes"),
    clientBundle: `(function(require) {
    const {defineTranslations} = require("@getpaseo/plugin/client");
    const messages = defineTranslations({resources:{en:{title:"Notes"},"zh-CN":{title:"笔记"}}});
    return {default(plugin) {
      plugin.paseo.observeEvents(["notes"]);
      plugin.addScreen({id:"notes",title:messages.message("title"),Component:function Notes(){return null;}});
      plugin.addFilePanel({id:"notes",title:messages.message("title"),icon:"FileText",files:{extensions:["notes"]},Component:function NotesFile(){return null;}});
      return function(){};
    }};
  })`,
  };
  h.plugins.installCatalog("host", [translated], { client: h.client, audio });
  expect(h.plugins.getEvaluationError("host", "notes")).toBeUndefined();
  const [before] = h.plugins.getSnapshot();
  function fileTitle(plugin: typeof before) {
    const contribution = plugin.filePanels[0];
    return filePanelTitle(i18n.t, {
      id: "plugin:notes/notes",
      builtin: false,
      files: contribution.files,
      plugin,
      contribution,
    });
  }
  expect(fileTitle(before)).toBe("Notes");
  expect(before.locale).toBe("en");
  expect(
    before.i18n.resolve(
      before.surfaces[0].title as import("@getpaseo/plugin/client").PluginText,
      before.locale,
    ),
  ).toBe("Notes");
  locale = "zh-CN";
  for (const listener of listeners) listener();
  const [after] = h.plugins.getSnapshot();
  expect(after.locale).toBe("zh-CN");
  expect(fileTitle(after)).toBe("笔记");
  expect(fileTitle(before)).toBe("Notes");
  expect(after.filePanels[0].Component).toBe(before.filePanels[0].Component);
  expect(
    after.i18n.resolve(
      after.surfaces[0].title as import("@getpaseo/plugin/client").PluginText,
      after.locale,
    ),
  ).toBe("笔记");
  expect(after.lifetime).toBe(before.lifetime);
  expect(after.queryClient).toBe(before.queryClient);
  expect(after.paseo).toBe(before.paseo);
  expect(after.surfaces[0].Component).toBe(before.surfaces[0].Component);
  expect(h.open).toEqual(new Set(["notes"]));
  h.plugins.installCatalog("host", [translated], { client: h.client, audio });
  expect(h.plugins.getSnapshot()[0].i18n).toBe(before.i18n);
  h.plugins.removeHost("host");
  expect(listeners.size).toBe(0);
  await expect.poll(() => h.open.size).toBe(0);
>>>>>>> refs/remotes/upstream/tags/v0.14.0
});
