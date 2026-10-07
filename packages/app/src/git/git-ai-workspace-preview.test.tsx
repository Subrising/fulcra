// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GitAiWorkspacePreview } from "./git-ai-workspace-preview";
import type { GitAiDraftPanelProps } from "./git-ai-draft-panel";
const h = vi.hoisted(() => ({
  info: { features: { gitAiDrafts: true }, permissions: ["workspace.read", "workspace.write"] },
  listeners: new Set<() => void>(),
  draft: vi.fn(),
  commit: vi.fn(async () => {}),
  createPr: vi.fn(async () => {}),
  panel: null as GitAiDraftPanelProps | null,
  client: null as unknown,
}));
const client = {
  isConnected: true,
  getLastServerInfoMessage: () => h.info,
  requestGitAiDraft: h.draft,
  subscribe: (fn: () => void) => {
    h.listeners.add(fn);
    return () => h.listeners.delete(fn);
  },
  subscribeConnectionStatus: (fn: () => void) => {
    h.listeners.add(fn);
    return () => h.listeners.delete(fn);
  },
};
h.client = client;
const state = {
  sessions: {
    host: {
      client,
      clientGeneration: 1,
      workspaces: new Map([["workspace", { workspaceDirectory: "/selected" }]]),
    },
  },
};
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => h.client }));
vi.mock("@/runtime/host-features", () => ({ useHostFeatureAvailability: () => true }));
vi.mock("@/stores/session-store", () => {
  const store = Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state,
    subscribe: (fn: () => void) => {
      h.listeners.add(fn);
      return () => h.listeners.delete(fn);
    },
  });
  return { useSessionStore: store };
});
vi.mock("./actions-store", () => ({
  useCheckoutGitActionsStore: { getState: () => ({ commit: h.commit, createPr: h.createPr }) },
}));
vi.mock("./git-ai-draft-panel", () => ({
  GitAiDraftPanel: (props: GitAiDraftPanelProps) => {
    h.panel = props;
    return null;
  },
}));
vi.mock("react-native", () => ({ Text: "span", View: "div" }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({ root: {} }) } }));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    onPress,
    children,
    disabled,
  }: {
    onPress: () => void;
    children: React.ReactNode;
    disabled?: boolean;
  }) => React.createElement("button", { type: "button", onClick: onPress, disabled }, children),
}));
vi.mock("@/components/ui/text-input", () => ({ EditingTextInput: () => null }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children }: { children: React.ReactNode }) => children,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.listeners.clear();
  h.info = { features: { gitAiDrafts: true }, permissions: ["workspace.read", "workspace.write"] };
  h.panel = null;
});
function open() {
  render(<GitAiWorkspacePreview serverId="host" workspaceId="workspace" cwd="/selected" />);
  fireEvent.click(screen.getByText("Write with AI"));
}
test("Use draft fills editable wording, with a separate human click required for the existing write action", async () => {
  open();
  act(() => h.panel?.onUseDraft({ kind: "commit-message", message: "Reviewed subject" }));
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.createPr).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByText("Commit all changes")));
  expect(h.commit).toHaveBeenCalledExactlyOnceWith({
    serverId: "host",
    cwd: "/selected",
    message: "Reviewed subject",
  });
});
test("held draft after revoke and regain cannot publish or use the cancelled original result", async () => {
  let finish!: (value: { kind: "commit-message"; message: string }) => void;
  h.draft.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  open();
  const original = h.panel;
  const pending = original!.requestDraft("commit-message");
  const rejected = expect(pending).rejects.toThrow("changed");
  act(() => {
    h.info = { ...h.info, permissions: [] };
    for (const fn of h.listeners) fn();
    h.info = { ...h.info, permissions: ["workspace.read", "workspace.write"] };
    for (const fn of h.listeners) fn();
  });
  await act(async () => {
    finish({ kind: "commit-message", message: "Late" });
    await rejected;
  });
  expect(() => original!.onUseDraft({ kind: "commit-message", message: "Late" })).toThrow();
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.createPr).not.toHaveBeenCalled();
});
const COMMIT_START = { kind: "commit-message", nonce: 1 } as const;
test("Commit opens straight onto a commit draft, titled plainly, and still needs a confirm", async () => {
  const { rerender } = render(
    <GitAiWorkspacePreview serverId="host" workspaceId="workspace" cwd="/selected" start={null} />,
  );
  expect(h.panel).toBeNull();
  rerender(
    <GitAiWorkspacePreview
      serverId="host"
      workspaceId="workspace"
      cwd="/selected"
      start={COMMIT_START}
    />,
  );
  expect(h.panel?.startWith).toBe("commit-message");
  act(() => h.panel?.onUseDraft({ kind: "commit-message", message: "Add the --days option" }));
  expect(h.commit).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByText("Commit all changes")));
  expect(h.commit).toHaveBeenCalledExactlyOnceWith({
    serverId: "host",
    cwd: "/selected",
    message: "Add the --days option",
  });
});
