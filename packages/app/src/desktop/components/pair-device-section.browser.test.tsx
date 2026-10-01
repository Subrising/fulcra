import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n } from "@/i18n/i18next";
import { darkTheme, lightTheme } from "@/styles/theme";
import * as QRCode from "qrcode";
import { PairDeviceSection } from "./pair-device-section";

const noop = () => {};
const theme = vi.hoisted(() => ({ current: null as unknown }));

// The shared unistyles stub pins one light test theme and ignores `uniProps`. Here styles resolve
// against whichever real theme is current, and `uniProps` mappings are applied, as on device.
vi.mock("react-native-unistyles", async () => {
  const ReactModule = await import("react");
  const resolve = <T,>(styles: T | ((t: unknown) => T)): T =>
    typeof styles === "function" ? (styles as (t: unknown) => T)(theme.current) : styles;
  return {
    StyleSheet: {
      create: <T extends object>(styles: T | ((t: unknown) => T)) =>
        new Proxy({} as T, {
          get: (_target, key) => (resolve(styles) as Record<PropertyKey, unknown>)[key],
        }),
    },
    withUnistyles:
      (Component: React.ComponentType<Record<string, unknown>>) =>
      ({ uniProps, ...props }: Record<string, unknown> & { uniProps?: (t: unknown) => object }) =>
        ReactModule.createElement(Component, {
          ...props,
          ...(uniProps ? uniProps(theme.current) : {}),
        }),
    useUnistyles: () => ({ theme: theme.current, rt: { themeName: "light" } }),
    UnistylesRuntime: { setTheme: () => undefined, themeName: "light" },
  };
});

const fixture = vi.hoisted(() => ({ qr: "", url: "", fail: false, removed: "" }));
// L42: the host's connection state and the offer query, per test (defaults: online, offer answered).
const l42 = vi.hoisted(() => ({
  status: "online" as string,
  offer: "answered" as "answered" | "fetching" | "idle",
  error: null as Error | null,
  enabled: [] as boolean[],
  queryFn: null as null | (() => Promise<unknown>),
  reconnects: 0,
  getOffer: null as null | (() => Promise<unknown>),
  relayEndpoint: "relay.example.com:443",
  devicesTimedOut: false,
  devicesRefetches: 0,
  commandCentre: false,
  grants: [] as Array<{ deviceId: string; allow: boolean }>,
  readOnly: false,
  accountsManage: false,
  accountsGrants: [] as Array<{ deviceId: string; allow: boolean }>,
  audit: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/runtime/host-runtime", () => ({
  // The pair-all section's reads (no other hosts here).
  useHosts: () => [],
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
  isHostRuntimeConnected: (snapshot: { connectionStatus?: string } | null) =>
    snapshot?.connectionStatus === "online",
  useHostRuntimeSnapshot: () => ({ connectionStatus: l42.status }),
  useHostRuntimeClient: () => ({
    ensureConnected: () => {
      l42.reconnects += 1;
    },
    getDaemonPairingOffer: () => l42.getOffer?.() ?? new Promise(() => {}),
    getLastServerInfoMessage: () => ({
      features: {
        daemonStatusRpc: true,
        relayConfig: true,
        deviceCommandCentre: true,
        deviceAccountsManage: true,
      },
    }),
    setPairedDeviceAccountsManage: async (deviceId: string, allow: boolean) => {
      l42.accountsGrants.push({ deviceId, allow });
    },
    listAccountsAudit: async () => ({ entries: l42.audit }),
    setPairedDeviceCommandCentre: async (deviceId: string, allow: boolean) => {
      l42.grants.push({ deviceId, allow });
    },
    setRelayEndpoint: async () => {
      if (fixture.fail) throw new Error("Test save failed");
    },
    revokePairedDevice: async (id: string) => {
      fixture.removed = id;
    },
  }),
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: { relay: { endpoint: l42.relayEndpoint, endpointMutable: true } },
    patchConfig: async () => ({}),
  }),
}));
vi.mock("@/data/query", () => ({
  useFetchQuery: ({
    queryKey,
    queryFn,
    enabled,
  }: {
    queryKey: string[];
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
  }) => {
    let data: unknown = { relayEnabled: true, url: fixture.url };
    if (queryKey[0] === "daemon-pairing-offer") {
      l42.enabled.push(enabled !== false);
      l42.queryFn = queryFn;
      // A disabled query stays pending forever: the state L42 must not show as loading.
      if (enabled === false || l42.offer !== "answered") {
        const fetching = enabled !== false && l42.offer === "fetching";
        return {
          data: undefined,
          error: l42.error,
          isPending: !l42.error,
          isError: Boolean(l42.error),
          fetchStatus: fetching ? "fetching" : "idle",
          refetch: async () => undefined,
        };
      }
    }
    if (queryKey[0] === "paired-devices" && l42.devicesTimedOut) {
      return {
        data: undefined,
        error: new Error("Timeout waiting for message (15000ms)"),
        isPending: false,
        isError: true,
        fetchStatus: "idle",
        refetch: async () => {
          l42.devicesRefetches += 1;
        },
      };
    }
    if (queryKey[0] === "paired-devices") {
      data = {
        devices: [
          {
            deviceId: "dev_fixture",
            name: "Test phone",
            connected: true,
            commandCentre: l42.commandCentre,
            readOnly: l42.readOnly || undefined,
            accountsManage: l42.accountsManage || undefined,
          },
        ],
      };
    } else if (queryKey[0] === "accounts-audit") {
      data = { entries: l42.audit };
    } else if (queryKey[0] === "daemon-pairing-offer-qr") {
      data = fixture.qr;
    }
    return {
      data,
      error: null,
      isPending: false,
      isError: false,
      fetchStatus: "idle",
      refetch: async () => undefined,
    };
  },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => undefined }));
// The real Switch animates its track with theme colours this stubbed unistyles cannot map; a plain toggle stands in.
vi.mock("@/components/ui/switch", async () => {
  const ReactModule = await import("react");
  return {
    Switch: (props: {
      value: boolean;
      onValueChange?: (value: boolean) => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      testID?: string;
    }) =>
      ReactModule.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": props.value,
        "aria-label": props.accessibilityLabel,
        "data-testid": props.testID,
        disabled: props.disabled,
        onClick: () => props.onValueChange?.(!props.value),
      }),
  };
});
vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  return {
    SvgXml: ({ xml }: { xml: string }) =>
      ReactModule.createElement("div", {
        style: { width: "100%", height: "100%" },
        dangerouslySetInnerHTML: {
          __html: xml
            .replace('width="480"', 'width="100%"')
            .replace('height="480"', 'height="100%"'),
        },
      }),
  };
});
let root: Root | undefined;
let container: HTMLDivElement;
// The default browser project uses the classic JSX runtime for app sources.
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  fixture.fail = false;
  Object.assign(l42, {
    status: "online",
    offer: "answered",
    error: null,
    enabled: [],
    queryFn: null,
    reconnects: 0,
    relayEndpoint: "relay.example.com:443",
    devicesTimedOut: false,
    commandCentre: false,
    grants: [],
    readOnly: false,
    accountsManage: false,
    accountsGrants: [],
    audit: [],
    getOffer: null,
  });
  vi.unstubAllGlobals();
});
async function mount(mode: typeof lightTheme | typeof darkTheme, width: number, height: number) {
  theme.current = mode;
  await i18n.changeLanguage("en");
  await page.viewport(width, height);
  fixture.url =
    "fulcra://pair#offer=" +
    btoa(
      JSON.stringify({
        v: 3,
        serverId: "fixture-host",
        hostLabel: "Test host",
        daemonPublicKeyB64: btoa(String.fromCharCode(...Array(32).fill(7))),
        relay: { endpoint: "relay.example.com:443", useTls: true },
        pairing: {
          id: "A".repeat(22),
          secret: "B".repeat(43),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      }),
    );
  fixture.qr = await QRCode.toString(fixture.url, { type: "svg", width: 480, margin: 1 });
  document.body.style.margin = "0";
  document.body.style.background = mode.colors.surface1;
  container = document.createElement("div");
  Object.assign(container.style, {
    maxWidth: "480px",
    margin: "24px auto",
    padding: "16px",
    boxSizing: "border-box",
  });
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <PairDeviceSection serverId="fixture-host" onClose={noop} />
      </QueryClientProvider>,
    );
  });
}
describe("Pairing v3 controls", () => {
  for (const [name, mode] of [
    ["light", lightTheme],
    ["dark", darkTheme],
  ] as const) {
    for (const [width, height] of [
      [1280, 800],
      [390, 844],
    ]) {
      it(`${name} ${width}x${height}`, async () => {
        await mount(mode, width, height);
        expect(container.textContent).toContain("Pair new devices from this Mac");
        expect(container.textContent).toContain("Expires in 10 min");
        expect(container.textContent).toContain("Test host");
        expect(container.textContent).toMatch(/Key [A-F0-9]{4}(:[A-F0-9]{4}){7}/);
        expect(container.scrollWidth).toBeLessThanOrEqual(width);
        const svg = container.querySelector("svg")!;
        expect(svg.getBoundingClientRect().height).toBeLessThanOrEqual(304);
        expect(svg.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          svg.parentElement!.getBoundingClientRect().bottom + 1,
        );
        await page.screenshot({
          path: `../../.vitest-screenshots/pairing/${name}-${width}x${height}.png`,
          fullPage: false,
        });
      });
    }
  }
  it("shows failed saves and sends the selected device revoke", async () => {
    await mount(lightTheme, 390, 844);
    fixture.fail = true;
    await page.getByRole("button", { name: "Save relay address" }).click();
    await expect.element(page.getByText("Test save failed")).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    expect(fixture.removed).toBe("dev_fixture");
  });
});

describe("L42: the pairing offer never loads forever", () => {
  const LOADING = "Loading pairing offer";
  it("a connecting host shows the connecting state and Reconnect, not loading, and sends no request", async () => {
    l42.status = "connecting";
    await mount(lightTheme, 390, 844);
    expect(container.textContent).not.toContain(LOADING);
    expect(container.textContent).toContain("Connecting to this Mac…");
    expect(l42.enabled.every((on) => !on)).toBe(true);
    await page.getByRole("button", { name: "Reconnect" }).click();
    expect(l42.reconnects).toBe(1);
  });
  it("an online host sends the request and shows loading only while it is fetching", async () => {
    l42.offer = "fetching";
    await mount(lightTheme, 390, 844);
    expect(l42.enabled.at(-1)).toBe(true);
    expect(container.textContent).toContain(LOADING);
    act(() => root?.unmount());
    container.remove();
    l42.offer = "idle";
    await mount(lightTheme, 390, 844);
    expect(container.textContent).not.toContain(LOADING);
  });
  it("an offer that never arrives times out into a plain error with Retry", async () => {
    await mount(lightTheme, 390, 844);
    vi.useFakeTimers();
    try {
      const request = l42.queryFn!();
      const settled = expect(request).rejects.toThrow("The pairing offer didn't arrive in time.");
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    act(() => root?.unmount());
    container.remove();
    l42.offer = "idle";
    l42.error = new Error("The pairing offer didn't arrive in time.");
    await mount(lightTheme, 390, 844);
    expect(container.textContent).not.toContain(LOADING);
    expect(container.textContent).toContain("The pairing offer didn't arrive in time.");
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
  for (const status of ["offline", "error"]) {
    it(`an ${status} host is unchanged: not connected, with Retry`, async () => {
      l42.status = status;
      await mount(lightTheme, 390, 844);
      expect(container.textContent).not.toContain(LOADING);
      expect(container.textContent).not.toContain("Connecting to this Mac");
      expect(container.textContent).toContain("Host is not connected");
      await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
      // The offer query cannot run while the host is down, so Retry asks the connection to try again.
      const reconnects = l42.reconnects;
      await page.getByRole("button", { name: "Retry" }).click();
      expect(l42.reconnects).toBe(reconnects + 1);
    });
  }
  it("a paired-devices list that times out says so, with Retry", async () => {
    l42.devicesTimedOut = true;
    await mount(lightTheme, 390, 844);
    await expect.element(page.getByText("Paired devices couldn't be loaded.")).toBeVisible();
    expect(container.textContent).not.toContain("Timeout waiting for message");
    const refetches = l42.devicesRefetches;
    await page
      .getByTestId("pair-device-devices-error")
      .getByRole("button", { name: "Retry" })
      .click();
    expect(l42.devicesRefetches).toBe(refetches + 1);
  });
  it("shows the default relay as Default relay; Change opens an empty address field", async () => {
    l42.relayEndpoint = "relay.paseo.sh:443";
    await mount(darkTheme, 390, 844);
    expect(container.textContent).toContain("Default relay");
    expect(container.textContent).not.toContain("relay.paseo.sh");
    await page.getByTestId("pairing-relay-change").click();
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="pairing-relay-address"]',
    );
    expect(field?.value).toBe("");
    expect(container.textContent).not.toContain("relay.paseo.sh");
    await expect.element(page.getByRole("button", { name: "Save relay address" })).toBeVisible();
  });
  // L46 option 5: the owner's per-device grant.
  it("Allow Command Centre is off by default, turns on per device, and warns about lost phones", async () => {
    await mount(darkTheme, 390, 844);
    await expect
      .element(
        page.getByText("Off: Command Centre works on this device only over a direct connection."),
      )
      .toBeVisible();
    await page.getByTestId("paired-device-command-centre-switch-dev_fixture").click();
    await vi.waitFor(() => expect(l42.grants).toEqual([{ deviceId: "dev_fixture", allow: true }]));
    act(() => root?.unmount());
    container.remove();
    l42.commandCentre = true;
    await mount(darkTheme, 390, 844);
    await expect
      .element(page.getByText(/If it's lost or stolen, remove it here straight away/))
      .toBeVisible();
  });
  // U7: the owner's separate, explicit account-management grant, and what devices did with it.
  it("accounts-manage: not offered without a full Command Centre grant", async () => {
    await mount(darkTheme, 390, 844);
    expect(
      document.querySelector('[data-testid="paired-device-accounts-manage-switch-dev_fixture"]'),
    ).toBeNull();
    act(() => root?.unmount());
    container.remove();
    Object.assign(l42, { commandCentre: true, readOnly: true });
    await mount(darkTheme, 390, 844);
    expect(
      document.querySelector('[data-testid="paired-device-accounts-manage-switch-dev_fixture"]'),
    ).toBeNull();
  });
  it("accounts-manage: off by default; turning it on needs an explicit confirm; turning it off is immediate", async () => {
    l42.commandCentre = true;
    await mount(darkTheme, 390, 844);
    await expect
      .element(
        page.getByText(
          /Off: this device can't switch accounts, set the default or take over chats/,
        ),
      )
      .toBeVisible();
    await page.getByTestId("paired-device-accounts-manage-switch-dev_fixture").click();
    await expect
      .element(
        page.getByText(
          /Let Test phone switch accounts, set the default and take over chats on this Mac\?/,
        ),
      )
      .toBeVisible();
    expect(l42.accountsGrants).toEqual([]);
    await page.getByRole("button", { name: "Keep it off" }).click();
    expect(l42.accountsGrants).toEqual([]);
    await page.getByTestId("paired-device-accounts-manage-switch-dev_fixture").click();
    await page.getByRole("button", { name: "Allow account management" }).click();
    await vi.waitFor(() =>
      expect(l42.accountsGrants).toEqual([{ deviceId: "dev_fixture", allow: true }]),
    );
    act(() => root?.unmount());
    container.remove();
    l42.accountsManage = true;
    await mount(darkTheme, 390, 844);
    await expect.element(page.getByText(/On: this device can switch accounts/)).toBeVisible();
    await page.getByTestId("paired-device-accounts-manage-switch-dev_fixture").click();
    await vi.waitFor(() =>
      expect(l42.accountsGrants).toEqual([
        { deviceId: "dev_fixture", allow: true },
        { deviceId: "dev_fixture", allow: false },
      ]),
    );
  });
  it("accounts-manage: the owner sees recent account activity from devices", async () => {
    l42.audit = [
      {
        at: "2026-09-30T01:00:00.000Z",
        deviceId: "dev_fixture",
        deviceName: "Test phone",
        action: "takeover",
        accountLabel: "Work",
      },
      {
        at: "2026-09-30T00:30:00.000Z",
        deviceId: "dev_gone00000000000",
        deviceName: null,
        action: "set-default",
        accountLabel: "Personal",
      },
    ];
    await mount(darkTheme, 390, 844);
    await expect.element(page.getByText("Account activity from devices")).toBeVisible();
    await expect.element(page.getByText(/Test phone took over a chat onto Work/)).toBeVisible();
    await expect
      .element(page.getByText(/A removed device set the default account to Personal/))
      .toBeVisible();
  });
});
