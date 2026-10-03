// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const f = vi.hoisted(() => ({
  active: null as { serverId: string; workspaceId: string } | null,
  remembered: null as { serverId: string; workspaceId: string } | null,
  exists: true,
  navigate: vi.fn(),
  push: vi.fn(),
  serial: 0,
}));
vi.mock("expo-router", () => ({ router: { push: f.push } }));
vi.mock("./sidebar-header-row", () => ({
  SidebarHeaderRow: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" onClick={onPress}>
      {accessibilityLabel}
    </button>
  ),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => f.active,
  useLastWorkspaceSelection: () => f.remembered,
  navigateToWorkspace: f.navigate,
}));
vi.mock("@/stores/session-store-hooks", () => ({ useWorkspace: () => (f.exists ? {} : null) }));
vi.mock("@/stores/draft-keys", () => ({ generateDraftId: () => `draft-${++f.serial}` }));
import { SidebarNewChatHereRow as SidebarNewChatRow } from "./sidebar-new-chat-row";
afterEach(cleanup);
beforeEach(() => {
  f.active = null;
  f.remembered = { serverId: "book", workspaceId: "original" };
  f.exists = true;
  f.navigate.mockClear();
  f.push.mockClear();
});
it("opens distinct chats in the remembered Book workspace from Fulcra home", () => {
  render(<SidebarNewChatRow />);
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(screen.getByRole("button"));
  expect(f.navigate.mock.calls.map(([input]) => ({ ...input, target: input.target.kind }))).toEqual(
    [
      { serverId: "book", workspaceId: "original", target: "draft" },
      { serverId: "book", workspaceId: "original", target: "draft" },
    ],
  );
  expect(f.navigate.mock.calls[0][0].target.draftId).not.toBe(
    f.navigate.mock.calls[1][0].target.draftId,
  );
  expect(f.push).not.toHaveBeenCalled();
});
it("prefers the visible workspace and closes the compact menu", () => {
  f.active = { serverId: "mini", workspaceId: "visible" };
  const close = vi.fn();
  render(<SidebarNewChatRow onBeforeNavigate={close} />);
  fireEvent.click(screen.getByRole("button"));
  expect(f.navigate.mock.calls[0][0]).toMatchObject(f.active);
  expect(close).toHaveBeenCalledOnce();
});
it("offers workspace selection when the saved workspace is missing", () => {
  f.exists = false;
  render(<SidebarNewChatRow />);
  fireEvent.click(screen.getByRole("button"));
  expect(f.push).toHaveBeenCalledWith("/open-project");
  expect(f.navigate).not.toHaveBeenCalled();
});
