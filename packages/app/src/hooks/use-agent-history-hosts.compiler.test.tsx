/**
 * @vitest-environment jsdom
 */
// `useAgentHistoryHosts` as the app actually runs it, through the React Compiler
// (`experiments.reactCompiler` in app.config.js). Vitest does not apply the compiler, so this test
// compiles the hook's real source from use-agent-history.ts with babel-plugin-react-compiler,
// mounts it against a fake host store, brings the host online and checks that History can now
// reach it. History opened while its host was still connecting stayed on "Could not load history".
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import React, { useMemo, useSyncExternalStore } from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Status = "connecting" | "online" | "offline";
type Hook = (serverId: string | null) => {
  targetHosts: { serverId: string }[];
  unreachableHosts: { serverId: string }[];
};

const HOSTS = [{ serverId: "studio", label: "Studio" }];

/** A stand-in for HostRuntimeStore with just what the hook reads. */
function fakeStore(initial: Record<string, Status>) {
  const statuses = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    subscribeAll(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    getSnapshot: (serverId: string) =>
      statuses.has(serverId) ? { connectionStatus: statuses.get(serverId)! } : null,
    // The runtime makes the client before the host goes online.
    getClient: (serverId: string) => (statuses.has(serverId) ? { serverId } : null),
    set(serverId: string, status: Status) {
      statuses.set(serverId, status);
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

/** The runtime exports the hook may import, backed by the fake store. */
function fakeRuntime(store: ReturnType<typeof fakeStore>) {
  return {
    getHostRuntimeStore: () => store,
    isHostRuntimeConnected: (snapshot: { connectionStatus: Status } | null) =>
      snapshot?.connectionStatus === "online",
    useHosts: () => HOSTS,
    useHostRuntimeConnectionStatuses: (serverIds: readonly string[]) => {
      const snapshot = useSyncExternalStore(
        (onStoreChange) => store.subscribeAll(onStoreChange),
        () => serverIds.map((id) => store.getSnapshot(id)?.connectionStatus).join("\n"),
      );
      return useMemo(() => {
        const statuses = snapshot.split("\n");
        return new Map(serverIds.map((id, index) => [id, statuses[index]]));
      }, [serverIds, snapshot]);
    },
  };
}

/** The hook's source, cut from use-agent-history.ts exactly as it ships. */
function hookSource(): string {
  // A Windows checkout can have CRLF line ends.
  const file = fs
    .readFileSync(path.join(__dirname, "use-agent-history.ts"), "utf8")
    .replaceAll("\r\n", "\n");
  const start = file.indexOf("export function useAgentHistoryHosts(");
  if (start < 0) throw new Error("hook not found in use-agent-history.ts");
  const end = file.indexOf("\n}\n", start);
  return file.slice(start, end + 2);
}

function loadHook(store: ReturnType<typeof fakeStore>, compile: boolean): Hook {
  const babel = require("@babel/core") as typeof import("@babel/core");
  const source = `import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "fake-runtime";
${hookSource()}`;
  const result = babel.transformSync(source, {
    filename: "use-agent-history-hosts.tsx",
    babelrc: false,
    configFile: false,
    presets: [[require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }]],
    plugins: [
      ...(compile ? [[require.resolve("babel-plugin-react-compiler"), { target: "19" }]] : []),
      require.resolve("@babel/plugin-transform-modules-commonjs"),
    ],
  });
  if (!result?.code) throw new Error("compile failed");
  const module = { exports: {} as Record<string, unknown> };
  const load = (name: string) => {
    if (name === "fake-runtime") return fakeRuntime(store);
    return require(name);
  };
  new Function("require", "module", "exports", result.code)(load, module, module.exports);
  return module.exports.useAgentHistoryHosts as Hook;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(useHostsSplit: Hook): () => string {
  function Probe() {
    const { targetHosts, unreachableHosts } = useHostsSplit(null);
    return (
      <span>
        {`reachable=${targetHosts.map((host) => host.serverId).join(",")};` +
          `unreachable=${unreachableHosts.map((host) => host.serverId).join(",")}`}
      </span>
    );
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return () => container!.textContent ?? "";
}

describe("useAgentHistoryHosts under the React Compiler", () => {
  for (const compile of [true, false]) {
    it(`follows a host that connects after History opens (${compile ? "compiled" : "plain"})`, () => {
      const store = fakeStore({ studio: "connecting" });
      const read = mount(loadHook(store, compile));
      expect(read()).toBe("reachable=;unreachable=studio");

      act(() => store.set("studio", "online"));
      expect(read()).toBe("reachable=studio;unreachable=");

      act(() => store.set("studio", "offline"));
      expect(read()).toBe("reachable=;unreachable=studio");
    });
  }
});
