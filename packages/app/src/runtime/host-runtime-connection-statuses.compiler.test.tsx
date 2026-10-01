/**
 * @vitest-environment jsdom
 */
// L9: `useHostRuntimeConnectionStatuses` as the app actually runs it, through the React Compiler
// (`experiments.reactCompiler` in app.config.js). Vitest does not apply the compiler, so this test
// compiles the hook's real source from host-runtime.ts with babel-plugin-react-compiler, mounts it
// against a fake host store, changes a host's status and checks that the hook reports the change.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Status = "idle" | "connecting" | "online" | "offline" | "error";
type Hook = (serverIds: readonly string[]) => ReadonlyMap<string, Status>;

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
    getConnectionStatusSince: () => null,
    set(serverId: string, status: Status) {
      statuses.set(serverId, status);
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

/** The hook's source, cut from host-runtime.ts exactly as it ships. */
function hookSource(): string {
  const file = fs.readFileSync(path.join(__dirname, "host-runtime.ts"), "utf8");
  const start = file.indexOf("export function useHostRuntimeConnectionStatuses(");
  if (start < 0) throw new Error("hook not found in host-runtime.ts");
  const end = file.indexOf("\n}\n", start);
  return file.slice(start, end + 2);
}

function loadHook(store: ReturnType<typeof fakeStore>, compile: boolean): Hook {
  const babel = require("@babel/core") as typeof import("@babel/core");
  const source = `import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getHostRuntimeStore } from "fake-store";
${hookSource()}`;
  const result = babel.transformSync(source, {
    filename: "use-host-runtime-connection-statuses.tsx",
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
    if (name === "fake-store") return { getHostRuntimeStore: () => store };
    return require(name);
  };
  new Function("require", "module", "exports", result.code)(load, module, module.exports);
  return module.exports.useHostRuntimeConnectionStatuses as Hook;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(useStatuses: Hook): () => string {
  const ids = ["studio", "laptop"];
  function Probe() {
    const statuses = useStatuses(ids);
    return <span>{ids.map((id) => `${id}=${statuses.get(id)}`).join(",")}</span>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return () => container!.textContent ?? "";
}

describe("useHostRuntimeConnectionStatuses under the React Compiler (L9)", () => {
  for (const compile of [true, false]) {
    it(`reports a host's new status after it changes (${compile ? "compiled" : "plain"})`, () => {
      const store = fakeStore({ studio: "connecting", laptop: "connecting" });
      const read = mount(loadHook(store, compile));
      expect(read()).toBe("studio=connecting,laptop=connecting");

      act(() => store.set("studio", "online"));
      act(() => store.set("laptop", "error"));

      expect(read()).toBe("studio=online,laptop=error");
    });
  }
});
