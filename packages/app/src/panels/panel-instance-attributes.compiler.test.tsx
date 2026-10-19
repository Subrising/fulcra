/**
 * @vitest-environment jsdom
 */
// `useModifiedPanelTabIds` as the app actually runs it, through the React Compiler
// (`experiments.reactCompiler` in app.config.js). Vitest does not apply the compiler, so this test
// compiles the real panel-instance-attributes.ts with babel-plugin-react-compiler, mounts the hook,
// marks a tab modified through the module's own setter and checks that the hook reports it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type PanelAttributesModule = typeof import("./panel-instance-attributes");

const TAB_IDS = ["notes", "readme"];

function loadModule(compile: boolean): PanelAttributesModule {
  const babel = require("@babel/core") as typeof import("@babel/core");
  const source = fs.readFileSync(path.join(__dirname, "panel-instance-attributes.ts"), "utf8");
  const result = babel.transformSync(source, {
    filename: "panel-instance-attributes.tsx",
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
    if (name === "@/panels/pane-context") return { usePaneContext: () => ({}) };
    return require(name);
  };
  new Function("require", "module", "exports", result.code)(load, module, module.exports);
  return module.exports as unknown as PanelAttributesModule;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(attributes: PanelAttributesModule): () => string {
  function Probe() {
    const modified = attributes.useModifiedPanelTabIds({
      serverId: "studio",
      workspaceId: "main",
      tabIds: TAB_IDS,
    });
    return <span>{`modified=${[...modified].join(",")}`}</span>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return () => container!.textContent ?? "";
}

describe("useModifiedPanelTabIds under the React Compiler", () => {
  for (const compile of [true, false]) {
    it(`reports a tab that becomes modified after mount (${compile ? "compiled" : "plain"})`, () => {
      const attributes = loadModule(compile);
      const read = mount(attributes);
      expect(read()).toBe("modified=");

      const notes = { serverId: "studio", workspaceId: "main", tabId: "notes" };
      act(() => attributes.setPanelInstanceAttributes(notes, { modified: true }));
      expect(read()).toBe("modified=notes");

      act(() => attributes.setPanelInstanceAttributes(notes, { modified: false }));
      expect(read()).toBe("modified=");
    });
  }
});
