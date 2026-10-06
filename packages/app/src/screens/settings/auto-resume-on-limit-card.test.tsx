// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  connected: true,
  client: { getLastServerInfoMessage: vi.fn() },
  currentClient: null as { getLastServerInfoMessage: ReturnType<typeof vi.fn> } | null,
  policy: "standalone" as "standalone" | "unknown" | "owner-controls-required",
  currentPolicy: "standalone" as "standalone" | "unknown" | "owner-controls-required",
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
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    accessibilityLabel: string;
  }) => {
    f.retainedToggle = onValueChange;
    const handleClick = React.useCallback(() => onValueChange(!value), [onValueChange, value]);
    return (
      <button
        type="button"
        role="switch"
        aria-label={accessibilityLabel}
        aria-checked={value}
        onClick={handleClick}
      >
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
  useHostRuntimeClient: () => f.client,
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({
      client: f.currentClient,
      connectionStatus: f.connected ? "online" : "offline",
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
vi.mock("@/plugins/registry", () => ({
  useHostInputPolicy: () => f.policy,
  pluginRegistry: { getHostInputPolicy: () => f.currentPolicy },
}));
import { AutoResumeOnLimitCard } from "./auto-resume-on-limit-card";
afterEach(cleanup);
beforeEach(() => {
  f.connected = true;
  f.currentClient = f.client;
  f.client.getLastServerInfoMessage.mockImplementation(() => ({ features: f.currentFeatures }));
  f.policy = "standalone";
  f.currentPolicy = "standalone";
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

it("qualifies eligible standalone continuation and preserves owner controls without granting authority", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  render(<AutoResumeOnLimitCard serverId="host" />);
  expect(
    screen.getByText("Auto-resume eligible sessions after usage limits reset").textContent,
  ).toBe("Auto-resume eligible sessions after usage limits reset");
  expect(
    screen.getByText(
      "Eligible standalone sessions may resume after a usage limit resets if their setup is unchanged. Sessions managed by a prime or another owner use that owner’s controls. Turning this on does not grant permission to continue.",
    ).textContent,
  ).toBe(
    "Eligible standalone sessions may resume after a usage limit resets if their setup is unchanged. Sessions managed by a prime or another owner use that owner’s controls. Turning this on does not grant permission to continue.",
  );
  expect(
    screen
      .getByRole("switch", { name: "Auto-resume eligible sessions after usage limits reset" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.queryByText(
      "Sessions that stop mid-task on a usage limit continue on their own once it resets",
    ),
  ).toBeNull();
  expect(f.patch).not.toHaveBeenCalled();
});

it("a supporting host with input observers exposes owner guidance and no global toggle", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  f.policy = "owner-controls-required";
  f.currentPolicy = f.policy;
  render(<AutoResumeOnLimitCard serverId="host" />);
  expect(
    screen.getByText(
      "Resuming sessions on this host requires their prime or owner’s controls. The standalone setting does not enable automatic continuation for these sessions.",
    ).textContent,
  ).toContain("does not enable automatic continuation");
  expect(screen.queryByRole("switch")).toBeNull();
  expect(f.patch).not.toHaveBeenCalled();
});
it("unknown or failed catalog policy cannot advertise an enabled preference", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  f.policy = "unknown";
  f.currentPolicy = f.policy;
  render(<AutoResumeOnLimitCard serverId="host" />);
  expect(screen.getByText(/resume policy has not been confirmed/).textContent).toContain(
    "controls are unavailable",
  );
  expect(screen.queryByRole("switch")).toBeNull();
  expect(f.patch).not.toHaveBeenCalled();
});
it("reconnect stays unavailable until fresh observer-free catalog metadata arrives", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  const view = render(<AutoResumeOnLimitCard serverId="host" />);
  f.connected = false;
  f.policy = "unknown";
  f.currentPolicy = f.policy;
  view.rerender(<AutoResumeOnLimitCard serverId="host" />);
  expect(view.container.textContent).toBe("");
  f.connected = true;
  view.rerender(<AutoResumeOnLimitCard serverId="host" />);
  expect(screen.queryByRole("switch")).toBeNull();
  f.policy = "standalone";
  f.currentPolicy = f.policy;
  view.rerender(<AutoResumeOnLimitCard serverId="host" />);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
});
it("a retained standalone toggle refuses changed current policy or replacement clients", () => {
  f.features = { autoResumeOnLimit: true };
  f.currentFeatures = f.features;
  render(<AutoResumeOnLimitCard serverId="host" />);
  const toggle = f.retainedToggle!;
  f.currentPolicy = "owner-controls-required";
  toggle(false);
  f.currentPolicy = "unknown";
  toggle(false);
  f.currentPolicy = "standalone";
  f.currentClient = { getLastServerInfoMessage: vi.fn(() => ({ features: f.currentFeatures })) };
  toggle(false);
  expect(f.patch).not.toHaveBeenCalled();
});
