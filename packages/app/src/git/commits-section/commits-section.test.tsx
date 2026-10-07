import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitsSection } from "./commits-section";
import { darkTheme } from "@/styles/theme";
import { toPluginTheme } from "@/plugins/theme";
import { RadiusWorkflow } from "../../../../../control/orca-organization/client/radius-workflow";
import { ContextManagedContent } from "@/context/managed-content";
import { ContextManagedOutputs } from "@/context/managed-outputs";
import { ContextOutputs } from "@/context/outputs";
import { ContextReports } from "@/context/reports";
import { ContextCheckout } from "@/context/checkout";
import { ContextContainedFiles, ContextProviderChildren } from "@/context/resources";

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/git/use-commits-query", () => ({
  useCheckoutCommitsQuery: () => ({ status: "idle" }),
}));

vi.mock("@/git/themed-chevron", () => ({
  ThemedChevron: () => null,
  chevronColorMapping: () => ({}),
}));

vi.mock("./commit-row", () => ({
  CommitRow: () => null,
}));

const contextHost = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const connectionListeners = new Set<() => void>();
  const info = {
    permissions: ["workspace.read", "workspace.write"],
    features: { commitTopology: true, stashApplyBySha: true } as Record<string, boolean>,
  };
  const client = {
    isConnected: true,
    getLastServerInfoMessage: () => info,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeConnectionStatus: (listener: () => void) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    listCheckoutCommits: vi.fn(),
    stashList: vi.fn(),
    stashApply: vi.fn(),
    listProviderSubagents: vi.fn(),
    listDirectory: vi.fn(),
    readNativeOwnerReportInbox: vi.fn(),
    readNativeEvidenceIndex: vi.fn(),
    readManagedArtifactIndex: vi.fn(),
    readManagedArtifactContent: vi.fn(),
  };
  const session = {
    client,
    clientGeneration: 1,
    agents: new Map([
      [
        "parent",
        {
          id: "parent",
          createdAt: new Date("2026-10-01T00:00:00Z"),
          runtimeInstanceId: "native-A",
          runtimeInfo: null,
          persistence: null,
          workspaceId: "workspace",
          archivedAt: null,
        },
      ],
    ]),
    workspaces: new Map([["workspace", { workspaceDirectory: "/repo" }]]),
  };
  return { client, info, listeners, connectionListeners, state: { sessions: { server: session } } };
});
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => contextHost.client }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof contextHost.state) => unknown) => selector(contextHost.state),
    {
      getState: () => contextHost.state,
      subscribe: () => () => {},
    },
  ),
}));

const reportHost = vi.hoisted(() => ({ lifetime: new AbortController(), invoke: vi.fn() }));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugin: () => reportHost,
  useControllerPlugin: () => reportHost,
}));
vi.mock("@/plugins/surface-runtime", () => ({ usePluginSurfaceRuntime: () => reportHost }));
vi.mock("@/plugins/command-centre-connection", () => ({
  COMMAND_CENTRE_PLUGIN_ID: "orca-organization-next",
}));

let root: Root | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  contextHost.info.permissions = ["workspace.read", "workspace.write"];
  contextHost.info.features = { commitTopology: true, stashApplyBySha: true };
  contextHost.client.isConnected = true;
  contextHost.client.listCheckoutCommits.mockReset().mockResolvedValue({
    baseRef: "main",
    commits: [
      {
        sha: "b".repeat(40),
        shortSha: "bbbbbbb",
        subject: "actual commit",
        parentShas: [],
        isOnBase: true,
        isOnRemote: false,
      },
    ],
  });
  contextHost.client.stashList.mockReset().mockResolvedValue({
    entries: [{ sha: "a".repeat(40), index: 2, message: "selected stash" }],
    error: null,
  });
  contextHost.client.stashApply.mockReset().mockResolvedValue({ success: true, error: null });
  contextHost.client.listProviderSubagents.mockReset().mockResolvedValue({
    parentAgentId: "parent",
    subagents: [
      {
        id: "child",
        parentAgentId: "parent",
        provider: "codex",
        title: "provider child",
        status: "running",
      },
    ],
    error: null,
  });
  contextHost.client.listDirectory.mockReset().mockResolvedValue({
    path: "",
    entries: [{ path: "src/main.ts", name: "main.ts", kind: "file" }],
  });
  contextHost.state.sessions.server.agents.get("parent")!.runtimeInstanceId = "native-A";
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe("CommitsSection", () => {
  it("keeps its bottom edge above the device safe area", () => {
    act(() => {
      root?.render(
        <CommitsSection serverId="server" cwd="/repo" onCommitPress={vi.fn()} collapsed />,
      );
    });

    const header = document.querySelector('[data-testid="commits-section-header"]');
    expect(header?.parentElement?.getAttribute("style")).toContain("padding-bottom: 34px");
  });
});

describe("Context checkout", () => {
  const open = vi.fn();
  async function renderContext() {
    await act(async () => {
      root?.render(
        <ContextCheckout serverId="server" workspaceId="workspace" active onOpenTarget={open} />,
      );
    });
  }
  async function click(text: string) {
    const button = [...document.querySelectorAll('[role="button"],button')].find((node) =>
      node.textContent?.includes(text),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }
  it("routes actual commit identity and applies a retained stash by SHA after confirmation", async () => {
    await renderContext();
    await click("actual commit");
    expect(open).toHaveBeenCalledWith({ kind: "commit_diff", sha: "b".repeat(40) });
    await click("Apply retained stash");
    expect(contextHost.client.stashApply).not.toHaveBeenCalled();
    await click("Confirm apply");
    expect(contextHost.client.stashApply).toHaveBeenCalledExactlyOnceWith("/repo", "a".repeat(40));
    expect(document.body.textContent).toContain("Stash applied; the stash was retained.");
  });
  it("gates unsupported capabilities before issuing either checkout read", async () => {
    contextHost.info.features = { commitTopology: false, stashApplyBySha: false };
    await renderContext();
    expect(contextHost.client.listCheckoutCommits).not.toHaveBeenCalled();
    expect(contextHost.client.stashList).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Update the host");
  });
  it("rejects a read admitted before permission revoke and regain", async () => {
    let resolve!: (value: unknown) => void;
    contextHost.client.listCheckoutCommits.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderContext();
    await act(async () => {
      contextHost.info.permissions = [];
      for (const listener of contextHost.listeners) listener();
      contextHost.info.permissions = ["workspace.read", "workspace.write"];
      for (const listener of contextHost.listeners) listener();
      resolve({
        baseRef: null,
        commits: [{ sha: "c", shortSha: "c", subject: "stale private row", parentShas: [] }],
      });
    });
    expect(document.body.textContent).not.toContain("stale private row");
  });
});

describe("Context contained resources", () => {
  async function clickResource(text: string) {
    const button = [...document.querySelectorAll('[role="button"],button')].find((node) =>
      node.textContent?.includes(text),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }
  it("uses the authoritative contained index only after explicit browsing and opens its returned path", async () => {
    contextHost.info.features.containedFileIndex = true;
    const open = vi.fn();
    await act(async () => {
      root?.render(
        <ContextContainedFiles
          serverId="server"
          workspaceId="workspace"
          active
          onOpenTarget={open}
        />,
      );
    });
    expect(contextHost.client.listDirectory).not.toHaveBeenCalled();
    await clickResource("Browse contained");
    expect(contextHost.client.listDirectory).toHaveBeenCalledWith("/repo", "");
    await clickResource("File: main.ts");
    expect(open).toHaveBeenCalledWith({ kind: "file", path: "src/main.ts" });
  });
  it("shows only the selected parent's provider children without borrowing account identity", async () => {
    contextHost.info.features.providerSubagents = true;
    contextHost.info.features.projectedSubagentTimeline = true;
    contextHost.client.listProviderSubagents.mockResolvedValue({
      parentAgentId: "parent",
      subagents: [
        {
          id: "child",
          parentAgentId: "parent",
          provider: "codex",
          title: "provider child",
          status: "running",
        },
        {
          id: "foreign",
          parentAgentId: "other",
          provider: "claude",
          title: "foreign child",
          status: "running",
        },
      ],
    });
    const open = vi.fn();
    await act(async () => {
      root?.render(
        <ContextProviderChildren
          serverId="server"
          workspaceId="workspace"
          agentId="parent"
          active
          onOpenTarget={open}
        />,
      );
    });
    expect(document.body.textContent).toContain("accounts unavailable");
    expect(document.body.textContent).not.toContain("foreign child");
    await clickResource("Open provider-owned");
    expect(open).toHaveBeenCalledWith({
      kind: "provider_subagent",
      parentAgentId: "parent",
      subagentId: "child",
    });
  });
  it("withholds provider-child reads when a legacy parent has no native instance identity", async () => {
    contextHost.info.features.providerSubagents = true;
    contextHost.state.sessions.server.agents.get("parent")!.runtimeInstanceId = "";
    await act(async () => {
      root?.render(
        <ContextProviderChildren
          serverId="server"
          workspaceId="workspace"
          agentId="parent"
          active
          onOpenTarget={vi.fn()}
        />,
      );
    });
    expect(contextHost.client.listProviderSubagents).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("runtime identity unavailable");
  });
  it("does not publish a provider descriptor read from a replaced native parent instance", async () => {
    contextHost.info.features.providerSubagents = true;
    let resolve!: (value: unknown) => void;
    contextHost.client.listProviderSubagents.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => {
      root?.render(
        <ContextProviderChildren
          serverId="server"
          workspaceId="workspace"
          agentId="parent"
          active
          onOpenTarget={vi.fn()}
        />,
      );
    });
    await act(async () => {
      contextHost.state.sessions.server.agents.get("parent")!.runtimeInstanceId = "native-B";
      for (const listener of contextHost.listeners) listener();
      resolve({
        parentAgentId: "parent",
        subagents: [
          {
            id: "old",
            parentAgentId: "parent",
            provider: "claude",
            title: "old private child",
            status: "running",
          },
        ],
      });
    });
    expect(document.body.textContent).not.toContain("old private child");
  });
});

describe("Context protected reports", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const scope = { projectId: id, taskId: "22222222-2222-4222-8222-222222222222" };
  const identity = { agentId: id, instanceId: id, sessionId: "native-session", boot: id };
  const status = {
    version: 1,
    identity,
    registration: { epoch: id, parent: null, scopes: [scope] },
    queueAvailable: true,
    reportLinked: true,
    settingsInitialized: true,
    supportedProviders: ["codex"],
  };
  beforeEach(() => {
    reportHost.lifetime = new AbortController();
    reportHost.invoke.mockReset().mockResolvedValue(status);
    contextHost.info.features.nativeOwnerReportInbox = true;
    contextHost.state.sessions.server.agents.set(id, {
      ...contextHost.state.sessions.server.agents.get("parent")!,
      id,
      runtimeInstanceId: id,
    });
    contextHost.client.readNativeOwnerReportInbox.mockReset().mockResolvedValue({
      scope,
      events: [
        {
          eventId: id,
          kind: "blocked",
          scope,
          at: 1,
          metadataCommitted: true,
          wakeState: "uncertain",
          providerAccepted: true,
          consumed: false,
        },
      ],
      overflow: [],
      visibleMetadataCount: 1,
      bounded: true,
    });
  });
  async function renderReports(active = true) {
    await act(async () =>
      root?.render(
        <ContextReports
          serverId="server"
          workspaceId="workspace"
          agent={contextHost.state.sessions.server.agents.get(id)}
          active={active}
        />,
      ),
    );
  }
  async function selectScope() {
    const button = [...document.querySelectorAll('[role="button"],button')].find((node) =>
      node.textContent?.includes("Read registered scope 1"),
    );
    expect(button).toBeDefined();
    await act(async () => button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  }
  it("reads only explicitly selected protected scope and separates uncertain wake from provider acceptance", async () => {
    await renderReports();
    expect(reportHost.invoke).toHaveBeenCalledWith("organization.intercom.status", { agentId: id });
    expect(contextHost.client.readNativeOwnerReportInbox).not.toHaveBeenCalled();
    await selectScope();
    expect(contextHost.client.readNativeOwnerReportInbox).toHaveBeenCalledWith({
      identity,
      expectedEpoch: id,
      scope,
    });
    expect(document.body.textContent).toContain("Wake: uncertain");
    expect(document.body.textContent).toContain("provider accepted: yes · consumed: no");
    expect(document.body.textContent).not.toContain("Wake: delivered");
    expect(document.body.textContent).not.toContain(id);
  });
  it("withholds read when protected registration is missing", async () => {
    reportHost.invoke.mockResolvedValue({ ...status, registration: null });
    await renderReports();
    expect(contextHost.client.readNativeOwnerReportInbox).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Registered report scope unavailable");
  });
  it("renders owner refusal unavailable without a status or MCP fallback", async () => {
    contextHost.client.readNativeOwnerReportInbox.mockRejectedValue(
      new Error("private refusal detail"),
    );
    await renderReports();
    await selectScope();
    expect(document.body.textContent).toContain("Owner report metadata unavailable");
    expect(document.body.textContent).not.toContain("private refusal detail");
    expect(reportHost.invoke).toHaveBeenCalledTimes(1);
  });
  it("purges committed rows when plugin lifetime is revoked", async () => {
    await renderReports();
    await selectScope();
    await act(async () => reportHost.lifetime.abort());
    expect(document.body.textContent).not.toContain("Visible metadata:");
    expect(document.body.textContent).toContain("Owner report metadata unavailable");
  });
  it("purges cached rows across a revoke-regain transition before fresh selection", async () => {
    await renderReports();
    await selectScope();
    await act(async () => {
      contextHost.info.permissions = [];
      for (const listener of contextHost.listeners) listener();
      contextHost.info.permissions = ["workspace.read", "workspace.write"];
      for (const listener of contextHost.listeners) listener();
    });
    expect(document.body.textContent).not.toContain("Visible metadata:");
    expect(contextHost.client.readNativeOwnerReportInbox).toHaveBeenCalledTimes(1);
  });
  it("refuses late result across native replacement and retained inactivity", async () => {
    let resolve!: (value: unknown) => void;
    contextHost.client.readNativeOwnerReportInbox.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderReports();
    await selectScope();
    await act(async () => {
      contextHost.state.sessions.server.agents.get(id)!.runtimeInstanceId = "replacement";
      for (const listener of contextHost.listeners) listener();
      resolve({ scope, events: [], overflow: [], visibleMetadataCount: 5, bounded: true });
    });
    expect(document.body.textContent).not.toContain("Visible metadata: 5");
    await renderReports(false);
    expect(document.body.textContent).not.toContain("Visible metadata:");
    expect(contextHost.listeners.size).toBe(0);
  });
});

describe("Context committed outputs", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const scope = { projectId: id, taskId: "44444444-4444-4444-8444-444444444444" };
  const identity = { agentId: id, instanceId: id, sessionId: "native-output-session", boot: id };
  const status = {
    version: 1,
    identity,
    registration: { epoch: id, parent: null, scopes: [scope] },
    queueAvailable: false,
    reportLinked: true,
    settingsInitialized: true,
    supportedProviders: ["codex"],
  };
  function output(expiresAt = Date.now() + 60000) {
    const at = Date.now() - 1000;
    const row = {
      id,
      operationDigest: "a".repeat(64),
      scope,
      at,
      expiresAt,
      metadataCommitted: true,
    };
    return {
      scope,
      bounded: true,
      contentReadAvailable: false,
      entries: [
        {
          ...row,
          fact: {
            kind: "produced_artifact",
            basis: "host_materialized_native_generation",
            sha256: "b".repeat(64),
            size: 42,
            contentAvailable: false,
          },
        },
        {
          ...row,
          id: "55555555-5555-4555-8555-555555555555",
          fact: { kind: "file_touch", basis: "native_provider_ack", fileCount: 2 },
        },
        {
          ...row,
          id: "66666666-6666-4666-8666-666666666666",
          fact: { kind: "command_result", basis: "native_provider_ack", exitCode: null },
        },
      ],
    };
  }
  beforeEach(() => {
    reportHost.lifetime = new AbortController();
    reportHost.invoke.mockReset().mockResolvedValue(status);
    contextHost.info.features.nativeEvidenceIndex = true;
    contextHost.state.sessions.server.agents.set(id, {
      ...contextHost.state.sessions.server.agents.get("parent")!,
      id,
      runtimeInstanceId: id,
    });
    contextHost.client.readNativeEvidenceIndex.mockReset().mockResolvedValue(output());
  });
  async function renderOutputs(active = true) {
    await act(async () =>
      root?.render(
        <ContextOutputs
          serverId="server"
          workspaceId="workspace"
          agent={contextHost.state.sessions.server.agents.get(id)}
          active={active}
        />,
      ),
    );
  }
  async function selectScope() {
    const button = [...document.querySelectorAll('[role="button"],button')].find((node) =>
      node.textContent?.includes("Read output scope 1"),
    );
    expect(button).toBeDefined();
    await act(async () => button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  }
  it("reads selected registered scope once and presents three committed kinds without content or raw identities", async () => {
    await renderOutputs();
    expect(contextHost.client.readNativeEvidenceIndex).not.toHaveBeenCalled();
    await selectScope();
    expect(contextHost.client.readNativeEvidenceIndex).toHaveBeenCalledWith({
      identity,
      expectedEpoch: id,
      scope,
    });
    expect(contextHost.client.readNativeEvidenceIndex).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "This native-generation index does not expose managed declared outputs or content reads",
    );
    expect(document.body.textContent).toContain(
      "Native file touches and command acknowledgements do not establish artifact production",
    );
    expect(document.body.textContent).not.toContain(id);
    expect(document.body.textContent).not.toContain("a".repeat(64));
    expect(document.body.textContent).not.toContain("b".repeat(64));
    expect(document.body.textContent).not.toContain("View output content");
  });
  it("withholds reads when registration is absent", async () => {
    reportHost.invoke.mockResolvedValue({ ...status, registration: null });
    await renderOutputs();
    expect(contextHost.client.readNativeEvidenceIndex).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Registered output scope unavailable");
  });
  it("shows sanitized owner refusal without status or browse fallback", async () => {
    contextHost.client.readNativeEvidenceIndex.mockRejectedValue(
      new Error("private refusal /secret"),
    );
    await renderOutputs();
    await selectScope();
    expect(document.body.textContent).toContain("Owner output metadata unavailable");
    expect(document.body.textContent).not.toContain("/secret");
    expect(reportHost.invoke).toHaveBeenCalledTimes(1);
    expect(contextHost.client.listDirectory).not.toHaveBeenCalled();
  });
  it("purges displayed metadata on plugin revocation", async () => {
    await renderOutputs();
    await selectScope();
    await act(async () => reportHost.lifetime.abort());
    expect(document.body.textContent).toContain("Owner output metadata unavailable");
    expect(document.body.textContent).not.toContain("This native-generation index");
  });
  it("purges revoke-regain metadata and requires fresh scope selection", async () => {
    await renderOutputs();
    await selectScope();
    await act(async () => {
      contextHost.info.permissions = [];
      for (const listener of contextHost.listeners) listener();
      contextHost.info.permissions = ["workspace.read", "workspace.write"];
      for (const listener of contextHost.listeners) listener();
    });
    expect(document.body.textContent).not.toContain("This native-generation index");
    expect(contextHost.client.readNativeEvidenceIndex).toHaveBeenCalledTimes(1);
  });
  it("discards held index result from a replaced native instance", async () => {
    let resolve!: (value: unknown) => void;
    contextHost.client.readNativeEvidenceIndex.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderOutputs();
    await selectScope();
    await act(async () => {
      contextHost.state.sessions.server.agents.get(id)!.runtimeInstanceId = "replacement";
      for (const listener of contextHost.listeners) listener();
      resolve(output());
    });
    expect(document.body.textContent).not.toContain("This native-generation index");
  });
  it("expires displayed metadata without another read or granting content", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      contextHost.client.readNativeEvidenceIndex.mockResolvedValue(output(Date.now() + 100));
      await renderOutputs();
      await selectScope();
      expect(document.body.textContent).toContain("This native-generation index");
      await act(async () => {
        vi.advanceTimersByTime(101);
      });
      expect(document.body.textContent).toContain("Owner output metadata unavailable");
      expect(document.body.textContent).not.toContain("This native-generation index");
      expect(contextHost.client.readNativeEvidenceIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("removes read subscriptions and rows while retained inactive", async () => {
    await renderOutputs();
    await selectScope();
    await renderOutputs(false);
    expect(contextHost.listeners.size).toBe(0);
    expect(document.body.textContent).not.toContain("This native-generation index");
  });
});

describe("Context managed outputs", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const scope = { projectId: id, taskId: "44444444-4444-4444-8444-444444444444" };
  const identity = { agentId: id, instanceId: id, sessionId: "native-output-session", boot: id };
  const status = {
    version: 1,
    identity,
    registration: { epoch: id, parent: null, scopes: [scope] },
    queueAvailable: false,
    reportLinked: true,
    settingsInitialized: true,
    supportedProviders: ["codex"],
  };
  function output(expiresAt = Date.now() + 60000) {
    const at = Date.now() - 1000;
    const row = {
      id,
      operationDigest: "a".repeat(64),
      scope,
      at,
      expiresAt,
      metadataCommitted: true,
    };
    return {
      scope,
      bounded: true,
      contentReadAvailable: false,
      entries: [
        {
          ...row,
          fact: {
            kind: "managed_artifact",
            basis: "host_materialized_declared_output",
            sha256: "b".repeat(64),
            size: 42,
            contentAvailable: false,
          },
        },
      ],
    };
  }

  beforeEach(() => {
    reportHost.lifetime = new AbortController();
    reportHost.invoke.mockReset().mockResolvedValue(status);
    contextHost.info.features.managedArtifactIndex = true;
    contextHost.state.sessions.server.agents.set(id, {
      ...contextHost.state.sessions.server.agents.get("parent")!,
      id,
      runtimeInstanceId: id,
    });
    contextHost.client.readNativeEvidenceIndex.mockReset();
    contextHost.client.readManagedArtifactIndex.mockReset().mockResolvedValue(output());
  });
  async function renderOutputs(active = true) {
    await act(async () =>
      root?.render(
        <ContextManagedOutputs
          serverId="server"
          workspaceId="workspace"
          agent={contextHost.state.sessions.server.agents.get(id)}
          active={active}
        />,
      ),
    );
  }
  async function selectScope() {
    const button = [...document.querySelectorAll('[role="button"],button')].find((node) =>
      node.textContent?.includes("Read managed scope 1"),
    );
    expect(button).toBeDefined();
    await act(async () => button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  }
  it("reads explicit registered managed scope once without generation, content, enablement or raw identities", async () => {
    await renderOutputs();
    expect(contextHost.client.readManagedArtifactIndex).not.toHaveBeenCalled();
    await selectScope();
    expect(contextHost.client.readManagedArtifactIndex).toHaveBeenCalledWith({
      identity,
      expectedEpoch: id,
      scope,
    });
    expect(contextHost.client.readManagedArtifactIndex).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Content reading and producing-tool enablement are unavailable in this section",
    );
    expect(document.body.textContent).toContain(
      "Managed artifacts are host-materialized declared outputs",
    );
    expect(document.body.textContent).not.toContain(id);
    expect(document.body.textContent).not.toContain("a".repeat(64));
    expect(document.body.textContent).not.toContain("b".repeat(64));
    expect(document.body.textContent).not.toContain("View output content");
    expect(document.body.textContent).toContain("Managed artifact");
    expect(document.body.textContent).toContain(
      "Host-materialized declared output · metadata committed",
    );
    expect(document.body.textContent).toContain("Artifact content unavailable");
    expect(contextHost.client.readNativeEvidenceIndex).not.toHaveBeenCalled();
  });
  it("does not fall back to the legacy index when the managed capability is absent", async () => {
    contextHost.info.features.managedArtifactIndex = false;
    await renderOutputs();
    expect(contextHost.client.readManagedArtifactIndex).not.toHaveBeenCalled();
    expect(contextHost.client.readNativeEvidenceIndex).not.toHaveBeenCalled();
    expect(reportHost.invoke).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Update the host");
  });
  it("withholds reads when registration is absent", async () => {
    reportHost.invoke.mockResolvedValue({ ...status, registration: null });
    await renderOutputs();
    expect(contextHost.client.readManagedArtifactIndex).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Registered managed scope unavailable");
  });
  it("shows sanitized owner refusal without status or browse fallback", async () => {
    contextHost.client.readManagedArtifactIndex.mockRejectedValue(
      new Error("private refusal /secret"),
    );
    await renderOutputs();
    await selectScope();
    expect(document.body.textContent).toContain("Managed artifact metadata unavailable");
    expect(document.body.textContent).not.toContain("/secret");
    expect(reportHost.invoke).toHaveBeenCalledTimes(1);
    expect(contextHost.client.listDirectory).not.toHaveBeenCalled();
  });
  it("purges displayed metadata on plugin revocation", async () => {
    await renderOutputs();
    await selectScope();
    await act(async () => reportHost.lifetime.abort());
    expect(document.body.textContent).toContain("Managed artifact metadata unavailable");
    expect(document.body.textContent).not.toContain(
      "Content reading and producing-tool enablement",
    );
  });
  it("purges revoke-regain metadata and requires fresh scope selection", async () => {
    await renderOutputs();
    await selectScope();
    await act(async () => {
      contextHost.info.permissions = [];
      for (const listener of contextHost.listeners) listener();
      contextHost.info.permissions = ["workspace.read", "workspace.write"];
      for (const listener of contextHost.listeners) listener();
    });
    expect(document.body.textContent).not.toContain(
      "Content reading and producing-tool enablement",
    );
    expect(contextHost.client.readManagedArtifactIndex).toHaveBeenCalledTimes(1);
  });
  it("discards held index result from a replaced native instance", async () => {
    let resolve!: (value: unknown) => void;
    contextHost.client.readManagedArtifactIndex.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderOutputs();
    await selectScope();
    await act(async () => {
      contextHost.state.sessions.server.agents.get(id)!.runtimeInstanceId = "replacement";
      for (const listener of contextHost.listeners) listener();
      resolve(output());
    });
    expect(document.body.textContent).not.toContain(
      "Content reading and producing-tool enablement",
    );
  });
  it("expires displayed metadata without another read or granting content", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      contextHost.client.readManagedArtifactIndex.mockResolvedValue(output(Date.now() + 100));
      await renderOutputs();
      await selectScope();
      expect(document.body.textContent).toContain("Content reading and producing-tool enablement");
      await act(async () => {
        vi.advanceTimersByTime(101);
      });
      expect(document.body.textContent).toContain("Managed artifact metadata unavailable");
      expect(document.body.textContent).not.toContain(
        "Content reading and producing-tool enablement",
      );
      expect(contextHost.client.readManagedArtifactIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("removes read subscriptions and rows while retained inactive", async () => {
    await renderOutputs();
    await selectScope();
    await renderOutputs(false);
    expect(contextHost.listeners.size).toBe(0);
    expect(document.body.textContent).not.toContain(
      "Content reading and producing-tool enablement",
    );
  });
});

describe("Context managed content", () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const scope = { projectId: id, taskId: "66666666-6666-4666-8666-666666666666" };
  const identity = { agentId: id, instanceId: id, sessionId: "managed-content", boot: id };
  const status = {
    version: 1,
    identity,
    registration: { epoch: id, parent: null, scopes: [scope] },
    queueAvailable: false,
    reportLinked: true,
    settingsInitialized: true,
    supportedProviders: ["codex"],
  };
  function grant(expiresAt = Date.now() + 60000) {
    return {
      identity,
      expectedEpoch: id,
      scope,
      grantId: id,
      revision: id,
      artifactIds: [id],
      byteBudget: 64,
      expiresAt,
    };
  }
  const text = '<script>alert("inert")</script><img src="https://example.invalid/private">';
  beforeEach(() => {
    reportHost.lifetime = new AbortController();
    reportHost.invoke
      .mockReset()
      .mockImplementation(async (rpc: string) =>
        rpc === "organization.intercom.status" ? status : { grants: [grant()] },
      );
    contextHost.info.features.managedArtifactContent = true;
    contextHost.info.features.managedArtifactIndex = true;
    contextHost.client.readManagedArtifactIndex.mockReset().mockResolvedValue({
      scope,
      bounded: true,
      contentReadAvailable: false,
      entries: [
        {
          id,
          operationDigest: "a".repeat(64),
          scope,
          at: Date.now() - 1000,
          expiresAt: Date.now() + 60000,
          metadataCommitted: true,
          fact: {
            kind: "managed_artifact",
            basis: "host_materialized_declared_output",
            sha256: "b".repeat(64),
            size: 42,
            contentAvailable: false,
          },
        },
      ],
    });
    contextHost.state.sessions.server.agents.set(id, {
      ...contextHost.state.sessions.server.agents.get("parent")!,
      id,
      runtimeInstanceId: id,
    });
    contextHost.client.readManagedArtifactContent.mockReset().mockImplementation(async (input) => {
      const bytes = Buffer.from(text).subarray(0, input.length);
      return {
        ...input,
        length: bytes.length,
        expiresAt: Date.now() + 30000,
        encoding: "base64",
        contentType: "text/plain",
        data: bytes.toString("base64"),
        eof: false,
      };
    });
  });
  async function renderContent(active = true) {
    await act(async () =>
      root?.render(
        <ContextManagedContent
          serverId="server"
          workspaceId="workspace"
          agent={contextHost.state.sessions.server.agents.get(id)}
          active={active}
        />,
      ),
    );
  }
  async function click(label: string) {
    const button = [...document.querySelectorAll('[role="button"],button')].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  }
  async function selectArtifact() {
    await click("List content grants for scope 1");
    await click("Select content grant 1");
    await click("Select managed text artifact 1");
  }
  it("requires explicit scope/grant/artifact/read and renders literal text without executable or external elements", async () => {
    await renderContent();
    expect(reportHost.invoke).toHaveBeenCalledTimes(1);
    await selectArtifact();
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
    await click("Read first text range");
    expect(contextHost.client.readManagedArtifactContent).toHaveBeenCalledTimes(1);
    const [input, options] = contextHost.client.readManagedArtifactContent.mock.calls[0]!;
    expect(input).toMatchObject({
      identity,
      expectedEpoch: id,
      scope,
      grantId: id,
      grantRevision: id,
      artifactId: id,
      offset: 0,
      length: 64,
    });
    expect(input.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(options.signal.aborted).toBe(false);
    expect(reportHost.invoke.mock.calls.map((call) => call[0])).toEqual([
      "organization.intercom.status",
      "organization.intercom.artifacts.content.list",
      "organization.intercom.artifacts.content.list",
    ]);
    expect(document.body.textContent).toContain('<script>alert("inert")</script>');
    expect(document.querySelectorAll("script,img,a,iframe,svg").length).toBe(0);
    expect(document.body.textContent).not.toContain(id);
  });
  it("makes no call when content capability is absent", async () => {
    contextHost.info.features.managedArtifactContent = false;
    await renderContent();
    expect(reportHost.invoke).not.toHaveBeenCalled();
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Update the host");
  });
  it("does not derive a scope from an unregistered session", async () => {
    reportHost.invoke.mockResolvedValue({ ...status, registration: null });
    await renderContent();
    expect(document.body.textContent).toContain("Registered content scope unavailable");
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
  });
  it("sanitizes read refusal without retry, refund or alternate read", async () => {
    contextHost.client.readManagedArtifactContent.mockRejectedValue(
      new Error("private /secret credential"),
    );
    await renderContent();
    await selectArtifact();
    await click("Read first text range");
    expect(document.body.textContent).toContain("Managed text preview unavailable");
    expect(document.body.textContent).not.toContain("/secret");
    expect(contextHost.client.readManagedArtifactContent).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("may remain charged");
    expect(contextHost.client.listDirectory).not.toHaveBeenCalled();
  });
  it("refuses a held grant selection across synchronous permission revoke-regain before content effect", async () => {
    await renderContent();
    await selectArtifact();
    let resolve!: (value: unknown) => void;
    reportHost.invoke.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await click("Read first text range");
    await act(async () => {
      contextHost.info.permissions = [];
      for (const listener of contextHost.listeners) listener();
      contextHost.info.permissions = ["workspace.read", "workspace.write"];
      for (const listener of contextHost.listeners) listener();
      resolve({ grants: [grant()] });
    });
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Select content grant 1");
  });
  it("discards held content on native replacement and aborts the original signal", async () => {
    let resolve!: (value: unknown) => void;
    contextHost.client.readManagedArtifactContent.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderContent();
    await selectArtifact();
    await click("Read first text range");
    const [input, options] = contextHost.client.readManagedArtifactContent.mock.calls[0]!;
    await act(async () => {
      contextHost.state.sessions.server.agents.get(id)!.runtimeInstanceId = "replacement";
      for (const listener of contextHost.listeners) listener();
      resolve({
        ...input,
        length: 6,
        expiresAt: Date.now() + 10000,
        encoding: "base64",
        contentType: "text/plain",
        data: Buffer.from("SECRET").toString("base64"),
        eof: true,
      });
    });
    expect(options.signal.aborted).toBe(true);
    expect(document.body.textContent).not.toContain("SECRET");
  });
  it("purges displayed bytes on plugin revocation", async () => {
    await renderContent();
    await selectArtifact();
    await click("Read first text range");
    expect(document.body.textContent).toContain('<script>alert("inert")</script>');
    await act(async () => reportHost.lifetime.abort());
    expect(document.body.textContent).not.toContain('<script>alert("inert")</script>');
    expect(document.body.textContent).toContain("Managed text preview unavailable");
  });
  it("purges bytes at TTL without another read or grant-list refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      contextHost.client.readManagedArtifactContent.mockImplementation(async (input) => ({
        ...input,
        length: 6,
        expiresAt: Date.now() + 100,
        encoding: "base64",
        contentType: "text/plain",
        data: Buffer.from("SECRET").toString("base64"),
        eof: true,
      }));
      await renderContent();
      await selectArtifact();
      await click("Read first text range");
      expect(document.body.textContent).toContain("SECRET");
      await act(async () => vi.advanceTimersByTime(101));
      expect(document.body.textContent).not.toContain("SECRET");
      expect(contextHost.client.readManagedArtifactContent).toHaveBeenCalledTimes(1);
      expect(reportHost.invoke).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuses changed grant revision after exact explicit selection", async () => {
    await renderContent();
    await selectArtifact();
    reportHost.invoke.mockResolvedValue({ grants: [{ ...grant(), revision: scope.taskId }] });
    await click("Read first text range");
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Managed text preview unavailable");
  });
  it("requires a fresh UUID for a separate deliberate read without replaying the previous attempt", async () => {
    await renderContent();
    await selectArtifact();
    await click("Read first text range");
    await click("Read first text range");
    const calls = contextHost.client.readManagedArtifactContent.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].requestId).not.toBe(calls[1]![0].requestId);
    expect(calls[0]![0]).toMatchObject({ artifactId: id, grantId: id });
  });
  it("drops preview and visible subscriptions when retained inactive", async () => {
    await renderContent();
    await selectArtifact();
    await click("Read first text range");
    await renderContent(false);
    expect(document.body.textContent).not.toContain('<script>alert("inert")</script>');
    expect(contextHost.listeners.size).toBe(0);
    expect(contextHost.connectionListeners.size).toBe(0);
    expect(contextHost.client.readManagedArtifactContent).toHaveBeenCalledTimes(1);
  });
  it("refuses noncanonical byte-length content without rendering it", async () => {
    contextHost.client.readManagedArtifactContent.mockImplementation(async (input) => ({
      ...input,
      length: 2,
      expiresAt: Date.now() + 10000,
      encoding: "base64",
      contentType: "text/plain",
      data: Buffer.from("SECRET").toString("base64"),
      eof: true,
    }));
    await renderContent();
    await selectArtifact();
    await click("Read first text range");
    expect(document.body.textContent).not.toContain("SECRET");
    expect(document.body.textContent).toContain("Managed text preview unavailable");
  });
  it("owner actions mount without effects and tool enable is deliberate and separate from content", async () => {
    await renderContent();
    await click("List content grants for scope 1");
    expect(reportHost.invoke.mock.calls.map((call) => call[0])).toEqual([
      "organization.intercom.status",
      "organization.intercom.artifacts.content.list",
    ]);
    expect(contextHost.client.readManagedArtifactIndex).toHaveBeenCalledExactlyOnceWith({
      identity,
      expectedEpoch: id,
      scope,
    });
    reportHost.invoke.mockImplementation(async (rpc, input) => ({
      messageId: input.messageId,
      enabled: true,
      expiresAt: input.expiresAt,
    }));
    await click("Enable declared outputs for one hour");
    expect(reportHost.invoke.mock.calls.at(-1)?.[0]).toBe(
      "organization.intercom.artifacts.tool.set",
    );
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
  });
  it("issues only the explicitly index-enumerated artifact and refreshes protected grants without auto content read", async () => {
    await renderContent();
    await click("List content grants for scope 1");
    await click("Select committed artifact for owner grant 1");
    reportHost.invoke.mockImplementation(async (rpc, input) =>
      rpc.endsWith("content.set")
        ? {
            grants: [
              {
                ...grant(input.expiresAt),
                grantId: input.grantId,
                artifactIds: input.artifactIds,
                byteBudget: input.byteBudget,
              },
            ],
          }
        : { grants: [grant()] },
    );
    await click("Grant selected text artifact · 8 KiB");
    expect(reportHost.invoke.mock.calls.at(-2)).toEqual([
      "organization.intercom.artifacts.content.set",
      expect.objectContaining({
        identity,
        expectedEpoch: id,
        scope,
        artifactIds: [id],
        byteBudget: 8192,
        expectedGrantRevision: null,
      }),
    ]);
    expect(reportHost.invoke.mock.calls.at(-1)?.[0]).toBe(
      "organization.intercom.artifacts.content.list",
    );
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("No content was read");
    expect(document.body.textContent).not.toContain(id);
  });
  it("does not promote a grant-list artifact into an index-enumerated owner selection", async () => {
    contextHost.client.readManagedArtifactIndex.mockResolvedValue({
      scope,
      entries: [],
      bounded: true,
      contentReadAvailable: false,
    });
    await renderContent();
    await selectArtifact();
    await click("Grant selected text artifact · 8 KiB");
    expect(reportHost.invoke.mock.calls.map((call) => call[0])).toEqual([
      "organization.intercom.status",
      "organization.intercom.artifacts.content.list",
    ]);
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
  });
  it("discards held committed-index enumeration after permission revoke-regain", async () => {
    let resolve!: (value: unknown) => void;
    contextHost.client.readManagedArtifactIndex.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderContent();
    await click("List content grants for scope 1");
    await act(async () => {
      contextHost.info.permissions = [];
      for (const listener of contextHost.listeners) listener();
      contextHost.info.permissions = ["workspace.read", "workspace.write"];
      for (const listener of contextHost.listeners) listener();
      resolve({ scope, entries: [], bounded: true, contentReadAvailable: false });
    });
    expect(document.body.textContent).not.toContain("Enable declared outputs for one hour");
    expect(reportHost.invoke.mock.calls.some((call) => call[0].endsWith(".set"))).toBe(false);
  });
  it("suppresses late owner confirmation after the selected committed index expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const at = Date.now() - 1000;
      contextHost.client.readManagedArtifactIndex.mockResolvedValue({
        scope,
        bounded: true,
        contentReadAvailable: false,
        entries: [
          {
            id,
            operationDigest: "a".repeat(64),
            scope,
            at,
            expiresAt: Date.now() + 100,
            metadataCommitted: true,
            fact: {
              kind: "managed_artifact",
              basis: "host_materialized_declared_output",
              sha256: "b".repeat(64),
              size: 42,
              contentAvailable: false,
            },
          },
        ],
      });
      await renderContent();
      await click("List content grants for scope 1");
      await click("Select committed artifact for owner grant 1");
      let resolve!: (value: unknown) => void;
      reportHost.invoke.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await click("Enable declared outputs for one hour");
      const input = reportHost.invoke.mock.calls.at(-1)![1];
      await act(async () => {
        vi.advanceTimersByTime(101);
        resolve({ messageId: input.messageId, enabled: true, expiresAt: input.expiresAt });
      });
      expect(document.body.textContent).not.toContain("Host confirmed declared-output tool");
      expect(document.body.textContent).not.toContain("Enable declared outputs for one hour");
      expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps unconfirmed actions disabled without a fresh UUID repeat or content effect", async () => {
    await renderContent();
    await click("List content grants for scope 1");
    await click("Select committed artifact for owner grant 1");
    reportHost.invoke.mockRejectedValue(new Error("private action /secret"));
    await click("Grant selected text artifact · 8 KiB");
    await click("Grant selected text artifact · 8 KiB");
    await click("Enable declared outputs for one hour");
    expect(reportHost.invoke.mock.calls.filter((call) => call[0].endsWith(".set"))).toHaveLength(1);
    expect(document.body.textContent).toContain("Action outcome unconfirmed");
    expect(document.body.textContent).not.toContain("/secret");
    expect(contextHost.client.readManagedArtifactContent).not.toHaveBeenCalled();
  });
  it("withholds owner artifact choices for a foreign managed index scope", async () => {
    contextHost.client.readManagedArtifactIndex.mockResolvedValue({
      scope: { ...scope, taskId: id },
      entries: [],
      bounded: true,
      contentReadAvailable: false,
    });
    await renderContent();
    await click("List content grants for scope 1");
    expect(document.body.textContent).toContain("Committed managed artifact selection unavailable");
    expect(document.body.textContent).not.toContain("Grant selected text artifact");
    expect(reportHost.invoke.mock.calls.some((call) => call[0].endsWith(".set"))).toBe(false);
  });
});

describe("Radius local scratch workflow", () => {
  const theme = toPluginTheme(darkTheme);
  type RadiusSimulate = NonNullable<React.ComponentProps<typeof RadiusWorkflow>["simulate"]>;
  function button(label: string): HTMLButtonElement {
    const value = document.querySelector(`[aria-label="${label}"]`);
    if (!(value instanceof window.HTMLButtonElement)) throw Error("missing button");
    return value;
  }
  async function click(label: string) {
    await act(async () => {
      button(label).click();
    });
  }
  async function planned(props: Partial<React.ComponentProps<typeof RadiusWorkflow>> = {}) {
    await act(async () => {
      root?.render(<RadiusWorkflow theme={theme} {...props} />);
    });
    await click("Plan infrastructure change");
    await click("Validate local requirements");
  }
  it("shows separate requirements, infra changes and a local simulation without a host effect", async () => {
    await planned();
    expect(document.querySelector('[data-testid="radius-change-plan"]')?.textContent).toContain(
      "add: web",
    );
    expect(document.querySelector('[data-testid="radius-validation"]')?.textContent).toContain(
      "web-port: pass",
    );
    expect(button("Write private scratch simulation").disabled).toBe(true);
    await click("Simulate deployment in this panel");
    expect(
      document.querySelector('[data-testid="radius-simulation-files"]')?.textContent,
    ).toContain('"externalEffects": false');
    expect(document.body.textContent).toContain(
      "Native Radius/Bicep compilation: not run. Real environment deployment: held.",
    );
  });
  it("requires an original owner guard and never retries a refused or uncertain scratch attempt", async () => {
    const simulate = vi.fn().mockRejectedValue(Error("throwaway secret /private/path"));
    await planned({ simulate, checkOriginalLifetime: () => {} });
    await click("Write private scratch simulation");
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Private scratch simulation was refused or its outcome is unknown.",
    );
    expect(document.body.textContent).not.toContain("throwaway secret");
    expect(button("Write private scratch simulation").disabled).toBe(true);
    await click("Write private scratch simulation");
    expect(simulate).toHaveBeenCalledTimes(1);
  });
  it("refuses private scratch before the call when the original owner lifetime has revoked", async () => {
    const simulate = vi.fn<RadiusSimulate>();
    await planned({
      simulate,
      checkOriginalLifetime: () => {
        throw Error("revoked");
      },
    });
    await click("Write private scratch simulation");
    expect(simulate).toHaveBeenCalledTimes(0);
    expect(document.body.textContent).toContain(
      "Private scratch simulation was refused or its outcome is unknown.",
    );
  });
  it("cancels a held private read on original lifetime loss and suppresses its late result", async () => {
    const held: { release?: (output: Awaited<ReturnType<RadiusSimulate>>) => void } = {};
    const simulate = vi.fn<RadiusSimulate>(
      (_input, _signal) =>
        new Promise((resolve) => {
          held.release = resolve;
        }),
    );
    await planned({ simulate, checkOriginalLifetime: () => {} });
    await click("Write private scratch simulation");
    const [input, signal] = simulate.mock.calls[0];
    act(() => {
      root?.render(<div>Host unavailable</div>);
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      held.release?.({
        attemptId: input.attemptId,
        kind: "local-scratch-simulation",
        target: "0.61.x",
        outputs: [],
        nativeCompilation: "not_run",
        environmentDeployment: "held",
        externalEffects: false,
      });
    });
    expect(document.body.textContent).toBe("Host unavailable");
  });
});
