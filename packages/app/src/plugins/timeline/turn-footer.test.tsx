/**
 * @vitest-environment jsdom
 */
import appPackage from "../../../package.json";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostClient = vi.hoisted(() => ({ invokePluginRpc: async () => null }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => hostClient as unknown as DaemonClient,
  useHosts: () => [{ serverId: "host-1", label: "Local" }],
}));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("../navigation", () => ({
  createPluginNavigation: () => ({}),
}));
vi.mock("../client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: {},
    dispose: () => {},
    rpc: async () => undefined,
    openSurface: () => undefined,
    openPanel: () => undefined,
    addComposerPill: () => ({ update() {}, remove() {} }),
    addHeaderButton: () => ({ update() {}, remove() {} }),
  }),
}));
vi.mock("../icons", () => ({
  Icon: () => null,
  resolvePluginIcon: () => () => null,
}));

import { pluginRegistry } from "../registry";
import { PluginTurnFooters } from "./turn-footer";

// FULCRA(plugin-host): turn-footer seam.
const bundle = `(function(require) {
  const React = require("react");
  return { default: function(plugin) {
    function Footer(props) {
      const commands = props.turn.toolCalls.map(function(call) { return call.detail.command; }).join(", ");
      return React.createElement("span", null, props.agentId + ": " + commands + " in " + props.turn.durationMs + " ms");
    }
    plugin.addTurnFooter({ id: "what-it-did", Component: Footer });
    return function() {};
  } };
})`;
const failingBundle = `(function() {
  return { default: function(plugin) {
    function Broken() { throw new Error("turn footer exploded"); }
    plugin.addTurnFooter({ id: "broken", Component: Broken });
    return function() {};
  } };
})`;
const toolCalls = [
  { name: "Bash", status: "completed" as const, detail: { type: "shell" as const, command: "ls" } },
  {
    name: "Bash",
    status: "completed" as const,
    detail: { type: "shell" as const, command: "npm test" },
  },
];

const roots: Array<ReturnType<typeof createRoot>> = [];
const containers: HTMLElement[] = [];
const daemonClient = {} as DaemonClient;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  pluginRegistry.removeHost("host-1");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderFooters(clientBundle: string) {
  pluginRegistry.installCatalog(
    "host-1",
    [{ id: "reports", requirements: { paseo: `>=${appPackage.version}` }, clientBundle }],
    { client: daemonClient },
  );
  const container = document.createElement("div");
  containers.push(container);
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <div>
        <span>Before</span>
        <PluginTurnFooters
          serverId="host-1"
          agentId="agent-1"
          toolCalls={toolCalls}
          durationMs={19000}
        />
        <span>After</span>
      </div>,
    ),
  );
  return container;
}

describe("PluginTurnFooters", () => {
  it("gives each plugin footer the turn's tool calls and duration", async () => {
    const container = await renderFooters(bundle);
    expect(container.textContent).toContain("agent-1: ls, npm test in 19000 ms");
  });

  it("contains a crashing footer to its own slot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = await renderFooters(failingBundle);
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
    expect(container.textContent).toContain("Plugin failed");
  });
});
