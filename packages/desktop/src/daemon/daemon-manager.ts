import { readBundledPluginPins } from "./bundled-plugin-pins.js";
import { ownedDaemonHeaders } from "./command-centre-headers.js";
import type { WebContents, Session as ElectronSession } from "electron";
import { commandCentreBearer } from "./command-centre-target.js";
import { saveCommandCentreOwner, ownsCommandCentreSupervisor } from "./command-centre-owner.js";
import { commandCentreCredential } from "./command-centre-auth.js";
import { commandCentreKeychain } from "./command-centre-keychain.js";
import { restartManagedDaemon } from "./managed-restart.js";
import { hashDaemonPassword, isBearerTokenValidAsync } from "@getpaseo/server/auth";
import { localServiceOwnerCredential } from "./local-service-credential.js";
import { loadPersistedConfig } from "@getpaseo/server/configuration";
import { readFileSync } from "node:fs";
import { getElectronDeviceKey } from "../features/device-key-electron.js";
import { createRelayIdentityCommandHandlers } from "../features/relay-identity-electron.js";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import {
  resolvePaseoHome,
  startDaemonInstance,
  DaemonInstanceError,
  stopDaemonInstance,
  readDaemonInstance,
  isSameDaemonInstance,
  readLocalCredentialForTarget,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  type AppUpdateCheckIntent,
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
} from "../integrations/cli-install/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { describeSandbox } from "../diagnostics/sandbox.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { getDesktopUpdaterDiagnostics } from "../diagnostics/updater.js";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "../integrations/legacy-skill-selection.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
let ownedLaunch: { home: string; instance: DaemonInstance; endpoint: string | null } | null = null;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "app_update",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  ownedByDesktop: boolean;
  usesGeneratedCredential?: boolean;
  startedAt: string | null;
  error: string | null;
  /** The daemon answered the status probe (`connectedDaemon: "reachable"`). */
  answering?: boolean;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseReleaseChannel(
  args: Record<string, unknown> | undefined,
): AppReleaseChannel | undefined {
  if (args?.releaseChannel === "beta") {
    return "beta";
  }
  if (args?.releaseChannel === "stable") {
    return "stable";
  }
  return undefined;
}

function parseAppUpdateCheckIntent(
  args: Record<string, unknown> | undefined,
): AppUpdateCheckIntent {
  return args?.intent === "manual" ? "manual" : "automatic";
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome({
    ...process.env,
    PASEO_HOME: process.env.PASEO_HOME || path.join(app.getPath("userData"), "daemon"),
  });
}

function logFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  if (!ownedLaunch) return false;
  try {
    const lock = JSON.parse(readFileSync(path.join(ownedLaunch.home, "paseo.pid"), "utf8"));
    return isSameDaemonInstance(lock, ownedLaunch.instance) && isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await stopDesktopDaemon(reason);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function updateOwnedEndpointFromProbe(payload: Record<string, unknown>, home: string): void {
  if (
    ownedLaunch?.home === home &&
    payload.pid === ownedLaunch.instance.pid &&
    payload.startedAt === ownedLaunch.instance.startedAt &&
    typeof payload.listen === "string"
  ) {
    ownedLaunch.endpoint = ownedEndpoint(home, { ...ownedLaunch.instance, listen: payload.listen });
  }
}

function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  updateOwnedEndpointFromProbe(payload, home);
  let status: DesktopDaemonState = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    answering: payload.connectedDaemon === "reachable",
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error: null,
  };
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();

  try {
    // The app polls this while no local daemon runs. Answer that case in-process,
    // since launching the CLI once per poll keeps spawning processes while idle.
    if (!(await readDaemonInstance(home))) {
      return statusFromDaemonProbe({ localDaemon: "stopped" }, home);
    }

    const password =
      (await desktopCommandCentreCredential()) ?? (await localServiceStatusAuth(home));
    const args = ["daemon", "status", "--home", home, "--json"];
    const payload = (await (password
      ? runExternalCliJsonCommand(args, { env: { PASEO_PASSWORD: password } })
      : runExternalCliJsonCommand(args))) as Record<string, unknown>;
    if (!payload || !["running", "not_ready", "stopped"].includes(String(payload.localDaemon)))
      throw retryOwnedDaemon("Desktop daemon returned an invalid local status.");
    return { ...statusFromDaemonProbe(payload, home), usesGeneratedCredential: Boolean(password) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus failed", { error: errorMessage });
    return {
      serverId: "",
      status: "errored",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      ownedByDesktop: false,
      startedAt: null,
      error: errorMessage,
    };
  }
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function shouldRestartForVersion(current: DesktopDaemonStatus): boolean {
  if (!current.ownedByDesktop) return false;
  const appVersion = normalizeVersion(resolveDesktopAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

async function desktopCommandCentreCredential(create = false): Promise<string | null> {
  const settings = await getDesktopSettingsStore().get();
  if (settings.daemon.commandCentreEnabled !== true) return null;
  const home = getPaseoHome();
  // A previously configured daemon password remains its owner's responsibility.
  if (loadPersistedConfig(home).daemon?.auth?.password) return null;
  return commandCentreCredential({
    enabled: settings.daemon.commandCentreEnabled === true,
    home,
    keychain: commandCentreKeychain,
    create,
  });
}

function ownedEndpoint(home: string, instance: DaemonInstance): string | null {
  const listen =
    instance.listen ??
    process.env.PASEO_LISTEN ??
    loadPersistedConfig(home).daemon?.listen ??
    `127.0.0.1:${process.env.PORT ?? 6767}`;
  try {
    const url = new URL(`ws://${listen}/ws`);
    return ["127.0.0.1", "[::1]"].includes(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}
function retryOwnedDaemon(message: string): Error {
  return Object.assign(new Error(message), { code: "DESKTOP_DAEMON_RETRY" });
}
async function resolveOwnedAuth(url: string): Promise<string | null | undefined> {
  const target = new URL(url);
  if (target.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(target.hostname))
    return undefined;
  const status = await resolveDesktopDaemonStatus();
  if (status.error) throw retryOwnedDaemon("Desktop daemon status unavailable. Retry when ready.");
  if (status.status === "starting")
    throw retryOwnedDaemon("Desktop daemon is starting. Retry when ready.");
  if (!status.ownedByDesktop || !status.listen) return undefined;
  const expected = new URL(`ws://${status.listen}/ws`);
  if (!["127.0.0.1", "[::1]"].includes(expected.hostname) || url !== expected.toString())
    return undefined;
  if (status.status !== "running")
    throw retryOwnedDaemon("Desktop daemon is starting. Retry when ready.");
  return commandCentreBearer({
    enabled: true,
    status,
    target: { url, serverId: status.serverId },
    read: desktopCommandCentreCredential,
  });
}
/**
 * L39: the local owner credential for this home's running service (not launched by this app), from its
 * `controller.secret`, only when that secret is the service's configured password. Main process only.
 */
function localServiceAuth(url: string): Promise<string | undefined> {
  return localServiceOwnerCredential(url, {
    home: getPaseoHome(),
    readInstance: readDaemonInstance,
    endpointOf: ownedEndpoint,
    configuredPasswordHash: (home) => loadPersistedConfig(home).daemon?.auth?.password,
    matches: (secret, hash) => isBearerTokenValidAsync({ password: hash, token: secret }),
    uid: process.getuid?.() ?? -1,
  });
}

/**
 * L39: the credential for this app's own status probe of this home's running service when this app launched no
 * daemon (e.g. launchd-managed). Same checks as the window's sign-in; it goes only to the bundled CLI, for this
 * home's recorded loopback endpoint.
 */
async function localServiceStatusAuth(home: string): Promise<string | null> {
  if (ownedLaunch) return null;
  if ((await getDesktopSettingsStore().get()).daemon.commandCentreEnabled !== true) return null;
  const instance = await readDaemonInstance(home);
  const endpoint = instance ? ownedEndpoint(home, instance) : null;
  return (endpoint && (await localServiceAuth(endpoint))) || null;
}

async function desktopCommandCentreAuth(url: string): Promise<string | null | undefined> {
  // Decide endpoint scope before any owned-daemon I/O or fault can affect another host.
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(target.hostname))
    return undefined;
  if ((await getDesktopSettingsStore().get()).daemon.commandCentreEnabled !== true) {
    return undefined;
  }
  // L39: when this app launched no daemon for this home, the home's running service (e.g. launchd-managed) may be
  // the target. When it did, that owned daemon is this home's service, so any other endpoint is decided with no I/O.
  if (url !== ownedLaunch?.endpoint) return ownedLaunch ? undefined : localServiceAuth(url);
  const home = getPaseoHome();
  const before = await readDaemonInstance(home);
  const owner = ownedLaunch;
  if (owner && (owner.home !== home || !before || !isSameDaemonInstance(before, owner.instance))) {
    throw Error("Owned desktop daemon changed. Restart it from Settings.");
  }
  const password = await resolveOwnedAuth(url);
  if (password) {
    const after = await readDaemonInstance(home);
    if ((await getDesktopSettingsStore().get()).daemon.commandCentreEnabled !== true) {
      throw Error("Command Centre was disabled during authentication.");
    }
    if (!owner || ownedLaunch !== owner || !after || !isSameDaemonInstance(after, owner.instance)) {
      throw Error("Owned desktop daemon changed during authentication.");
    }
  }
  return password;
}

async function resolveDesktopStartupStatus(
  home: string,
  previousInstance: DaemonInstance | null,
): Promise<DesktopDaemonStatus> {
  // A first enable has no generated credential yet. Native local status can prove an
  // absent instance without authenticating; an auth/CLI failure cannot prove absence.
  let current: DesktopDaemonStatus;
  if (previousInstance) {
    current = await resolveDesktopDaemonStatus();
  } else {
    const payload = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      home,
      "--json",
    ]).catch(() => {
      throw retryOwnedDaemon("Desktop daemon local status unavailable; launch refused.");
    })) as Record<string, unknown>;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      payload.localDaemon !== "stopped" ||
      payload.connectedDaemon !== "not_probed" ||
      payload.pid != null ||
      payload.listen != null ||
      (await readDaemonInstance(home))
    )
      throw retryOwnedDaemon("Desktop daemon absence could not be verified; launch refused.");
    current = statusFromDaemonProbe(payload, home);
  }
  if (current.error || current.status === "errored")
    throw retryOwnedDaemon("Desktop daemon status unavailable; launch refused.");
  if (previousInstance && current.status === "stopped")
    throw retryOwnedDaemon("Desktop daemon changed during status observation; launch refused.");
  return current;
}

async function assertDesktopHomeAbsent(home: string): Promise<void> {
  if (getPaseoHome() !== home || (await readDaemonInstance(home)))
    throw retryOwnedDaemon("Desktop daemon changed before launch; launch refused.");
}

async function assertDesktopStopCompleted(
  home: string,
  stopped: DesktopDaemonStatus,
): Promise<void> {
  if (stopped.error || stopped.status !== "stopped")
    throw retryOwnedDaemon("Desktop daemon did not stop; launch refused.");
  await assertDesktopHomeAbsent(home);
}

// FULCRA(daemon-start-race): a daemon that is shutting down still reads "running" for a moment. On 8 Oct 2026 the
// MacBook app restarted 5 s after the old daemon got SIGTERM, saw the old supervisor still "running", started nothing,
// and showed "Connecting" after the old one exited. A running or starting daemon that does not answer is now
// awaited: when it answers it is used, when it exits a new one starts, and when it never answers within the wait an
// owned one is stopped and replaced. Only desktop-managed daemons are awaited. A daemon this app does not own is
// never stopped; when it never answers, the launch refuses (retryable).
export const DESKTOP_STARTUP_ANSWER_WAIT = { totalMs: 20_000, stepMs: 500 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function settleExistingDaemon(current: DesktopDaemonStatus): Promise<DesktopDaemonStatus> {
  if (
    (current.status !== "running" && current.status !== "starting") ||
    current.answering ||
    !current.desktopManaged
  )
    return current;
  logDesktopDaemonLifecycle("existing daemon does not answer; waiting", {
    status: current.status,
    pid: current.pid,
  });
  const deadline = Date.now() + DESKTOP_STARTUP_ANSWER_WAIT.totalMs;
  let latest = current;
  while (Date.now() < deadline) {
    await pause(DESKTOP_STARTUP_ANSWER_WAIT.stepMs);
    latest = await resolveDesktopDaemonStatus();
    if (latest.status === "stopped" || (latest.status === "running" && latest.answering)) {
      logDesktopDaemonLifecycle("existing daemon settled", { status: latest.status, pid: latest.pid });
      return latest;
    }
  }
  logDesktopDaemonLifecycle("existing daemon never answered; replacing it", { pid: latest.pid });
  const stopped = await stopDesktopDaemon("restart");
  if (stopped.status !== "stopped")
    throw retryOwnedDaemon("Desktop daemon is running but does not answer; launch refused.");
  return stopped;
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());

  const home = getPaseoHome();
  const previousInstance = await readDaemonInstance(home);
  if (
    !ownedLaunch &&
    previousInstance &&
    (await ownsCommandCentreSupervisor(getPaseoHome(), previousInstance))
  )
    ownedLaunch = {
      home: getPaseoHome(),
      instance: previousInstance,
      endpoint: ownedEndpoint(getPaseoHome(), previousInstance),
    };
  const initial = await resolveDesktopStartupStatus(home, previousInstance);
  logDesktopDaemonLifecycle("initial status check before start", {
    status: initial.status,
    pid: initial.pid,
    listen: initial.listen,
    serverId: initial.serverId || null,
    error: initial.error,
    desktopManaged: initial.desktopManaged,
    answering: initial.answering === true,
  });
  const current = await settleExistingDaemon(initial);
  if (current.status === "running" || current.status === "starting") {
    if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion: normalizeVersion(resolveDesktopAppVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await assertDesktopStopCompleted(home, await stopDesktopDaemon("version_mismatch"));
    } else {
      return current;
    }
  }

  const commandCentreEnabled =
    (await getDesktopSettingsStore().get()).daemon.commandCentreEnabled === true;
  const commandCentrePassword = await desktopCommandCentreCredential(true);
  const invocation = createNodeEntrypointInvocation({
    entrypoint: resolveDaemonRunnerEntrypoint(),
    argvMode: "node-script",
    args: [],
    baseEnv: process.env,
  });
  // Credential creation/readback is asynchronous: a new lifetime may have appeared.
  await assertDesktopHomeAbsent(home);
  let acquired: DaemonInstance | undefined;
  try {
    await startDaemonInstance({
      home,
      timeoutMs: 30_000,
      ...invocation,
      env: {
        ...invocation.env,
        // The worker uses persisted auth or the generated hash, never an ambient override.
        ...(commandCentreEnabled ? { PASEO_PASSWORD: undefined } : {}),
        PASEO_CLI: getBundledCliShimPath(),
        FULCRA_COMMAND_CENTRE: commandCentreEnabled ? "1" : "0",
        FULCRA_COMMAND_CENTRE_AUTH_HASH: commandCentrePassword
          ? hashDaemonPassword(commandCentrePassword)
          : undefined,
      },
      mode: "managed",
      desktopManaged: true,
      onAcquired: (instance) => {
        acquired = instance;
        ownedLaunch = { home, instance, endpoint: ownedEndpoint(home, instance) };
      },
    });
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) throw error;
  } finally {
    // Acquisition is ownership evidence even if readiness times out. Never save a foreign result.
    if (commandCentreEnabled && acquired) await saveCommandCentreOwner(home, acquired);
  }
  return resolveDesktopDaemonStatus();
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  confirmedInstance?: { pid: number; startedAt: string },
): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();
  const instance = await readDaemonInstance(home);
  if (!ownedLaunch && instance && (await ownsCommandCentreSupervisor(home, instance)))
    ownedLaunch = { home, instance, endpoint: ownedEndpoint(home, instance) };
  const owned = Boolean(
    instance &&
    ownedLaunch &&
    ownedLaunch.home === home &&
    isSameDaemonInstance(instance, ownedLaunch.instance),
  );
  const explicit =
    reason === "manual_ipc" &&
    confirmedInstance &&
    instance &&
    instance.pid === confirmedInstance.pid &&
    instance.startedAt === confirmedInstance.startedAt;
  if (confirmedInstance && !explicit)
    throw new Error(
      "Daemon changed since confirmation; inspect its current home and PID before stopping it.",
    );
  if (!instance || (!owned && !explicit)) return resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("stopping captured supervisor", { reason, pid: instance.pid, owned });
  await stopDaemonInstance(home, {
    instance,
    timeoutMs: 15_000,
    requestShutdown: async (ready) => {
      await runExternalCliJsonCommand(["daemon", "stop", "--host", ready.listen, "--json"]);
    },
  });
  if (owned) ownedLaunch = null;
  return resolveDesktopDaemonStatus();
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  return restartManagedDaemon({
    status: resolveDesktopDaemonStatus,
    stopOwned: () => stopDesktopDaemon("restart"),
    startManaged: startDaemon,
  });
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status", "--home", getPaseoHome()]);
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

async function resolveRequestedReleaseChannel(
  args: Record<string, unknown> | undefined,
): Promise<AppReleaseChannel> {
  return parseReleaseChannel(args) ?? (await getDesktopSettingsStore().get()).releaseChannel;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    ...createDesktopSettingsCommandHandlers({
      settingsStore: getDesktopSettingsStore(),
      onDaemonSettingsChanged: async () => {
        const stopped = await stopDesktopDaemon("settings");
        if (stopped.error || stopped.status === "errored")
          throw retryOwnedDaemon("Desktop daemon status unavailable; settings were not applied.");
        if (stopped.status === "running" || stopped.status === "starting") {
          // L39: a service this app does not own (e.g. launchd-managed) keeps running with its own configuration, so
          // there is nothing to restart. The setting is kept: it decides whether this window signs in to that
          // service as its local owner (localServiceOwnerCredential still checks home, endpoint and password).
          if (!ownedLaunch) {
            logDesktopDaemonLifecycle("command centre setting saved beside an unowned service", {
              pid: stopped.pid,
            });
            return;
          }
          throw Error(
            "This background service is managed elsewhere. Command Centre settings were not applied.",
          );
        }
        if ((await getDesktopSettingsStore().get()).daemon.manageBuiltInDaemon) await startDaemon();
      },
    }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_bundled_plugin_pins: () =>
      readBundledPluginPins(
        path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "bundled-plugins"),
      ),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    desktop_daemon_connection_check: async (args) => {
      if (typeof args?.url !== "string" || args.url.length > 2048)
        throw Error("Invalid connection target");
      try {
        if ((await desktopCommandCentreAuth(args.url)) === null)
          throw Error(
            "Command Centre authentication unavailable. Restart the service in Settings.",
          );
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "DESKTOP_DAEMON_RETRY")
          return { retry: true };
        throw error;
      }
      return true; // Never return a credential, even to this app's main world.
    },
    desktop_local_credential: async (args) => {
      const instance = await readDaemonInstance(getPaseoHome());
      if (!instance?.desktopManaged || typeof args?.listen !== "string") return null;
      return readLocalCredentialForTarget(getPaseoHome(), args.listen);
    },
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) =>
      stopDesktopDaemon(
        parseDesktopDaemonStopReason(args),
        typeof args?.pid === "number" && typeof args.startedAt === "string"
          ? { pid: args.pid, startedAt: args.startedAt }
          : undefined,
      ),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_sandbox_diagnostics: () =>
      describeSandbox({
        disabled: app.commandLine.hasSwitch("no-sandbox"),
        launcherReason: process.env.PASEO_DESKTOP_SANDBOX_REASON,
      }),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_update_diagnostics: () => getDesktopUpdaterDiagnostics(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => await openLocalTransportSession(args),
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    check_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return checkForAppUpdate({
        currentVersion,
        releaseChannel: await resolveRequestedReleaseChannel(args),
        intent: parseAppUpdateCheckIntent(args),
      });
    },
    install_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return downloadAndInstallUpdate(
        { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
        async () => {
          await stopDesktopDaemon("app_update");
        },
      );
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    // Device key (CONTRACTS §3.6): the private key stays in this process.
    device_status: () => getElectronDeviceKey().status(),
    device_pair: (args) => getElectronDeviceKey().pair(args ?? {}),
    device_sign: (args) => getElectronDeviceKey().sign(args),
    ...createRelayIdentityCommandHandlers(),
    read_legacy_skill_selection: () => readLegacySkillSelection(),
    delete_legacy_skill_selection: () => deleteLegacySkillSelection(),
  };
}

export function registerDaemonManager(): void {
  const handlers = createDaemonCommandHandlers();

  ipcMain.handle(
    "paseo:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}

const commandCentreWindows = new Set<WebContents>();
const commandCentreSessions = new WeakSet<ElectronSession>();
export function registerCommandCentreWindow(contents: WebContents): void {
  commandCentreWindows.add(contents);
  contents.once("destroyed", () => commandCentreWindows.delete(contents));
  if (commandCentreSessions.has(contents.session)) return;
  commandCentreSessions.add(contents.session);
  contents.session.webRequest.onBeforeSendHeaders(
    { urls: ["ws://127.0.0.1/*", "ws://[::1]/*"] },
    ownedDaemonHeaders(commandCentreWindows, desktopCommandCentreAuth),
  );
}
