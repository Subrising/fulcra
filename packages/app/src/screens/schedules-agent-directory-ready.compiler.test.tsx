/**
 * @vitest-environment jsdom
 */
// `useAgentDirectoryReadyHosts` as the app actually runs it, through the React Compiler
// (`experiments.reactCompiler` in app.config.js). Vitest does not apply the compiler, so this test
// compiles the hook's real source from schedules-screen.tsx with babel-plugin-react-compiler,
// mounts it against a fake host store, lets a host finish loading its agent directory and checks
// that Schedules sees it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Hook = (hosts: readonly { serverId: string }[]) => Set<string>;

const HOSTS = [{ serverId: "studio" }, { serverId: "laptop" }];

/** A stand-in for HostRuntimeStore with just what the hook reads. */
function fakeStore() {
  const loaded = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    subscribeAll(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    getSnapshot: (serverId: string) => ({ hasEverLoadedAgentDirectory: loaded.has(serverId) }),
    markLoaded(serverId: string) {
      loaded.add(serverId);
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

/** The hook's source, cut from schedules-screen.tsx exactly as it ships. */
function hookSource(): string {
  // A Windows checkout can have CRLF line ends.
  const file = fs
    .readFileSync(path.join(__dirname, "schedules-screen.tsx"), "utf8")
    .replaceAll("\r\n", "\n");
  const start = file.indexOf("export function useAgentDirectoryReadyHosts(");
  if (start < 0) throw new Error("hook not found in schedules-screen.tsx");
  const end = file.indexOf("\n}\n", start);
  return file.slice(start, end + 2);
}

function loadHook(store: ReturnType<typeof fakeStore>, compile: boolean): Hook {
  const babel = require("@babel/core") as typeof import("@babel/core");
  const source = `import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getHostRuntimeStore } from "fake-runtime";
${hookSource()}`;
  const result = babel.transformSync(source, {
    filename: "use-agent-directory-ready-hosts.tsx",
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
    if (name === "fake-runtime") return { getHostRuntimeStore: () => store };
    return require(name);
  };
  new Function("require", "module", "exports", result.code)(load, module, module.exports);
  return module.exports.useAgentDirectoryReadyHosts as Hook;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(useReadyHosts: Hook): () => string {
  function Probe() {
    const ready = useReadyHosts(HOSTS);
    return <span>{`ready=${[...ready].sort().join(",")}`}</span>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return () => container!.textContent ?? "";
}

describe("useAgentDirectoryReadyHosts under the React Compiler", () => {
  for (const compile of [true, false]) {
    it(`sees a host finish loading after Schedules opens (${compile ? "compiled" : "plain"})`, () => {
      const store = fakeStore();
      const read = mount(loadHook(store, compile));
      expect(read()).toBe("ready=");

      act(() => store.markLoaded("studio"));
      expect(read()).toBe("ready=studio");

      act(() => store.markLoaded("laptop"));
      expect(read()).toBe("ready=laptop,studio");
    });
  }
});
