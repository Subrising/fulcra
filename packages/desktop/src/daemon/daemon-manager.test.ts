import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import type { WebContents, OnBeforeSendHeadersListenerDetails, BeforeSendResponse } from "electron";
import { createDaemonCommandHandlers, registerCommandCentreWindow } from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  config: {} as Record<string, unknown>,
  readInstance: vi.fn<
    () => Promise<{ pid: number; startedAt: string; desktopManaged: boolean } | null>
  >(async () => null),
  keychainGet: vi.fn<() => Promise<string | null>>(async () => "fake-only-secret"),
  keychainSet: vi.fn(async (_service: string, _password: string) => {}),
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
      commandCentreEnabled: false,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  startDaemonInstance: vi.fn(),
  stopDaemonInstance: vi.fn(),
  saveOwner: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
  startDaemonInstance: mocks.startDaemonInstance,
  stopDaemonInstance: mocks.stopDaemonInstance,
  readDaemonInstance: mocks.readInstance,
  isSameDaemonInstance: (
    a: { pid: number; startedAt: string },
    b: { pid: number; startedAt: string },
  ) => a.pid === b.pid && a.startedAt === b.startedAt,
  DaemonInstanceError: class extends Error {
    code = "DAEMON_NOT_READY";
  },
}));

vi.mock("./command-centre-owner.js", () => ({
  saveCommandCentreOwner: mocks.saveOwner,
  ownsCommandCentreSupervisor: async () => false,
}));
vi.mock("./command-centre-keychain.js", () => ({
  commandCentreKeychain: {
    get: mocks.keychainGet,
    set: mocks.keychainSet,
  },
}));
vi.mock("@getpaseo/server/configuration", () => ({
  loadPersistedConfig: () => mocks.config,
}));
vi.mock("@getpaseo/server/auth", () => ({
  hashDaemonPassword: () => "fake-only-hash",
  // Stand-in for bcrypt: "hash-of:<secret>" matches <secret>.
  isBearerTokenValidAsync: async (input: { password?: string; token: string | null }) =>
    input.password === `hash-of:${input.token}`,
}));
vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    patch: async (patch: { daemon?: Record<string, unknown> }) => {
      mocks.settings = {
        ...mocks.settings,
        ...patch,
        daemon: { ...mocks.settings.daemon, ...patch.daemon },
      } as typeof mocks.settings;
      return mocks.settings;
    },
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", () => ({
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({
      command: "node",
      args: [],
      env: {},
    });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("D27 ignores renderer paths and returns pins only from this app's resources", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    const directory = path.join(fixtureRoot, "bundled-plugins/example");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "example" }));
    writeFileSync(
      path.join(directory, "runtime-manifest.json"),
      JSON.stringify({ version: 1, client: "a".repeat(64) }),
    );
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: fixtureRoot });
    try {
      expect(
        createDaemonCommandHandlers().desktop_bundled_plugin_pins({
          root: "/untrusted-host",
          pins: { example: "b".repeat(64) },
        }),
      ).toEqual({ example: "a".repeat(64) });
    } finally {
      if (descriptor) Object.defineProperty(process, "resourcesPath", descriptor);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    mocks.readInstance.mockResolvedValue(lock);
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    mocks.readInstance.mockResolvedValue({ ...lock, desktopManaged: false });
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
    mocks.readInstance.mockResolvedValue(null);
  });
});

// Main-world plugins share this exact IPC command table.
it("never exports the persistent daemon credential to renderer/plugin callers", () => {
  expect(createDaemonCommandHandlers()).not.toHaveProperty("get_desktop_command_centre_auth");
});

it("persists an acquired supervisor after first-start readiness timeout", async () => {
  const { DaemonInstanceError } = await import("@getpaseo/server/daemon-control");
  const instance = {
    pid: 123,
    startedAt: "fixture-start",
    desktopManaged: true,
  };
  mocks.settings = {
    ...DEFAULT_DESKTOP_SETTINGS,
    daemon: {
      ...DEFAULT_DESKTOP_SETTINGS.daemon,
      commandCentreEnabled: true,
      manageBuiltInDaemon: true,
    },
  };
  mocks.readInstance.mockResolvedValue(null);
  mocks.runExternalCliJsonCommand.mockResolvedValue({
    localDaemon: "stopped",
    connectedDaemon: "not_probed",
  });
  mocks.startDaemonInstance.mockImplementation(async (options) => {
    options.onAcquired(instance);
    throw new DaemonInstanceError("DAEMON_NOT_READY", "timeout");
  });
  mocks.saveOwner.mockClear();
  await createDaemonCommandHandlers().start_desktop_daemon();
  expect(mocks.saveOwner).toHaveBeenCalledWith(mocks.paseoHome, instance);
});
it("IR-4 enabled launch strips ambient PASEO_PASSWORD from the worker environment", async () => {
  mocks.settings = {
    ...DEFAULT_DESKTOP_SETTINGS,
    daemon: {
      ...DEFAULT_DESKTOP_SETTINGS.daemon,
      manageBuiltInDaemon: true,
      commandCentreEnabled: true,
    },
  };
  mocks.readInstance.mockResolvedValue(null);
  mocks.runExternalCliJsonCommand.mockResolvedValue({
    localDaemon: "stopped",
    connectedDaemon: "not_probed",
  });
  mocks.createNodeEntrypointInvocation.mockReturnValue({
    command: "node",
    args: [],
    env: { PASEO_PASSWORD: "fake ambient only" },
  });
  mocks.startDaemonInstance.mockResolvedValue(undefined);
  await createDaemonCommandHandlers().start_desktop_daemon();
  expect(mocks.startDaemonInstance.mock.lastCall?.[0].env.PASEO_PASSWORD).toBeUndefined();
  expect(
    mocks.startDaemonInstance.mock.lastCall?.[0].env.FULCRA_COMMAND_CENTRE_AUTH_HASH,
  ).toBeTruthy();
});
it("FC-1 without an owned endpoint, preflight leaves unrelated local sockets alone", async () => {
  mocks.settings = {
    ...DEFAULT_DESKTOP_SETTINGS,
    daemon: {
      ...DEFAULT_DESKTOP_SETTINGS.daemon,
      manageBuiltInDaemon: true,
      commandCentreEnabled: true,
    },
  };
  mocks.runExternalCliJsonCommand.mockRejectedValue(Error("Authentication unavailable"));
  expect(
    await createDaemonCommandHandlers().desktop_daemon_connection_check({
      url: "ws://127.0.0.1:16767/ws",
    }),
  ).toBe(true);
});

describe("D29-correctness: uncached main-process handshake", () => {
  const instance = {
    pid: 12345,
    startedAt: "fake-start",
    desktopManaged: true,
    listen: "127.0.0.1:16767",
  };
  let root: string;
  let contents: WebContents;
  let hook: (
    details: OnBeforeSendHeadersListenerDetails,
    callback: (result: BeforeSendResponse) => void,
  ) => Promise<void>;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "cc-auth-correctness-"));
    mocks.paseoHome = root;
    mocks.settings = {
      ...DEFAULT_DESKTOP_SETTINGS,
      daemon: {
        ...DEFAULT_DESKTOP_SETTINGS.daemon,
        manageBuiltInDaemon: true,
        commandCentreEnabled: true,
      },
    };
    mocks.readInstance.mockReset().mockResolvedValue(null);
    mocks.keychainGet.mockReset().mockResolvedValue("fake-only-secret");
    mocks.runExternalCliJsonCommand
      .mockReset()
      .mockResolvedValue({ localDaemon: "stopped", connectedDaemon: "not_probed" });
    mocks.startDaemonInstance.mockImplementation(async (options) => {
      options.onAcquired(instance);
    });
    await createDaemonCommandHandlers().start_desktop_daemon();
    mocks.readInstance.mockResolvedValue(instance);
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      serverId: "fixture",
      listen: "127.0.0.1:16767",
      ...instance,
    });
    contents = {
      id: 42,
      isDestroyed: () => false,
      mainFrame: { url: "paseo://app/" },
      once: vi.fn(),
      session: {
        webRequest: {
          onBeforeSendHeaders: (_filter: unknown, listener: typeof hook) => {
            hook = listener;
          },
        },
      },
    } as unknown as WebContents;
    registerCommandCentreWindow(contents);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  async function request(url = "ws://127.0.0.1:16767/ws") {
    let result: BeforeSendResponse | undefined;
    await hook(
      {
        url,
        requestHeaders: {},
        webContents: contents,
        webContentsId: 42,
        frame: contents.mainFrame,
        resourceType: "webSocket",
      } as OnBeforeSendHeadersListenerDetails,
      (response) => {
        result = response;
      },
    );
    return result;
  }
  it("FC-1 owner mismatch and unavailable status cannot affect other endpoints", async () => {
    // First successful status captures the exact owned listen address.
    await createDaemonCommandHandlers().desktop_daemon_status();
    mocks.readInstance.mockResolvedValue({ ...instance, startedAt: "replacement" });
    mocks.runExternalCliJsonCommand.mockRejectedValue(Error("owned unavailable"));
    mocks.keychainGet.mockClear();
    mocks.readInstance.mockClear();
    mocks.runExternalCliJsonCommand.mockClear();
    for (const url of [
      "ws://192.0.2.8:16767/ws",
      "ws://100.90.1.2:16767/ws",
      "ws://127.0.0.1:16768/ws",
      "ws://[::1]:16768/ws",
    ]) {
      expect(await createDaemonCommandHandlers().desktop_daemon_connection_check({ url })).toBe(
        true,
      );
      expect(await request(url)).toEqual({ requestHeaders: {} });
    }
    expect(mocks.keychainGet).not.toHaveBeenCalled();
    expect(mocks.readInstance).not.toHaveBeenCalled();
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });
  it("FC-1 owned starting preflight is retryable and does not release auth", async () => {
    await createDaemonCommandHandlers().desktop_daemon_status();
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "not_ready",
      listen: "127.0.0.1:16767",
      ...instance,
    });
    expect(
      await createDaemonCommandHandlers().desktop_daemon_connection_check({
        url: "ws://127.0.0.1:16767/ws",
      }),
    ).toEqual({ retry: true });
    expect(await request()).toEqual({ cancel: true });
    mocks.runExternalCliJsonCommand.mockRejectedValue(Error("status unavailable"));
    expect(
      await createDaemonCommandHandlers().desktop_daemon_connection_check({
        url: "ws://127.0.0.1:16767/ws",
      }),
    ).toEqual({ retry: true });
  });
  it("FC-1 restart clears the old lifetime and acquires the replacement", async () => {
    await createDaemonCommandHandlers().desktop_daemon_status();
    const replacement = { ...instance, pid: 12346, startedAt: "new-start" };
    let running = true;
    let observed = instance;
    mocks.stopDaemonInstance.mockImplementation(async () => {
      running = false;
      mocks.readInstance.mockResolvedValue(null);
    });
    mocks.startDaemonInstance.mockImplementation(async (options) => {
      running = true;
      observed = replacement;
      mocks.readInstance.mockResolvedValue(replacement);
      options.onAcquired(replacement);
    });
    mocks.runExternalCliJsonCommand.mockImplementation(async () => {
      if (!running) return { localDaemon: "stopped", connectedDaemon: "not_probed" };
      return {
        localDaemon: "running",
        serverId: "fixture",
        listen: "127.0.0.1:16767",
        ...observed,
      };
    });
    await createDaemonCommandHandlers().restart_desktop_daemon();
    expect(mocks.startDaemonInstance.mock.lastCall?.[0].desktopManaged).toBe(true);
    expect(mocks.runExternalCliJsonCommand.mock.calls.some(([args]) => args[1] === "restart")).toBe(
      false,
    );
    expect(await request()).toEqual({
      requestHeaders: { Authorization: "Bearer fake-only-secret" },
    });
  });
  it("attaches a credential only to the exact owned process and URL", async () => {
    expect(await request()).toEqual({
      requestHeaders: { Authorization: "Bearer fake-only-secret" },
    });
    for (const url of [
      "ws://127.0.0.1:16768/ws",
      "ws://localhost:16767/ws",
      "ws://192.0.2.1:16767/ws",
      "ws://127.0.0.1:16767/other",
    ]) {
      expect(await request(url)).toEqual({ requestHeaders: {} });
    }
  });
  it.each([
    { ...instance, pid: 12346 },
    { ...instance, startedAt: "reused-pid" },
  ])("refuses a PID/start mismatch %j", async (changed) => {
    mocks.readInstance.mockResolvedValue(changed);
    expect(await request()).toEqual({ cancel: true });
  });
  it("honours rotation on the next handshake and disable", async () => {
    expect(await request()).toEqual({
      requestHeaders: { Authorization: "Bearer fake-only-secret" },
    });
    mocks.keychainGet.mockResolvedValue("fake-only-rotated");
    expect(await request()).toEqual({
      requestHeaders: { Authorization: "Bearer fake-only-rotated" },
    });
    mocks.settings.daemon.commandCentreEnabled = false;
    expect(await request()).toEqual({ requestHeaders: {} });
  });
  it("fails closed on a missing credential or a starting owned daemon", async () => {
    mocks.keychainGet.mockResolvedValue(null);
    expect(await request()).toEqual({ cancel: true });
    mocks.keychainGet.mockResolvedValue("fake-only-secret");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "not_ready",
      serverId: "fixture",
      listen: "127.0.0.1:16767",
      ...instance,
    });
    expect(await request()).toEqual({ cancel: true });
  });
  it("does not release a credential if disabled during the final ownership check", async () => {
    mocks.readInstance.mockResolvedValueOnce(instance).mockImplementationOnce(async () => {
      mocks.settings.daemon.commandCentreEnabled = false;
      return instance;
    });
    expect(await request()).toEqual({ cancel: true });
  });
  it("refuses ownership replaced during asynchronous credential lookup", async () => {
    mocks.readInstance
      .mockResolvedValueOnce(instance)
      .mockResolvedValueOnce({ ...instance, startedAt: "replaced" });
    expect(await request()).toEqual({ cancel: true });
  });
});

// L39: the Mac's own window and a launchd-managed service of the same home (this app launched no daemon).
describe("L39 local service of this home", () => {
  let root: string;
  const listen = "127.0.0.1:6791";
  async function freshWindow() {
    vi.resetModules();
    const manager = await import("./daemon-manager");
    let hook!: (
      details: OnBeforeSendHeadersListenerDetails,
      callback: (response: BeforeSendResponse) => void,
    ) => Promise<void>;
    const contents = {
      id: 7,
      isDestroyed: () => false,
      mainFrame: { url: "paseo://app/" },
      once: vi.fn(),
      session: {
        webRequest: {
          onBeforeSendHeaders: (_filter: unknown, listener: typeof hook) => {
            hook = listener;
          },
        },
      },
    } as unknown as WebContents;
    manager.registerCommandCentreWindow(contents);
    const request = async (url: string) => {
      let result: BeforeSendResponse | undefined;
      await hook(
        {
          url,
          requestHeaders: {},
          webContents: contents,
          webContentsId: 7,
          frame: contents.mainFrame,
          resourceType: "webSocket",
        } as OnBeforeSendHeadersListenerDetails,
        (response) => {
          result = response;
        },
      );
      return result;
    };
    return { manager, request };
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "l39-service-"));
    mocks.paseoHome = root;
    // Synthetic secret; the configured password is its "hash".
    writeFileSync(path.join(root, "controller.secret"), "synthetic-launchd-secret\n", {
      mode: 0o600,
    });
    mocks.config = { daemon: { auth: { password: "hash-of:synthetic-launchd-secret" }, listen } };
    mocks.settings = {
      ...DEFAULT_DESKTOP_SETTINGS,
      daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon, commandCentreEnabled: true },
    };
    mocks.readInstance.mockReset().mockResolvedValue({
      pid: process.pid,
      startedAt: "launchd",
      desktopManaged: false,
      listen,
    } as never);
  });
  afterEach(() => {
    mocks.config = {};
    rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === "win32")(
    "Windows window admission cannot turn a launchd-style secret into owner headers",
    async () => {
      const { manager, request } = await freshWindow();
      const url = `ws://${listen}/ws`;
      expect(await request(url)).toEqual({ requestHeaders: {} });
      expect(
        await manager.createDaemonCommandHandlers().desktop_local_credential({ listen }),
      ).toBeNull();
    },
  );

  // The launchd-service fixture relies on POSIX uid and private-file modes.
  it.runIf(process.platform !== "win32")(
    "gives the window owner access to this home's service, as a main-process header only",
    async () => {
      const { manager, request } = await freshWindow();
      expect(await request(`ws://${listen}/ws`)).toEqual({
        requestHeaders: { Authorization: "Bearer synthetic-launchd-secret" },
      });
      // The renderer-facing check says only "available": the secret never crosses IPC.
      expect(
        await manager.createDaemonCommandHandlers().desktop_daemon_connection_check({
          url: `ws://${listen}/ws`,
        }),
      ).toBe(true);
    },
  );

  it("gives nothing for a remote target, another port, or another home", async () => {
    const { request } = await freshWindow();
    for (const url of [
      "ws://192.0.2.8:6791/ws",
      "ws://127.0.0.1:6792/ws",
      "ws://mac.local:6791/ws",
    ])
      expect(await request(url)).toEqual({ requestHeaders: {} });
    const other = mkdtempSync(path.join(tmpdir(), "l39-other-"));
    try {
      mocks.paseoHome = other;
      const otherWindow = await freshWindow();
      expect(await otherWindow.request(`ws://${listen}/ws`)).toEqual({ requestHeaders: {} });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // The launchd-service fixture relies on POSIX uid and private-file modes.
  it.runIf(process.platform !== "win32")(
    "switching Command Centre on beside the running service keeps the setting and gives the window owner access",
    async () => {
      mocks.settings = {
        ...DEFAULT_DESKTOP_SETTINGS,
        daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon, commandCentreEnabled: false },
      };
      mocks.runExternalCliJsonCommand.mockReset().mockResolvedValue({
        localDaemon: "running",
        pid: process.pid,
        startedAt: "launchd",
        listen,
        desktopManaged: false,
      });
      mocks.startDaemonInstance.mockReset();
      const { manager, request } = await freshWindow();
      expect(await request(`ws://${listen}/ws`)).toEqual({ requestHeaders: {} });

      const handlers = manager.createDaemonCommandHandlers();
      await handlers.patch_desktop_settings({ daemon: { commandCentreEnabled: true } });

      expect(mocks.settings.daemon.commandCentreEnabled).toBe(true);
      // Not this app's service: never stopped, never replaced by a daemon of this app.
      expect(mocks.runExternalCliJsonCommand.mock.calls.flat()).not.toContain("stop");
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
      expect(await request(`ws://${listen}/ws`)).toEqual({
        requestHeaders: { Authorization: "Bearer synthetic-launchd-secret" },
      });

      // The app's own status probe of the service signs in the same way (the bundled CLI only), so the window gets
      // the service's server id and connects.
      mocks.runExternalCliJsonCommand.mockClear();
      const status = await handlers.desktop_daemon_status();
      expect(status).toMatchObject({ status: "running", usesGeneratedCredential: true });
      expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith(
        expect.arrayContaining(["status"]),
        { env: { PASEO_PASSWORD: "synthetic-launchd-secret" } },
      );

      // Switching it off again is kept too, and the window stops signing in.
      await handlers.patch_desktop_settings({ daemon: { commandCentreEnabled: false } });
      expect(mocks.settings.daemon.commandCentreEnabled).toBe(false);
      expect(await request(`ws://${listen}/ws`)).toEqual({ requestHeaders: {} });
      mocks.runExternalCliJsonCommand.mockClear();
      await handlers.desktop_daemon_status();
      expect(mocks.runExternalCliJsonCommand.mock.calls.every((call) => call.length === 1)).toBe(
        true,
      );
    },
  );

  it("gives nothing when Command Centre is off", async () => {
    mocks.settings = {
      ...DEFAULT_DESKTOP_SETTINGS,
      daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon, commandCentreEnabled: false },
    };
    const { request } = await freshWindow();
    expect(await request(`ws://${listen}/ws`)).toEqual({ requestHeaders: {} });
  });
});

describe("owned startup and Settings recovery", () => {
  const stopped = { localDaemon: "stopped", connectedDaemon: "not_probed" };
  const instance = {
    pid: 8765,
    startedAt: "owned-fixture",
    desktopManaged: true,
    listen: "127.0.0.1:17865",
  };
  let manager: typeof import("./daemon-manager");
  let root: string;
  beforeEach(async () => {
    vi.resetModules();
    root = mkdtempSync(path.join(tmpdir(), "host-startup-fake-"));
    mocks.paseoHome = root;
    mocks.config = {};
    mocks.settings = {
      ...DEFAULT_DESKTOP_SETTINGS,
      daemon: {
        ...DEFAULT_DESKTOP_SETTINGS.daemon,
        manageBuiltInDaemon: true,
        commandCentreEnabled: true,
      },
    };
    mocks.readInstance.mockReset().mockResolvedValue(null);
    mocks.keychainGet.mockReset().mockResolvedValue("fake-only-secret");
    mocks.keychainSet.mockReset().mockImplementation(async (_service, password) => {
      mocks.keychainGet.mockResolvedValue(password);
    });
    mocks.runExternalCliJsonCommand.mockReset().mockResolvedValue(stopped);
    mocks.startDaemonInstance.mockReset().mockImplementation(async (options) => {
      options.onAcquired(instance);
    });
    mocks.stopDaemonInstance.mockReset();
    mocks.createNodeEntrypointInvocation
      .mockReset()
      .mockReturnValue({ command: "node", args: [], env: {} });
    manager = await import("./daemon-manager");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  it("first enable proves stopped before creating and verifying its credential", async () => {
    mocks.keychainGet.mockResolvedValueOnce(null).mockResolvedValue("a".repeat(64));
    await manager.createDaemonCommandHandlers().start_desktop_daemon();
    expect(mocks.runExternalCliJsonCommand.mock.calls[0]).toEqual([
      ["daemon", "status", "--home", root, "--json"],
    ]);
    expect(mocks.runExternalCliJsonCommand.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.keychainGet.mock.invocationCallOrder[0],
    );
    expect(mocks.startDaemonInstance).toHaveBeenCalledTimes(1);
    expect(mocks.startDaemonInstance.mock.lastCall?.[0]).toMatchObject({
      home: root,
      desktopManaged: true,
      env: { FULCRA_COMMAND_CENTRE: "1", FULCRA_COMMAND_CENTRE_AUTH_HASH: "fake-only-hash" },
    });
  });
  it.each([
    null,
    { localDaemon: "stopped" },
    { localDaemon: "stopped", connectedDaemon: "auth_failed" },
    { localDaemon: "running", connectedDaemon: "not_probed" },
    { localDaemon: "unexpected", connectedDaemon: "not_probed" },
    { ...stopped, pid: 999 },
  ])(
    "refuses ambiguous local status without credential creation or launch: %j",
    async (payload) => {
      mocks.runExternalCliJsonCommand.mockResolvedValue(payload);
      await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
      expect(mocks.keychainGet).not.toHaveBeenCalled();
      expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    },
  );
  it("CLI failure is never stopped", async () => {
    mocks.runExternalCliJsonCommand.mockRejectedValue(Error("fake CLI failure"));
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.keychainGet).not.toHaveBeenCalled();
  });
  it("replacement between stopped observation and credential creation refuses", async () => {
    mocks.readInstance.mockResolvedValueOnce(null).mockResolvedValue(instance);
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.keychainGet).not.toHaveBeenCalled();
  });
  it("replacement during credential lookup refuses without stopping the new lifetime", async () => {
    mocks.keychainGet.mockImplementation(async () => {
      mocks.readInstance.mockResolvedValue(instance);
      return "fake-only-secret";
    });
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });
  it("instance-present unknown status refuses launch and stop", async () => {
    mocks.readInstance.mockResolvedValue(instance);
    mocks.runExternalCliJsonCommand.mockResolvedValue({ connectedDaemon: "reachable" });
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });
  it("instance-present authentication failure refuses launch and stop", async () => {
    mocks.readInstance.mockResolvedValue(instance);
    mocks.keychainGet.mockRejectedValue(Error("fake auth failure"));
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });
  async function acquireOwned() {
    await manager.createDaemonCommandHandlers().start_desktop_daemon();
    mocks.readInstance.mockResolvedValue(instance);
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      connectedDaemon: "reachable",
      ...instance,
      daemonVersion: "0.1.0",
    });
    mocks.startDaemonInstance.mockClear();
  }
  it("owned version mismatch stops its captured lifetime then launches managed once", async () => {
    await acquireOwned();
    mocks.stopDaemonInstance.mockImplementation(async () => {
      mocks.readInstance.mockResolvedValue(null);
      mocks.runExternalCliJsonCommand.mockResolvedValue(stopped);
    });
    await manager.createDaemonCommandHandlers().start_desktop_daemon();
    expect(mocks.stopDaemonInstance.mock.lastCall?.[1].instance).toEqual(instance);
    expect(mocks.stopDaemonInstance.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startDaemonInstance.mock.invocationCallOrder[0],
    );
    expect(mocks.startDaemonInstance).toHaveBeenCalledTimes(1);
    expect(mocks.startDaemonInstance.mock.lastCall?.[0].desktopManaged).toBe(true);
  });
  it("owned version mismatch still running blocks a second launch", async () => {
    await acquireOwned();
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
  });
  it("replaced lifetime after owned stop blocks a second launch", async () => {
    await acquireOwned();
    mocks.stopDaemonInstance.mockImplementation(async () => {
      mocks.readInstance.mockResolvedValue({ ...instance, startedAt: "replacement" });
      mocks.runExternalCliJsonCommand.mockResolvedValue(stopped);
    });
    await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
  });
  it("foreign running version is never stopped or replaced", async () => {
    mocks.readInstance.mockResolvedValue({ ...instance, desktopManaged: false });
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      ...instance,
      desktopManaged: false,
      daemonVersion: "0.1.0",
    });
    await manager.createDaemonCommandHandlers().start_desktop_daemon();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });
  describe("a desktop-managed daemon that does not answer", () => {
    const silent = {
      localDaemon: "running",
      connectedDaemon: "unreachable",
      ...instance,
      desktopManaged: true,
      daemonVersion: "1.2.3",
    };
    beforeEach(() => {
      manager.DESKTOP_STARTUP_ANSWER_WAIT.totalMs = 200;
      manager.DESKTOP_STARTUP_ANSWER_WAIT.stepMs = 5;
      mocks.readInstance.mockResolvedValue(instance);
    });
    // The first two probes see the silent daemon; later probes see the result.
    function probesThen(after: () => unknown) {
      let probes = 0;
      mocks.runExternalCliJsonCommand.mockImplementation(async () => {
        probes += 1;
        return probes < 3 ? silent : after();
      });
      return () => probes;
    }
    function exited() {
      mocks.readInstance.mockResolvedValue(null);
      return stopped;
    }
    function answers() {
      return { ...silent, connectedDaemon: "reachable" };
    }
    it("is awaited while it shuts down, then a new daemon starts", async () => {
      const probes = probesThen(exited);
      await manager.createDaemonCommandHandlers().start_desktop_daemon();
      expect(probes()).toBeGreaterThanOrEqual(3);
      expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
      expect(mocks.startDaemonInstance).toHaveBeenCalledTimes(1);
    });
    it("is used, not replaced, when it starts to answer", async () => {
      probesThen(answers);
      const status = await manager.createDaemonCommandHandlers().start_desktop_daemon();
      expect(status).toMatchObject({ status: "running", answering: true });
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
      expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    });
    it.each([
      { ...silent, connectedDaemon: "auth_required" },
      { ...silent, connectedDaemon: "auth_failed" },
      { ...silent, localDaemon: "not_ready", connectedDaemon: "not_probed" },
    ])("is not awaited or replaced when the probe got another answer: %j", async (payload) => {
      mocks.runExternalCliJsonCommand.mockResolvedValue(payload);
      await manager.createDaemonCommandHandlers().start_desktop_daemon();
      expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(1);
      expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    });
    it("is never stopped when this app does not own it; the launch refuses", async () => {
      mocks.runExternalCliJsonCommand.mockResolvedValue(silent);
      await expect(manager.createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow(
        /does not answer/,
      );
      expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    });
  });
  it("Settings status failure rolls enabled flag back and does not launch", async () => {
    mocks.settings.daemon.commandCentreEnabled = false;
    mocks.runExternalCliJsonCommand.mockRejectedValue(Error("fake status failure"));
    await expect(
      manager
        .createDaemonCommandHandlers()
        .patch_desktop_settings({ daemon: { commandCentreEnabled: true } }),
    ).rejects.toThrow();
    expect(mocks.settings.daemon.commandCentreEnabled).toBe(false);
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
  });
});
