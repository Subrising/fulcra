// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  connected: true,
  features: {} as Record<string, unknown>,
  currentFeatures: {} as Record<string, unknown>,
  infoPresent: true,
  config: {} as { autoResumeOnLimit?: boolean } | null,
  patch: vi.fn(),
  retainedToggle: null as ((value: boolean) => void) | null,
}));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Alert: { alert: vi.fn() },
}));
vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => {
    f.retainedToggle = onValueChange;
    const handleClick = React.useCallback(() => onValueChange(!value), [onValueChange, value]);
    return (
      <button type="button" role="switch" aria-checked={value} onClick={handleClick}>
        Auto-resume
      </button>
    );
  },
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: f.config, patchConfig: f.patch }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => f.connected,
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({
      client: { getLastServerInfoMessage: () => ({ features: f.currentFeatures }) },
    }),
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    select: (state: {
      sessions: { host: { serverInfo: { features: Record<string, unknown> } | null } };
    }) => boolean | null,
  ) =>
    select({ sessions: { host: { serverInfo: f.infoPresent ? { features: f.features } : null } } }),
}));
import { AutoResumeOnLimitCard } from "./auto-resume-on-limit-card";
afterEach(cleanup);
beforeEach(() => {
  f.connected = true;
  f.infoPresent = true;
  f.features = {};
  f.currentFeatures = {};
  f.config = {};
  f.patch.mockReset();
  f.patch.mockResolvedValue({});
  f.retainedToggle = null;
});
for (const capability of [undefined, false, "true", 1]) {
  it(`old/unsupported host capability ${String(capability)} exposes update guidance and never sends a strict unsupported patch`, () => {
    f.features = { autoResumeOnLimit: capability };
    f.currentFeatures = f.features;
    f.patch.mockRejectedValue(Error("Unknown config field autoResumeOnLimit"));
    render(<AutoResumeOnLimitCard serverId="host" />);
    expect(screen.getByText(/Update this host/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(f.patch).not.toHaveBeenCalled();
  });
}
it("supporting host shows the enabled default and sends its supported patch", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  render(<AutoResumeOnLimitCard serverId="host" />);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("switch"));
  expect(f.patch).toHaveBeenCalledWith({ autoResumeOnLimit: false });
});
it("a stale toggle cannot patch a replacement old host", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  render(<AutoResumeOnLimitCard serverId="host" />);
  f.currentFeatures = {};
  f.retainedToggle!(false);
  expect(f.patch).not.toHaveBeenCalled();
});
it("explicit disabled config stays disabled on a supporting host", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  f.config = { autoResumeOnLimit: false };
  render(<AutoResumeOnLimitCard serverId="host" />);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
});
it("unanswered capability and disconnected hosts do not advertise enabled behavior", () => {
  f.infoPresent = false;
  const view = render(<AutoResumeOnLimitCard serverId="host" />);
  expect(screen.getByText(/Checking this host/)).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  f.connected = false;
  view.rerender(<AutoResumeOnLimitCard serverId="host" />);
  expect(view.container.textContent).toBe("");
});
