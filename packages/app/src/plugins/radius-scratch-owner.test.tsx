import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DaemonClient, type DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import {
  RadiusScratchOutputSchema,
  type RadiusScratchOutput,
} from "@getpaseo/protocol/radius-scratch";
import { captureRadiusScratchOwner, useRadiusScratchOwner } from "./radius-scratch-owner";
import { planRadiusChange } from "../../../../control/orca-organization/shared/cc/radius-workflow.mjs";
import {
  RadiusWorkflow,
  type RadiusWorkflowProps,
} from "../../../../control/orca-organization/client/radius-workflow";
import type { RadiusScratchOwnerAdapter } from "../../../../control/orca-organization/shared/radius-scratch";
const state = vi.hoisted(() => ({
  snapshot: {
    client: null as DaemonClient | null,
    clientGeneration: 1,
    connectionEpoch: 1,
    activeConnectionId: "original",
    connectionStatus: "online",
  },
  listeners: new Set<() => void>(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => state.snapshot,
    subscribe: (_id: string, fn: () => void) => {
      state.listeners.add(fn);
      return () => state.listeners.delete(fn);
    },
  }),
}));
vi.mock("./command-centre-connection", () => ({
  COMMAND_CENTRE_PLUGIN_ID: "orca-organization-next",
}));
vi.mock("react-native", () => ({
  View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Text: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  TextInput: ({ value }: { value: string }) => <input value={value} readOnly />,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: React.PropsWithChildren<{
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel: string;
  }>) => (
    <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
const theme = {
  colors: {
    surface0: "#000",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    foreground: "#fff",
    foregroundMuted: "#aaa",
    accent: "#f00",
    accentForeground: "#fff",
    statusSuccess: "#0f0",
    statusWarning: "#ff0",
    statusDanger: "#f00",
  },
};
const id = "00000000-0000-4000-8000-000000000001";
function output(attemptId: string): RadiusScratchOutput {
  return RadiusScratchOutputSchema.parse({
    attemptId,
    kind: "local-scratch-simulation",
    target: "0.61.x",
    outputs: [
      "app.bicep",
      "requirements.json",
      "infra-change.json",
      "deployment-simulation.json",
    ].map((file) => ({ file, bytes: 1, sha256: "a".repeat(64) })),
    nativeCompilation: "not_run",
    environmentDeployment: "held",
    externalEffects: false,
  });
}
let root: Root, container: HTMLDivElement;
const clients: DaemonClient[] = [];
beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.snapshot = {
    client: null,
    clientGeneration: 1,
    connectionEpoch: 1,
    activeConnectionId: "original",
    connectionStatus: "online",
  };
  state.listeners.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.unstubAllGlobals();
});
async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!button) throw Error("Missing button: " + label);
  await act(async () => button.click());
}
async function prepare(props: RadiusWorkflowProps) {
  await act(async () => root.render(<RadiusWorkflow {...props} />));
  await press("Plan infrastructure change");
  await press("Validate local requirements");
}
const write = "Write private scratch simulation",
  prune = "Allow pruning known retained scratch attempts";
test("Radius consumer explicit normal attempt never obtains a prune purpose or retries", async () => {
  const simulate = vi.fn(
    async (input: Parameters<NonNullable<RadiusWorkflowProps["simulate"]>>[0]) =>
      output(input.attemptId),
  );
  const pruneAndSimulate = vi.fn(
    async (input: Parameters<NonNullable<RadiusWorkflowProps["pruneAndSimulate"]>>[0]) =>
      output(input.attemptId),
  );
  await prepare({ theme, simulate, pruneAndSimulate, checkOriginalLifetime: () => {} });
  expect(simulate).not.toHaveBeenCalled();
  await press(write);
  await press(write);
  expect(simulate).toHaveBeenCalledTimes(1);
  expect(simulate.mock.calls[0]![0]).not.toHaveProperty("confirmDestructive");
  expect(pruneAndSimulate).not.toHaveBeenCalled();
  expect(container.textContent).toContain("real deployment remains held");
});
test("Radius consumer deliberate retention choice alone selects the separate literal confirmed purpose", async () => {
  const simulate = vi.fn(
    async (input: Parameters<NonNullable<RadiusWorkflowProps["simulate"]>>[0]) =>
      output(input.attemptId),
  );
  const pruneAndSimulate = vi.fn(
    async (input: Parameters<NonNullable<RadiusWorkflowProps["pruneAndSimulate"]>>[0]) =>
      output(input.attemptId),
  );
  await prepare({ theme, simulate, pruneAndSimulate, checkOriginalLifetime: () => {} });
  await press(prune);
  expect(pruneAndSimulate).not.toHaveBeenCalled();
  await press(write);
  expect(simulate).not.toHaveBeenCalled();
  expect(pruneAndSimulate).toHaveBeenCalledTimes(1);
  expect(pruneAndSimulate.mock.calls[0]![0]).toMatchObject({ confirmDestructive: true });
  expect(container.textContent).toContain("Eviction ends retained UUID");
});
test("Radius consumer refusal remains uncertain and does not escalate into pruning", async () => {
  const simulate = vi.fn(async () => {
    throw Error("private path secret");
  });
  const pruneAndSimulate = vi.fn();
  await prepare({ theme, simulate, pruneAndSimulate, checkOriginalLifetime: () => {} });
  await press(write);
  await press(prune);
  await press(write);
  expect(simulate).toHaveBeenCalledTimes(1);
  expect(pruneAndSimulate).not.toHaveBeenCalled();
  expect(container.textContent).toContain("outcome is unknown");
  expect(container.textContent).not.toContain("private path secret");
});
test("Radius consumer held attempt retired before reply cannot publish confirmation or resend", async () => {
  let resolve: (value: RadiusScratchOutput) => void = () => {
    throw Error("not held");
  };
  let attempt = id;
  const client = {
    simulateRadiusScratch: vi.fn(
      async (input: Parameters<DaemonClient["simulateRadiusScratch"]>[0]) => {
        attempt = input.attemptId;
        return new Promise<RadiusScratchOutput>((done) => {
          resolve = done;
        });
      },
    ),
  };
  const plugin = new AbortController();
  const captured = captureRadiusScratchOwner(client, plugin.signal, () => true);
  await prepare({ theme, ...captured.adapter });
  await press(write);
  captured.retire();
  await act(async () => resolve(output(attempt)));
  await press(write);
  expect(client.simulateRadiusScratch).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("files written and read back");
  expect(container.textContent).toContain("outcome is unknown");
});
test("Radius consumer plugin abort before an explicit attempt has zero client calls", async () => {
  const client = { simulateRadiusScratch: vi.fn(async () => output(id)) };
  const plugin = new AbortController();
  const captured = captureRadiusScratchOwner(client, plugin.signal, () => true);
  await prepare({ theme, ...captured.adapter });
  plugin.abort();
  await press(write);
  expect(client.simulateRadiusScratch).not.toHaveBeenCalled();
});
async function connectedClient() {
  let open = () => {},
    message: (data: unknown, isBinary: boolean) => void = () => {};
  const transport: DaemonTransport = {
    send: () => {},
    close: () => {},
    onOpen: (fn) => {
      open = fn;
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
    onMessage: (fn) => {
      message = fn;
      return () => {};
    },
  };
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "radius-ui",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  clients.push(client);
  const permissions = ["daemon.manage", "command-centre.manage", "accounts.manage"];
  const publish = (allowed = true) =>
    message(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "server_info",
            serverId: "same",
            hostname: null,
            version: null,
            features: {},
            permissions: allowed ? permissions : ["daemon.read"],
          },
        },
      }),
      false,
    );
  const pending = client.connect();
  open();
  publish();
  await pending;
  state.snapshot.client = client;
  return { client, publish };
}
test("Radius consumer hook withholds production adapter; observed revoke-regain never revives its original closure", async () => {
  const { client, publish } = await connectedClient();
  const plugin = { id: "orca-organization-next", lifetime: new AbortController() };
  let selected: RadiusScratchOwnerAdapter | undefined;
  function Harness({ enabled = false }: { enabled?: boolean }) {
    selected = useRadiusScratchOwner("host", client, plugin, enabled);
    return null;
  }
  await act(async () => root.render(<Harness />));
  expect(selected).toBeUndefined();
  await act(async () => root.render(<Harness enabled />));
  const old = selected;
  expect(old).toBeDefined();
  old?.checkOriginalLifetime();
  await act(async () => {
    publish(false);
    publish(true);
  });
  expect(() => old?.checkOriginalLifetime()).toThrow();
  expect(selected).toBeDefined();
  selected?.checkOriginalLifetime();
  const current = selected;
  await act(async () => {
    state.snapshot.connectionEpoch++;
    for (const listener of state.listeners) listener();
  });
  expect(() => current?.checkOriginalLifetime()).toThrow();
  await act(async () => plugin.lifetime.abort());
  expect(selected).toBeUndefined();
});

test("Radius purpose adapter refuses destructive fields on its ordinary callback before any client call", async () => {
  const client = { simulateRadiusScratch: vi.fn(async () => output(id)) };
  const captured = captureRadiusScratchOwner(client, new AbortController().signal, () => true);
  const plan = planRadiusChange({
    application: "demo",
    requirements: [{ id: "port", resourceId: "web", port: 8080 }],
    current: [],
    proposed: [{ id: "web", image: "nginx:1.27.5", port: 8080 }],
  });
  const input = {
    attemptId: id,
    plan,
    expectedRevision: plan.revision,
    confirmDestructive: true as const,
  };
  await expect(captured.adapter.simulate(input, new AbortController().signal)).rejects.toThrow();
  expect(client.simulateRadiusScratch).not.toHaveBeenCalled();
  await expect(
    captured.adapter.pruneAndSimulate(input, new AbortController().signal),
  ).resolves.toMatchObject({ nativeCompilation: "not_run" });
  expect(client.simulateRadiusScratch).toHaveBeenCalledTimes(1);
});
