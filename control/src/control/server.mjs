import { HostNative } from "./host-native.mjs";
import { createWorktreeLifecycle } from "./worktree-lifecycle-runtime.mjs";
import { worktreeLifecycleSettings } from "../config.mjs";
import fs from "node:fs";
import { readCredential } from "./credential.mjs";
import net from "node:net";
import { socketLocation, prepareSocketLocation } from "./socket-location.mjs";
import { acquireProcessLock } from "./process-lock.mjs";
import { randomBytes } from "node:crypto";
import { rpc, RPC_METHODS, managementDispatcher } from "./rpc.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Events } from "./events.mjs";
import { Manager } from "./manager.mjs";
import { Leadership } from "./leadership.mjs";
import { Permissions } from "./permissions.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels } from "./role-channels.mjs";
import { RoleSessions } from "./role-sessions.mjs";
import { Trackers } from "./trackers.mjs";
import { ToolSurfaces } from "./tool-refresh.mjs";
import { UsageLimits } from "./usage-limits.mjs";
import { Wakes } from "./wakes.mjs";
import { Questions } from "./questions.mjs";
import { CompactionLoops } from "./compaction-loops.mjs";
import { ProviderRecovery } from "./provider-recovery.mjs";
import { AutomaticRestarts } from "./automatic-restart.mjs";
import { Decisions } from "./decisions.mjs";
import { Environments } from "./environments.mjs";
import { Devices } from "./devices.mjs";
import { InboxChannels } from "./inbox-channels.mjs";
import { Remits } from "./remits.mjs";
import { Briefs } from "./briefs.mjs";
import { CcTrackers } from "./cc-trackers.mjs";
import { CcLinks } from "./cc-links.mjs";
import { InstructionAllowanceExhausted } from "./allowance.mjs";
import { operatorConnection } from "./operator-connection.mjs";
import { connectNative, HOME } from "./native.mjs";
import { sweepSeats } from "./seat-sweep.mjs";
import { macHeldNotifier, macLimitNotifier } from "./held-notifier.mjs";
import { bootChainDir } from "./boot-chain.mjs";
import { MetricsLog, instrumentDb, timedDispatch, startLoopSampler } from "./metrics.mjs";
import { closeWithin } from "./native-close.mjs";
// The SSH Book transport is retired (0.2.7): the controller never starts a remote receiver. A leftover
// <ORCA_HOME>/book-transport.json is ignored, and Book creations are refused as "not configured".
export const BOOK_RETIRED = Object.freeze({ configured: false, status: "Book transport retired" });
export function bookTransport(_home) {
  return { bookStatus: { ...BOOK_RETIRED } };
}
// V4 supplies the host-owned channel after its child/epoch handshake. No password bootstrap.
export async function startController({
  daemon,
  issueProvenance,
  registerManagement,
  epoch,
  getHandshakeBoot,
  requestReport,
} = {}) {
  if (
    !daemon ||
    typeof getHandshakeBoot !== "function" ||
    typeof issueProvenance !== "function" ||
    typeof registerManagement !== "function"
  )
    throw Error("Authenticated controller channel unavailable");
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(HOME) !== HOME) throw new Error("Control home contains symlink");
  fs.chmodSync(HOME, 0o700);
  const releaseProcessLock = acquireProcessLock(HOME, { epoch });
  process.once("exit", releaseProcessLock);
  // The trusted plugin owns process supervision.
  // H6 item 3: timestamped, bounded controller log (per-RPC timings, 30 s event-loop delay). Every line this process
  // writes goes through it, so after a rotation nothing is left writing into the renamed file.
  const log = new MetricsLog(),
    counter = { rpcs: 0 };
  const socket = socketLocation(HOME).socket;
  if (fs.existsSync(socket))
    throw new Error("Socket already exists; verify the prior owner before recovering it");
  const local = await connectNative({ daemon, issueProvenance, getHandshakeBoot }),
    store = instrumentDb(new ControlStore(`${HOME}/journal.sqlite`)),
    native = new HostNative({ store, local, ...bookTransport(HOME) }),
    control = new Controller({ store, native, bootChainDir: bootChainDir(HOME) });
  let closing = false;
  if (typeof requestReport === "function") control.reportInbox = { request: requestReport };
  control.events = new Events(control);
  control.manager = new Manager(control);
  control.permissions = new Permissions(control);
  control.leadership = new Leadership(control);
  control.bindings = new Bindings(control);
  control.channels = new RoleChannels(control);
  control.humanNotifier = macHeldNotifier(); // G6: a message held for a human-held prime notifies the human (metadata only)
  control.roleSessions = new RoleSessions(control);
  control.trackers = new Trackers(control);
  control.tools = new ToolSurfaces(control); // H6 item 5
  control.usageLimits = new UsageLimits(control); // H6 item 6: Claude usage-limit auto-resume
  control.limitNotifier = macLimitNotifier();
  control.wakes = new Wakes(control); // H7 items 1-2: owned sessions wake their seat; the idle-seat heartbeat
  control.questions = new Questions(control); // H7 item 5: a seat's reply answers its worker's pending question
  control.compactionLoops = new CompactionLoops(control, { home: HOME });
  control.providerRecovery = new ProviderRecovery(control); // H7 items 3-4: Codex auth/quota and failed-refresh restarts in place
  control.devices = new Devices(control); // Fulcra §3.6: paired devices, the only proof of the owner. First-device pairing is a compiled release constant plus the host's own device flag (v1.13 R3-1): no file turns it on
  control.inboxChannels = new InboxChannels(control); // J3b: one inbox, any channel
  control.decisions = new Decisions(control); // Fulcra J3: decision packets, the inbox and the daily digest. Its pump is
  // started, never awaited, below: single-flight and throttled inside, so it cannot hold up the event-refresh chain.
  control.remits = new Remits(control); // Fulcra J1: which prime owns which project (CONTRACTS §5)
  control.briefs = new Briefs(control); // Fulcra J1: project stories written by orchestrators (CONTRACTS §4)
  control.ccTrackers = new CcTrackers(control); // Fulcra J4: many tracker mappings per project, persisted observations
  control.ccLinks = new CcLinks(control); // Fulcra J4: links with provenance (CONTRACTS §2.2)
  control.environments = new Environments(control); // Fulcra J8: environments and promotions; registers its binders with the decision store
  control.worktreeLifecycle = createWorktreeLifecycle(control, HOME, {
    settings: worktreeLifecycleSettings({ ORCA_HOME: HOME }),
  });
  native.attach(control);
  control.automaticRestarts = new AutomaticRestarts(control, {
    currentBoot: () => local.currentBoot(),
  });
  // Capture interrupted original delegations before the optional seat sweep re-pins their boots.
  void control.automaticRestarts.tick();
  let lifecyclePass = null;
  const cleanFinishedJobs = () => {
    if (!closing && !lifecyclePass)
      lifecyclePass = control.worktreeLifecycle
        .automatic()
        .catch(() =>
          log.line({ worktreeLifecycle: "Inspection or cleanup failed; files retained" }),
        )
        .finally(() => {
          lifecyclePass = null;
        });
  };
  const lifecycleTimer = setInterval(cleanFinishedJobs, 60000);
  lifecycleTimer.unref();
  cleanFinishedJobs();
  // Stage 2 seat sweep (STAGE2-DESIGN.md s3.2). Off unless the prime writes the mode file. Its first pass runs
  // HERE, before the socket listens and before any pump, so nothing can race it; the watchdog below repeats
  // it so a daemon-only restart is also swept. It never throws and never delays startup on a fault.
  let sweeping = null;
  const sweep = () =>
    (sweeping = Promise.resolve(control.automaticRestarts.ticking)
      .then(() => sweepSeats(control, { home: HOME, currentBoot: () => local.currentBoot() }))
      .then((out) => {
        if (out.results.length || (out.mode !== "off" && out.reason)) log.line({ seatSweep: out });
      })
      .catch((e) => console.error("Orca seat sweep:", e.message)));
  // Review F3: a hung native call must not hold the control socket closed. After the deadline startup continues
  // and the pass completes under exclusive() exactly as a watchdog pass would (DESIGN.md s3.3: both orders safe).
  await Promise.race([sweep(), new Promise((resolve) => setTimeout(resolve, 60000).unref())]);
  const onEventError = (error) => {
    control.events.lastError = { message: error.message, at: new Date().toISOString() };
    console.error("Orca event observer:", error.message);
  };
  let refreshingEvents = null,
    eventDirty = false,
    eventsReady = false;
  const refreshEvents = () => {
    if (closing) return Promise.resolve();
    eventDirty = true;
    if (!eventsReady) return Promise.resolve();
    return (refreshingEvents ??= (async () => {
      do {
        eventDirty = false;
        void control.remits.refresh().catch(onEventError);
        void native.reconcile();
        await control.leadership.pump();
        await control.permissions.verifyPending();
        for (const grant of control.permissions.rows())
          await control.permissions.reconcile(grant.session);
        for (const link of control.events.links()) await control.events.reconcile(link.worker);
        await control.events.pump();
        await control.channels.pump();
        await control.roleSessions.pump();
        await control.wakes.pump();
        await control.quota.pump();
        await control.recovery.reconcile();
        await control.tools.reconcile();
        void control.decisions.pump();
        void control.environments.pump();
      } while (eventDirty && !closing);
    })()
      .catch(onEventError)
      .finally(() => {
        refreshingEvents = null;
      }));
  };
  const eventSignatures = new Map();
  const unsubscribeEvents = native.subscribe((a) => {
    const links = control.events.links();
    if (
      !links.some((l) => l.worker === a.id || l.supervisor === a.id) &&
      !control.permissions.grantRow(a.id) &&
      !control.leadership.interested(a.id) &&
      !control.channels.interested(a.id) &&
      !control.roleSessions.interested(a.id) &&
      !control.wakes.interested(a.id) &&
      !control.quota.interested(a.id)
    )
      return;
    const signature = JSON.stringify([
      a.status,
      a.lastUserMessageAt,
      a.activeTurn,
      a.pendingPermissions,
      a.lastError,
      a.archivedAt,
    ]);
    if (eventSignatures.get(a.id) === signature) return;
    eventSignatures.set(a.id, signature);
    void refreshEvents();
  });
  let eventWatchdog;
  const operations = new Set();
  const operatorPath = `${HOME}/operator.secret`;
  if (!fs.existsSync(operatorPath))
    fs.writeFileSync(operatorPath, randomBytes(32).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  const operator = readCredential(operatorPath);
  const dispatch = timedDispatch(
    rpc(control, operator, { allowOperatorWrites: false }),
    log,
    counter,
    RPC_METHODS,
  );
  const unregisterManagement = registerManagement(managementDispatcher(control));
  // Merge (cc/v02-cutover-control): the live lineage's one-request-per-connection protocol and request timeout
  // (operator-connection.mjs, Track 1 2fbca3ee) replaces V4's inline handler; V4's read-only operator lane is kept.
  const server = net.createServer(
    operatorConnection({
      dispatch,
      operations,
      errorFields: (e) => (e instanceof InstructionAllowanceExhausted ? { code: e.code } : {}),
    }),
  );
  prepareSocketLocation(HOME);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve(undefined));
  });
  fs.chmodSync(socket, 0o600);
  eventsReady = true;
  log.line({ ready: true, socket, pid: process.pid, log: log.rotating ? "rotating" : "stdout" });
  const stopLoopSampler = startLoopSampler(log, counter);
  async function stop() {
    if (closing) return;
    closing = true;
    unregisterManagement?.();
    control.closing = true;
    server.close();
    clearInterval(eventWatchdog);
    clearInterval(lifecycleTimer);
    unsubscribeEvents();
    unsubscribeLimits();
    await Promise.allSettled([
      ...operations,
      lifecyclePass,
      control.worktreeLifecycle.stop(),
      refreshingEvents,
      sweeping,
      control.events.pumping,
      control.leadership.pumping,
      control.channels.pumping,
      control.roleSessions.pumping,
      control.quota.pumping,
      control.usageLimits.ticking,
      control.wakes.pumping,
      control.wakes.ticking,
      control.providerRecovery.ticking,
      control.compactionLoops.stop(),
      control.automaticRestarts.stop(),
      control.decisions.pumping,
      control.remits.refreshing,
      control.environments.pumping,
      control.environments.stop(),
      native.reconciling,
    ]);
    if (!(await closeWithin(() => native.close()))) log.line({ nativeCloseDeadline: true });
    store.close();
    stopLoopSampler();
    log.line({ stopped: true });
    log.close();
    process.exit(0);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await native.watch();
  // C2 #5: title the workspaces of existing sessions once, in the background. Cosmetic; a failure is only logged.
  native.nameWorkspaces?.(store.list().map((r) => r.id)).then(
    (r) => log.line({ workspaceTitles: r }),
    (e) => log.line({ workspaceTitlesError: String(e?.message ?? e) }),
  );
  await refreshEvents();
  // H6 item 6: a Claude session of ours that goes idle is checked for a usage-limit stop; stops already present at
  // startup (a controller restarted during the wait) are found by one bounded pass over delegated sessions.
  const unsubscribeLimits = native.subscribe((a) => {
    void control.usageLimits.onAgent(a);
    void control.wakes.onAgent(a);
    void control.providerRecovery.onAgent(a);
    void control.compactionLoops.onAgent(a);
    void control.automaticRestarts.tick();
  });
  for (const { id } of store.db
    .prepare("SELECT id FROM sessions WHERE mode='delegated' ORDER BY rowid DESC LIMIT 64")
    .all())
    await control.usageLimits.observe(id);
  // Merge: the live lineage's H7 wake and provider-recovery ticks. Its daemon-listener witness (Stage 2 F1) is NOT carried
  // over: it inspects an unverified separate listener and disarms the LEGACY file-guard human-input chain; the owned child
  // is spawned by its verified daemon over the boot handshake, and V4's human-input fencing is native to that daemon
  // (V4 removed it; seat-sweep.test.mjs L12 asserts listener inspection is not packaged authority).
  eventWatchdog = setInterval(() => {
    void native
      .watch()
      .then(() => sweep())
      .then(refreshEvents)
      .catch(onEventError);
    void control.usageLimits.tick();
    void control.wakes.tick();
    void control.providerRecovery.tick();
    void control.compactionLoops.tick();
    void control.automaticRestarts.tick();
  }, 30000);

  return { stop, control };
}
