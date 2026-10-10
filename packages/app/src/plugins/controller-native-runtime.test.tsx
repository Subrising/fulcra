// @vitest-environment jsdom
import React from "react";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";
import type { EvaluatedPlugin } from "./types";

// FULCRA(plugin-host): the controller plugin's Leadership page, compiled by the daemon's plugin compiler and
// evaluated through the app's plugin runtime map (react-native, the UI kit, the React Native kit). The Hermes rules
// that broke it on the phone are checked in packages/server compiler.test.ts; this test renders the page.

// The test stub of lucide-react-native has no icons; the sidebar items name real ones.
vi.mock("./icons", () => ({ resolvePluginIcon: () => () => null, Icon: () => null }));

const PRIME = "33333333-3333-4333-8333-333333333333",
  LEAD = "44444444-4444-4444-8444-444444444444",
  TASK_A = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
  TASK_B = "55555555-5555-4555-8555-555555555555",
  PROJECT = "11111111-1111-4111-8111-111111111111",
  REQUEST = "22222222-2222-4222-8222-222222222222";
const time = () => new Date().toISOString();
const node = (id: string, task: string, title: string) => ({
  id,
  task,
  host: "mini",
  serverId: "srv_example",
  agentId: id,
  title,
  provider: "claude",
  model: "opus-5",
  mode: "delegated",
  status: "running",
  pending: 0,
  observedAt: time(),
  updatedAt: time(),
  error: null,
});
const fleet = {
  observedAt: time(),
  total: 2,
  partial: false,
  note: "Synthetic fleet",
  supervisionAvailable: true,
  supervisors: [
    {
      id: PRIME,
      task: TASK_A,
      active: true,
      maxWorkers: 4,
      reserved: 0,
      workers: [
        {
          requestId: REQUEST,
          workerId: LEAD,
          phase: "running",
          ownership: "linked",
          fault: null,
          lastEvent: null,
        },
      ],
    },
    { id: LEAD, task: TASK_B, active: true, maxWorkers: 4, reserved: 0, workers: [] },
  ],
  nodes: [node(PRIME, TASK_A, "Chief of staff"), node(LEAD, TASK_B, "Memory lead")],
  tasks: [
    { id: TASK_A, title: "Run the portfolio", identifier: "P-1" },
    { id: TASK_B, title: "Shared memory format", identifier: "P-2" },
  ],
  edges: [],
};
const projects = {
  observedAt: time(),
  available: true,
  partial: false,
  projects: [
    { id: PROJECT, name: "Shared memory", description: "Synthetic", status: "in_progress" },
  ],
  membership: [
    { taskId: TASK_A, projectId: PROJECT },
    { taskId: TASK_B, projectId: PROJECT },
  ],
  note: "Synthetic projects",
};

function answer(method: string): unknown {
  if (method === "organization.fleet") return fleet;
  if (method === "organization.projects") return projects;
  if (method === "organization.role-directory")
    return {
      observedAt: time(),
      available: false,
      unavailable: "Synthetic",
      primes: [],
      projectSeats: [],
    };
  if (method === "organization.project-briefing")
    return {
      observedAt: time(),
      partial: false,
      scanned: 0,
      total: 0,
      missing: 0,
      unavailable: 0,
      nextCursor: null,
      entries: [],
    };
  // Other reads stay pending: the page shows their loading states.
  return new Promise(() => undefined);
}

const runtime = {
  paseo: {},
  async rpc() {
    return {};
  },
  openSettings() {},
  openScreen() {},
  openSurface() {},
  openPanel() {},
  addHeaderButton: () => ({ update() {}, remove() {} }),
  addComposerPill: () => ({ update() {}, remove() {} }),
  device: {},
  hosts: { subscribe: () => () => undefined, getSnapshot: () => [], getPaseoClient: () => ({}) },
} as unknown as PluginClientRuntime;

const THEME = {
  colors: new Proxy({}, { get: () => "#202020" }),
} as unknown as PluginSurfaceProps["theme"];
const HOST = { id: "srv_example", label: "Example" };
const LAYOUT: PluginSurfaceProps["layout"] = { compact: true, platform: "ios" };
const PASEO = {} as never;
const queryClient = new QueryClient();
async function invoke(method: string): Promise<unknown> {
  return answer(method);
}

let plugin: EvaluatedPlugin;

beforeAll(() => {
  // The daemon's compiler runs in its own Node process: esbuild refuses jsdom's TextEncoder and Uint8Array.
  const compiler = join(__dirname, "../../../server/src/server/plugins/compiler.ts");
  const entry = join(__dirname, "../../../../control/orca-organization/index.client.tsx");
  const clientBundle = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { compilePlugin } from ${JSON.stringify(compiler)};
const { clientBundle } = await compilePlugin({ client: ${JSON.stringify(entry)}, server: null }, { minifyWhitespace: true });
process.stdout.write(clientBundle);`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  plugin = runPluginClientBundle("orca-organization-next", clientBundle, runtime);
}, 120_000);

afterEach(() => {
  cleanup();
});

it("renders the Leadership page from the compiled controller bundle with the native runtime map", async () => {
  const errors: string[] = [];
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
  const surface = plugin.surfaces.find((item) => item.id === "leadership");
  expect(surface).toBeDefined();
  const Surface = surface!.Component as React.ComponentType<PluginSurfaceProps>;
  render(
    <QueryClientProvider client={queryClient}>
      <PaseoApiProvider paseo={PASEO}>
        <PluginRpcProvider invoke={invoke}>
          <Surface theme={THEME} host={HOST} layout={LAYOUT} />
        </PluginRpcProvider>
      </PaseoApiProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Who leads your work")).toBeTruthy();
  expect(await screen.findByText("Shared memory")).toBeTruthy();
  expect(screen.queryByText(/This view could not be displayed/)).toBeNull();
  consoleError.mockRestore();
  expect(errors.filter((error) => /Element type is invalid/.test(error))).toEqual([]);
}, 60_000);
