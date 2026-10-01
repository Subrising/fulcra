import { takeOverSession } from "./session-takeover.mjs";
import { poolRoot } from "./account-rotation.mjs";
import { managementRefusal } from "./management-refusal.mjs";
import { parseControllerCommand, READ_METHODS } from "./command-parser.mjs";
import { operatorArtifacts } from "./artifacts.mjs";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { requireManagementPrincipal } from "./management-principal.mjs";
import { hash } from "./store.mjs";
import { uuid } from "./authority.mjs";
import { sessionDefaults, REFUSED, configuredDefaults } from "./provider-mode.mjs";
import {
  readRoleDefaults,
  DEFAULT_ROLES,
} from "../../orca-organization/server/role-defaults-store.mjs";
import { settingsStatus, installationConfig } from "./installation-settings.mjs";
import { quotaStatus } from "./quota-status.mjs";
import { activityReceipts } from "./activity-receipts.mjs";
import { AUTOMATION_LIMIT } from "./journal-capacity.mjs";
import { APP_VIA } from "../../orca-organization/shared/cc/decision-rules.mjs";
const trackers = (control) => {
  if (!control.trackers) throw Error("Issue trackers are not constructed in this controller");
  return control.trackers;
};
// REVIEW-H6 F2: the closed set of method names this dispatcher answers. The metrics log records a method only if it
// is in this set (anything else is 'unknown'), so no caller-chosen string reaches controller.log. rpc-methods.test
// holds it equal to the literals below.
export const RPC_METHODS = Object.freeze(
  new Set([
    "worktree-lifecycle-preview",
    "worktree-lifecycle-apply",
    "worktree-lifecycle-retention",
    "activity-receipts",
    "bindings-activation",
    "bindings-assign",
    "bindings-grant",
    "bindings-project",
    "bindings-route",
    "bindings-self",
    "bindings-status",
    "bindings-unassign",
    "book-activity",
    "book-activity-page",
    "briefs-read",
    "cc-channel-pair",
    "cc-channel-pair-open",
    "cc-channel-pause",
    "cc-channel-resume",
    "cc-channel-revoke",
    "cc-channels-list",
    "cc-inbox-answer",
    "cc-inbox-list",
    "cc-inbox-posted",
    "cc-inbox-show",
    "cc-inbox-updated",
    "cc-inbox-updates",
    "cc-link-history",
    "cc-links-for",
    "cc-links-observe",
    "cc-links-remove",
    "cc-links-set",
    "cc-tracker-import-legacy",
    "cc-tracker-items",
    "cc-tracker-items-put",
    "cc-tracker-legacy-pending",
    "cc-tracker-map",
    "cc-tracker-mapping-history",
    "cc-tracker-mappings",
    "cc-tracker-unmap",
    "channels-close",
    "channels-close-seat",
    "channels-list",
    "channels-open",
    "channels-read",
    "channels-request",
    "channels-request-decline",
    "channels-requests",
    "channels-send",
    "channels-status",
    "channels-thread",
    "create",
    "decisions-choose",
    "decisions-digest",
    "decisions-digest-run",
    "decisions-get",
    "decisions-record-review",
    "decisions-held-message",
    "decisions-inbox",
    "devices-list",
    "devices-pair-approve",
    "devices-pair-complete",
    "devices-pair-open",
    "devices-revoke",
    "disposition",
    "environments-propose",
    "environments-view",
    "events-ack",
    "events-attach",
    "events-inbox",
    "events-resume",
    "events-status",
    "handback",
    "history",
    "ingress-ack",
    "ingress-prepare",
    "ingress-result",
    "ingress-send",
    "inspect",
    "leadership-status",
    "leadership-transfer",
    "list",
    "management-ack",
    "management-prepare",
    "manager-assign",
    "manager-create",
    "manager-grant",
    "manager-inspect",
    "manager-promote",
    "manager-resume",
    "manager-summary",
    "manager-workers",
    "notify-ack",
    "notify-assign",
    "notify-claim",
    "notify-prepare",
    "notify-read",
    "notify-wait",
    "observe",
    "operator-artifacts",
    "operator-send",
    "operator-native-queue",
    "permissions-grant",
    "permissions-revoke",
    "permissions-status",
    "prepare-send",
    "promotions-cancel",
    "promotions-create",
    "quota-status",
    "recover",
    "recovery-status",
    "reestablish",
    "remits-assign",
    "remits-domain-set",
    "remits-end",
    "remits-list",
    "remits-move",
    "result",
    "roles-accept-session",
    "roles-adopt",
    "roles-allowance-set",
    "roles-allowances",
    "roles-brief-publish",
    "roles-create-session",
    "roles-decision-ask",
    "roles-decision-status",
    "roles-decision-withdraw",
    "roles-decline-session",
    "roles-environment-propose",
    "roles-environments",
    "roles-inspect-session",
    "roles-job-directory",
    "roles-ownership",
    "roles-promotion-ask",
    "roles-promotion-create",
    "roles-request-session",
    "roles-send-session",
    "roles-session-requests",
    "roles-sessions",
    "seat-hold",
    "seat-inbox",
    "seat-receipt",
    "seat-reply",
    "seat-reply-reconcile",
    "seat-unhold",
    "send",
    "session-takeover",
    "session-defaults",
    "session-interruption-dismiss",
    "session-resume",
    "session-resume-batch",
    "sessions-refresh-tools",
    "sessions-tool-surface",
    "takeover",
    "task-allowance",
    "task-allowance-set",
    "task-authority",
    "task-index",
    "trackers-directory",
    "trackers-history",
    "trackers-link",
    "trackers-links-for",
    "trackers-map",
    "trackers-project",
    "trackers-status",
    "trackers-unlink",
    "trackers-unmap",
    "wakes-heartbeat-set",
    "wakes-status",
  ]),
);
const devices = (control) => {
  if (!control.devices) throw Error("Paired devices are not constructed in this controller");
  return control.devices;
};
// Track 1b: a management read takes no input (everything, as before) or exactly {taskId}.
const taskScope = (a, what) => {
  if (a == null) return undefined;
  if (!a || typeof a !== "object" || Object.keys(a).join() !== "taskId" || !uuid(a.taskId))
    throw Error(`${what} takes no input or {taskId}`);
  return a.taskId;
};
// The Fulcra app's handoff filter (management.ts), applied here: source, destination and every worker in the task. Applied to
// the same global top-20 the unscoped read returns, so a scoped read equals the unscoped read filtered.
const scopeHandoffs = (control, handoffs, taskId) =>
  taskId === undefined
    ? handoffs
    : handoffs.filter((h) =>
        [h.source, h.destination, ...h.workers].every(
          (id) => control.store.get(id)?.task === taskId,
        ),
      );
const inboxChannels = (control) => {
  if (!control.inboxChannels) throw Error("Inbox channels are not constructed in this controller");
  return control.inboxChannels;
};
const remits = (control) => {
  if (!control.remits) throw Error("Remits are not constructed in this controller");
  return control.remits;
};
const briefs = (control) => {
  if (!control.briefs) throw Error("Project briefs are not constructed in this controller");
  return control.briefs;
};
const decisions = (control) => {
  if (!control.decisions) throw Error("The decision inbox is not constructed in this controller");
  return control.decisions;
};
const ccTrackers = (control) => {
  if (!control.ccTrackers) throw Error("Tracker connectors are not constructed in this controller");
  return control.ccTrackers;
};
const ccLinks = (control) => {
  if (!control.ccLinks) throw Error("Links are not constructed in this controller");
  return control.ccLinks;
};
const environments = (control) => {
  if (!control.environments) throw Error("Environments are not constructed in this controller");
  return control.environments;
};
// DESIGN-NEXT-BUILD A4 (C10): per role, what is configured, what a creation would actually launch on this host, and
// whether the installed provider offers it ('offered' | 'falls-back' | 'unknown' when no capability check is reachable).
async function roleDefaultsTable(control) {
  // Update-7: the persisted table (Settings -> Accounts & Defaults) over the shared config's roles, all five roles.
  const config = installationConfig(),
    roles = config?.home
      ? readRoleDefaults(config.home, configuredDefaults(config).roles ?? null).roles
      : (configuredDefaults(config).roles ?? {}),
    out = {};
  for (const role of DEFAULT_ROLES) {
    const entry = roles[role];
    if (!entry) continue;
    const row = { provider: entry.provider ?? null, providers: {} };
    for (const provider of ["claude", "codex"]) {
      if (!Object.hasOwn(entry, provider)) continue;
      let checked = null;
      try {
        checked = (await control.native?.roleCapability?.(provider, role)) ?? null;
      } catch (e) {
        checked = { error: e.message };
      }
      row.providers[provider] = checked?.effective
        ? {
            configured: checked.configured,
            effective: checked.effective,
            status: checked.fallback.length ? "falls-back" : "offered",
            fallback: checked.fallback,
          }
        : {
            configured: entry[provider],
            effective: null,
            status: "unknown",
            ...(checked?.error ? { error: checked.error } : {}),
          };
    }
    out[role] = row;
  }
  return out;
}
export function rpc(control, operator, { allowOperatorWrites = true } = {}) {
  return async (request) => {
    if (
      !request ||
      Object.keys(request).some(
        (k) => !["method", "input", "capability", "operator", "read"].includes(k),
      )
    )
      throw new Error("Invalid controller envelope");
    if (Object.hasOwn(request, "read")) throw Error("Anonymous read lane unavailable");
    // Separate credential domain BEFORE all ordinary endpoint/leadership/operator dispatch.
    if (typeof request.capability === "string" && request.capability.startsWith("report1.")) {
      if (
        Object.hasOwn(request, "operator") ||
        !["events-inbox", "events-ack"].includes(request.method) ||
        !control.reportInbox ||
        typeof control.reportInbox.request !== "function"
      )
        throw Error("Report credential cannot authorize this endpoint");
      return control.reportInbox.request(request);
    }
    const a = request.input;
    if (request.method === "manager-workers") return control.manager.workers(a, request.capability);
    if (request.method === "manager-create") return control.manager.create(a, request.capability);
    if (request.method === "manager-inspect") return control.manager.inspect(a, request.capability);
    if (request.method === "manager-assign") return control.manager.assign(a, request.capability);
    if (request.method === "events-inbox") {
      if (!a || Object.keys(a).join() !== "sessionId") throw Error("Invalid inbox input");
      return control.events.inbox(a.sessionId, request.capability);
    }
    if (request.method === "bindings-self") {
      if (!a || Object.keys(a).join() !== "sessionId") throw Error("Invalid role read");
      return control.bindings.self(a.sessionId, request.capability);
    }
    if (request.method === "channels-list") {
      if (!a || Object.keys(a).join() !== "sessionId") throw Error("Invalid channel read");
      return control.channels.list(a.sessionId, request.capability);
    }
    if (request.method === "channels-send") return control.channels.send(a, request.capability);
    if (request.method === "channels-thread") return control.channels.thread(a, request.capability);
    if (request.method === "channels-read") return control.channels.read(a, request.capability);
    if (request.method === "channels-request")
      return control.channels.request(a, request.capability);
    if (request.method === "roles-create-session")
      return control.roleSessions.create(a, request.capability);
    if (request.method === "roles-job-directory")
      return control.roleSessions.jobDirectory(a, request.capability);
    if (request.method === "channels-close-seat")
      return control.channels.closeBySeat(a, request.capability);
    if (request.method === "roles-accept-session")
      return control.roleSessions.accept(a, request.capability);
    if (request.method === "roles-decline-session")
      return control.roleSessions.decline(a, request.capability);
    if (request.method === "roles-inspect-session")
      return control.roleSessions.inspectOwned(a, request.capability);
    if (request.method === "roles-send-session")
      return control.roleSessions.sendOwned(a, request.capability);
    // Fulcra J3 decision packets (CONTRACTS §3.3), role lane: the asker is derived from the role grant.
    if (request.method === "roles-decision-ask")
      return decisions(control).ask(a, request.capability);
    if (request.method === "roles-decision-status")
      return decisions(control).status(a, request.capability);
    if (request.method === "roles-decision-withdraw")
      return decisions(control).withdraw(a, request.capability);
    // Fulcra J8 Environments (CONTRACTS §6), role lane: a seated session proposes; the owner approves on a paired
    // device. Its grant is the asker. Nothing on this lane runs a promotion: running follows a chosen approval only.
    if (request.method === "roles-environments") {
      if (!a || Object.keys(a).sort().join() !== "projectId,sessionId")
        throw Error("Invalid environments read");
      environments(control).actorFor(
        { kind: "role", capability: request.capability },
        a.sessionId,
        a.projectId,
      );
      return environments(control).view(a.projectId);
    }
    if (request.method === "roles-environment-propose")
      return environments(control).propose(a, { kind: "role", capability: request.capability });
    if (request.method === "roles-promotion-create")
      return environments(control).promotionCreate(a, {
        kind: "role",
        capability: request.capability,
      });
    if (request.method === "roles-promotion-ask")
      return environments(control).promotionAsk(a, {
        kind: "role",
        capability: request.capability,
      });
    // J3b channels (CONTRACTS §3.5). A paired channel's own capability scopes every call; completing a pairing is
    // authorized by the one-time code alone. None of these can reach the operator methods below.
    if (request.method === "cc-channel-pair") return inboxChannels(control).completePairing(a);
    if (request.method === "cc-inbox-list")
      return inboxChannels(control).listFor(a, request.capability);
    if (request.method === "cc-inbox-show")
      return inboxChannels(control).showFor(a, request.capability);
    if (request.method === "cc-inbox-answer")
      return inboxChannels(control).answerFor(a, request.capability);
    if (request.method === "cc-inbox-posted")
      return inboxChannels(control).postedFor(a, request.capability);
    if (request.method === "cc-inbox-updates")
      return inboxChannels(control).updatesFor(a, request.capability);
    if (request.method === "cc-inbox-updated")
      return inboxChannels(control).updatedFor(a, request.capability);
    // Fulcra J1 project brief (CONTRACTS §4.2), role lane: the author is derived from the role grant and must be
    // the project's orchestrator or its owning prime.
    if (request.method === "roles-brief-publish")
      return briefs(control).publish(a, request.capability);
    if (request.method === "roles-sessions") {
      if (!a || Object.keys(a).join() !== "sessionId") throw Error("Invalid owned session read");
      return control.roleSessions.mine(a.sessionId, request.capability);
    }
    if (request.method === "events-ack") return control.events.acknowledge(a, request.capability);
    if (request.method === "ingress-prepare") return control.ingress.prepare(a, request.capability);
    if (request.method === "ingress-send") return control.ingress.send(a, request.capability);
    if (request.method === "ingress-ack") return control.ingress.acknowledge(a, request.capability);
    if (request.method === "ingress-result") return control.ingress.result(a, request.capability);
    if (request.method === "send") return control.send(a, request.capability);
    if (request.method === "result") return control.result(a, request.capability);
    const notificationMethods = {
      "notify-prepare": "prepare",
      "notify-read": "read",
      "notify-assign": "assign",
      "notify-ack": "acknowledge",
      "notify-claim": "claim",
      "notify-wait": "wait",
    };
    if (Object.hasOwn(notificationMethods, request.method))
      return control.notifications[notificationMethods[request.method]](a, request.capability);
    if (request.method === "prepare-send") {
      if (
        !a ||
        Object.keys(a).sort().join() !== "messageId,sessionId,text" ||
        typeof a.text !== "string" ||
        !a.text.trim() ||
        Buffer.byteLength(a.text) > 16384
      )
        throw Error("Invalid scoped preparation");
      const row = control.store.check(a.sessionId, request.capability);
      return control.prepareManagement(
        "send",
        { sessionId: row.id, expectedGeneration: row.generation, text: a.text.trim() },
        a.messageId,
        true,
      );
    }
    if (request.method === "inspect") {
      control.store.check(a, request.capability);
      return control.inspect(a);
    }
    if (
      !timingSafeEqual(
        Buffer.from(hash(typeof request.operator === "string" ? request.operator : "")),
        Buffer.from(hash(operator)),
      )
    )
      throw new Error("Operator authorization required");
    if (!allowOperatorWrites && !READ_METHODS.includes(request.method))
      throw Error("Host management channel required");
    switch (request.method) {
      case "operator-artifacts":
        return operatorArtifacts(control, a);
      case "quota-status":
        if (a != null) throw Error("Quota status takes no input");
        return quotaStatus(control.store);
      case "task-allowance":
        return control.allowance.status(a);
      case "task-allowance-set":
        return control.allowance.set(a);
      case "permissions-grant":
        return control.permissions.grant(a);
      case "permissions-revoke":
        return control.permissions.revoke(a);
      // Track 1b: optional {taskId} on the three management reads (the Fulcra app shows one task); no input = all, as before.
      case "permissions-status":
        return {
          grants: control.permissions.statusMany(taskScope(a, "Status")),
          error: control.permissions.lastError ?? null,
        };
      case "leadership-transfer":
        return control.leadership.transfer(a);
      case "leadership-status": {
        const taskId = taskScope(a, "Status");
        return {
          handoffs: scopeHandoffs(control, control.leadership.summary(), taskId),
          candidates:
            taskId === undefined
              ? control.leadership.candidates()
              : control.leadership
                  .candidates()
                  .filter((id) => control.store.get(id)?.task === taskId),
          capacity: {
            handoffs: control.store.db.prepare("SELECT count(*) n FROM leadership_handoffs").get()
              .n,
            deliveries: control.store.db.prepare("SELECT count(*) n FROM deliveries").get().n,
            transferAllowed:
              control.store.db.prepare("SELECT count(*) n FROM deliveries").get().n <
                AUTOMATION_LIMIT - 1 &&
              control.store.db.prepare("SELECT count(*) n FROM leadership_handoffs").get().n < 1000,
          },
          error: control.leadership.lastError ?? null,
        };
      }
      case "bindings-assign":
        return control.bindings.assign(a);
      case "bindings-unassign":
        return control.bindings.unassign(a);
      case "bindings-status":
        if (a != null) throw Error("Status takes no input");
        return { ...control.bindings.directory(), error: control.bindings.lastError ?? null };
      case "bindings-project":
        if (!uuid(a)) throw Error("Invalid project");
        return control.bindings.projection(a);
      case "bindings-route":
        return control.bindings.route(a);
      case "bindings-grant":
        return control.bindings.grantRole(a);
      // H6 item 5: bring a session's Orca tool surface to this release's (fenced daemon refresh; grants nothing).
      case "sessions-refresh-tools":
        if (
          !a ||
          Object.keys(a).sort().join() !== "expectedGeneration,sessionId" ||
          !Number.isSafeInteger(a.expectedGeneration)
        )
          throw Error("Invalid tool refresh");
        if (!control.tools) throw Error("Tool surfaces are not available in this controller");
        return control.tools.refresh(a.sessionId, { expectedGeneration: a.expectedGeneration });
      case "sessions-tool-surface":
        if (!a || Object.keys(a).join() !== "sessionId" || !uuid(a.sessionId))
          throw Error("Invalid tool surface read");
        if (!control.tools) throw Error("Tool surfaces are not available in this controller");
        return { sessionId: a.sessionId, ...control.tools.describe(a.sessionId) };
      case "bindings-activation":
        if (a != null) throw Error("Activation takes no input");
        return control.bindings.activation();
      // DESIGN-E option H. Operator-gated, and deliberately absent from the capability-reachable methods above:
      // a seat must never be able to declare itself human-held, nor speak through the operator path.
      case "seat-hold":
        return control.bindings.hold(a);
      case "seat-unhold":
        return control.bindings.unhold(a);
      case "seat-inbox":
        return control.channels.inbox(a);
      case "seat-receipt":
        return control.channels.seatReceipt(a);
      case "seat-reply":
        return control.channels.seatReply(a);
      case "seat-reply-reconcile":
        return control.channels.reconcileReply(a);
      // DESIGN-R R1. Operator-gated like handback: a session must never be able to resume itself or another one.
      case "recovery-status":
        if (a != null) throw Error("Recovery status takes no input");
        return control.recovery
          .status()
          .then((v) => ({
            ...v,
            usageLimits: control.usageLimits?.status() ?? null,
            wakes: control.wakes?.status() ?? null,
            providerRecovery: control.providerRecovery?.status() ?? null,
          }));
      // H7 items 1-2: owned-session wakes and the idle-seat heartbeat (wakes.mjs). Operator only.
      case "wakes-status":
        if (a != null) throw Error("Wake status takes no input");
        if (!control.wakes) throw Error("Wakes are not constructed in this controller");
        return control.wakes.status();
      case "wakes-heartbeat-set":
        if (!control.wakes) throw Error("Wakes are not constructed in this controller");
        return control.wakes.setHeartbeat(a);
      case "session-resume":
        return control.recovery.resume(a);
      case "session-resume-batch":
        return control.recovery.resumeBatch(a);
      case "session-interruption-dismiss":
        return control.recovery.dismiss(a);
      case "channels-open":
        return control.channels.open(a);
      case "channels-close":
        return control.channels.close(a);
      case "channels-status":
        if (a != null) throw Error("Status takes no input");
        return { ...control.channels.status(), error: control.channels.lastError ?? null };
      case "channels-requests":
        if (a != null) throw Error("Requests takes no input");
        return control.channels.requests();
      case "worktree-lifecycle-preview": {
        if (
          a &&
          (Object.keys(a).some((k) => k !== "operationId") ||
            (a.operationId !== undefined && !uuid(a.operationId)))
        )
          throw Error("Invalid cleanup preview");
        return control.worktreeLifecycle.previewRequest(a ?? {});
      }
      case "worktree-lifecycle-apply": {
        if (
          !a ||
          Object.keys(a).sort().join() !== "confirm,planId" ||
          !uuid(a.planId) ||
          a.confirm !== true
        )
          throw Error("Invalid cleanup confirmation");
        return control.worktreeLifecycle.applyRequest(a);
      }
      case "worktree-lifecycle-retention": {
        if (!a || Object.keys(a).join() !== "retentionDays")
          throw Error("Invalid retention setting");
        return { retentionDays: await control.worktreeLifecycle.settings.set(a.retentionDays) };
      }
      case "session-defaults": {
        if (a != null && (typeof a !== "object" || Array.isArray(a)))
          throw new Error("Invalid session defaults query");
        return {
          providers: Object.fromEntries(
            ["claude", "codex"].map((p) => [p, sessionDefaults(p, a?.[p])]),
          ),
          roles: await roleDefaultsTable(control),
          refused: REFUSED,
          settings: settingsStatus(),
        };
      }
      case "roles-request-session":
        return control.roleSessions.requestSession(a);
      case "roles-session-requests":
        if (a != null) throw Error("Session requests takes no input");
        return control.roleSessions.requests();
      case "roles-adopt":
        return control.roleSessions.adopt(a);
      case "roles-allowance-set":
        return control.roleSessions.setAllowance(a);
      case "roles-allowances":
        if (a != null) throw Error("Allowances takes no input");
        return control.roleSessions.allowances();
      case "roles-ownership":
        if (!uuid(a)) throw Error("Invalid session");
        return control.roleSessions.describeOwnership(a);
      case "channels-request-decline":
        return control.channels.declineRequest(a);
      // J3 issue trackers. Operator-only and deliberately absent from every capability lane above: no seat,
      // delegated session or channel message may map a project to a repository or link work to an item.
      case "trackers-map":
        return trackers(control).map(a);
      case "trackers-unmap":
        return trackers(control).unmap(a);
      case "trackers-link":
        return trackers(control).link(a);
      case "trackers-unlink":
        return trackers(control).unlink(a);
      case "trackers-project":
        return trackers(control).project(a);
      case "trackers-links-for":
        return trackers(control).linksFor(a);
      case "trackers-status":
        if (a != null) throw Error("Status takes no input");
        return trackers(control).status();
      case "trackers-history":
        return trackers(control).history(a);
      case "trackers-directory":
        if (a != null) throw Error("Directory takes no input");
        return trackers(control).projectsView();
      // Fulcra J4 connectors, mappings and links (CONTRACTS §2.2, §7). Operator-only, like the J3 records above:
      // no seat, delegated session or channel may map a tracker, store an observation or write a link.
      case "cc-tracker-mappings":
        return ccTrackers(control).list(a ?? undefined);
      case "cc-tracker-map":
        return ccTrackers(control).map(a);
      case "cc-tracker-unmap":
        return ccTrackers(control).unmap(a);
      case "cc-tracker-legacy-pending":
        if (a != null) throw Error("Legacy pending takes no input");
        return ccTrackers(control).legacyPending();
      case "cc-tracker-import-legacy":
        return ccTrackers(control).importLegacy(a);
      case "cc-tracker-items-put":
        return ccTrackers(control).putItems(a);
      case "cc-tracker-items":
        return ccTrackers(control).items(a);
      case "cc-tracker-mapping-history":
        return ccTrackers(control).history(a);
      case "cc-links-set":
        return ccLinks(control).set(a);
      case "cc-links-remove":
        return ccLinks(control).remove(a);
      case "cc-links-observe":
        return ccLinks(control).observe(a);
      case "cc-links-for":
        return ccLinks(control).forRefs(a);
      case "cc-link-history":
        return ccLinks(control).history(a);
      // Fulcra J3 inbox. Operator-gated: this socket path is the Fulcra app, the `human` origin (CONTRACTS §1).
      // Choosing is reachable ONLY here; no capability lane above can answer a packet asked of the owner.
      case "decisions-inbox":
        if (a != null) throw Error("Inbox takes no input");
        return decisions(control).inbox();
      // Fulcra J8 Environments, operator lane (the app). There is deliberately no method that runs a promotion.
      case "environments-view":
        if (!a || Object.keys(a).join() !== "projectId") throw Error("Invalid environments read");
        return environments(control).view(a.projectId);
      case "environments-propose":
        return environments(control).propose(a, { kind: "operator" });
      case "promotions-create":
        return environments(control).promotionCreate(a, { kind: "operator" });
      case "promotions-cancel":
        return environments(control).promotionCancel(a);
      case "decisions-get":
        return decisions(control).get(a);
      // CONTRACTS v1.2: the app may state its platform; missing means app-mac. The actor is always human here.
      // v1.6 (S-1): this path is the operator. The owner is proven only by a device proof the controller verifies.
      case "decisions-choose": {
        const { via, proof, ...choice } = a ?? {};
        if (via !== undefined && !APP_VIA.includes(via)) throw Error("Invalid choice platform");
        return decisions(control).choose(choice, { via: via ?? "app-mac", proof });
      }
      // §3.6 paired devices. Only opening the first-device window is unsigned; every other write carries a device signature.
      case "cc-channels-list":
        if (a != null) throw Error("Channel list takes no input");
        return inboxChannels(control).list();
      case "cc-channel-pair-open":
        return inboxChannels(control).openWindow(a);
      case "cc-channel-pause":
        return inboxChannels(control).pause(a);
      case "cc-channel-resume":
        return inboxChannels(control).resume(a);
      case "cc-channel-revoke":
        return inboxChannels(control).revoke(a);
      case "devices-list":
        if (a != null) throw Error("Device list takes no input");
        return devices(control).list();
      case "devices-pair-open":
        return devices(control).openWindow(a);
      case "devices-pair-complete":
        return devices(control).completePairing(a);
      case "devices-pair-approve":
        return devices(control).approvePairing(a);
      case "devices-revoke":
        return devices(control).revoke(a);
      case "decisions-held-message":
        return decisions(control).heldMessage(a);
      case "decisions-digest":
        return decisions(control).digest(a);
      // G4: the review screen's decision, recorded as a record-only Inbox item (operator lane; no authority).
      case "decisions-record-review": {
        const { via, ...record } = a ?? {};
        if (via !== undefined && !APP_VIA.includes(via)) throw Error("Invalid review platform");
        return decisions(control).recordReview(record, { via: via ?? "app-mac" });
      }
      case "decisions-digest-run":
        if (a != null) throw Error("Digest run takes no input");
        return { composed: await decisions(control).composeDue() };
      // Fulcra J1 remits (CONTRACTS §5). Operator-gated and absent from every capability lane above: no seat or
      // session may move a project between primes. Without device proof (§3.6) this path is the operator.
      case "remits-list":
        if (a != null) throw Error("Remit list takes no input");
        return remits(control).list({ defaults: false });
      case "remits-assign":
        return remits(control).assign(a, { actor: "operator" });
      case "remits-move":
        return remits(control).move(a, { actor: "operator" });
      case "remits-end":
        return remits(control).end(a, { actor: "operator" });
      case "remits-domain-set":
        return remits(control).setDomain(a, { actor: "operator" });
      case "briefs-read":
        return briefs(control).read(a);
      case "manager-summary":
        return control.manager.summary(taskScope(a, "Summary"));
      case "manager-promote":
        return control.manager.promote(a);
      case "manager-resume":
        return control.manager.resume(a);
      case "manager-grant":
        return control.manager.grant(a);
      case "events-attach":
        return control.events.attach(a);
      case "events-resume":
        return control.events.resume(a);
      case "events-status":
        if (a != null) throw Error("Status takes no input");
        return {
          book: control.native.bookStatus?.() ?? null,
          links: control.events.links(),
          faults: control.events.db.prepare("SELECT * FROM event_faults").all(),
          unresolved: control.events.db
            .prepare(
              "SELECT id,worker,epoch,state FROM event_pending WHERE state NOT IN ('resolved','not-delivered')",
            )
            .all(),
          notifications: control.events.db
            .prepare(
              "SELECT id,worker,supervisor,kind,state,consumed,at FROM event_inbox ORDER BY rowid DESC LIMIT 1000",
            )
            .all(),
          error: control.events.lastError ?? null,
        };
      case "list":
        if (a != null) throw new Error("List takes no input");
        return projectList(control, control.store.list());
      case "task-index":
        if (a != null) throw new Error("Task index takes no input");
        return control.store.taskIndex();
      case "task-authority":
        if (!uuid(a)) throw new Error("Invalid task ID");
        await control.authority(a);
        return { allowed: true };
      case "management-prepare":
        if (!a || Object.keys(a).sort().join() !== "body,kind,messageId")
          throw new Error("Invalid management preparation");
        return control.prepareManagement(a.kind, a.body, a.messageId);
      case "management-ack":
        return control.acknowledgeManagement(a);
      case "history":
        return control.history(a);
      case "book-activity":
        return control.native.activity(a);
      case "book-activity-page":
        return control.native.activityPage(a);
      case "activity-receipts":
        return activityReceipts(control.store, a);
      case "operator-native-queue": {
        if (
          !a ||
          Object.keys(a).sort().join() !== "expectedGeneration,messageId,sessionId,text" ||
          !Number.isSafeInteger(a.expectedGeneration)
        )
          throw Error("Invalid operator native queue");
        const { expectedGeneration, ...body } = a;
        return control.sendQueued(body, undefined, expectedGeneration);
      }
      case "operator-send": {
        if (
          !a ||
          Object.keys(a).sort().join() !== "expectedGeneration,messageId,sessionId,text" ||
          !Number.isSafeInteger(a.expectedGeneration)
        )
          throw new Error("Invalid operator send");
        const { expectedGeneration, ...body } = a;
        return control.send(body, undefined, expectedGeneration);
      }
      case "create": {
        // An operator may DECLARE the owning project at creation, using the same before-create ownership
        // row a seat uses. It stays optional: unknown must remain possible, because the first session on a
        // project -- including its own leader -- exists before any seat does.
        if (a && typeof a === "object" && !Array.isArray(a) && a.projectId !== undefined) {
          const { projectId, ...body } = a;
          return control.roleSessions.declaredCreate(projectId, body);
        }
        return control.create(a);
      }
      case "session-takeover": {
        const input = parseControllerCommand({ method: "session-takeover", input: a }).input;
        const generation = control.store.get(input.session)?.generation;
        const result = await takeOverSession(input.session, input.accountId, {
          control,
          root: control.poolRoot ?? poolRoot(),
          generation,
          reason: "manual",
        });
        const state = result.switchId && control.store.delivery(result.switchId)?.state;
        return {
          ...result,
          state:
            state ||
            (result.ok ? "delivered" : result.outcome === "uncertain" ? "uncertain" : "refused"),
        };
      }
      case "recover":
        return control.recover(a);
      case "observe":
        return control.inspect(a);
      case "takeover":
        if (!a || Object.keys(a).sort().join() !== "reason,sessionId")
          throw new Error("Invalid takeover");
        return control.operatorTakeover(a.sessionId, a.reason);
      case "handback":
        if (
          !a ||
          !["reason,sessionId", "expectedGeneration,reason,sessionId"].includes(
            Object.keys(a).sort().join(),
          )
        )
          throw new Error("Invalid handback");
        return control.handback(a.sessionId, a.reason, a.expectedGeneration);
      // Operator-gated like takeover and handback, and deliberately not reachable with a session
      // capability: a seat must never be able to repair its own fence.
      case "reestablish":
        if (!a || Object.keys(a).sort().join() !== "reason,sessionId")
          throw new Error("Invalid seat re-establishment");
        return control.reestablish(a.sessionId, a.reason);
      case "disposition":
        if (!a || Object.keys(a).sort().join() !== "messageId,reason")
          throw new Error("Invalid disposition");
        return control.disposition(a.messageId, a.reason);
      default:
        throw new Error("Unknown controller method");
    }
  };
}

// Both list paths return the same native projection: host, provider and remote route come from the
// host routes, never from the journal row alone (FD-1).
function projectList(control, rows) {
  return control.native?.projectAll
    ? control.native.projectAll(rows)
    : rows.map((s) => control.native?.project?.(s) ?? s);
}
// IR-10 transport summary of one projected row: saved enrollment and routing fields only, never native
// payload, and no undefined values (JSON-safe across the management channel).
const defined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
function enrollmentSummary({
  id,
  task,
  cwd,
  mode,
  generation,
  expected,
  host,
  provider,
  remote,
  remoteWorkers,
  revocationAcknowledged,
}) {
  return defined({
    id,
    task,
    cwd,
    mode,
    generation,
    expected,
    host,
    provider,
    remote:
      remote &&
      defined({
        host: remote.host,
        agentId: remote.agentId,
        state: remote.state,
        generation: remote.generation,
        error: remote.error,
        revocationAcknowledged: remote.revocationAcknowledged,
      }),
    remoteWorkers: remoteWorkers?.map((w) =>
      defined({ id: w.id, phase: w.phase, generation: w.generation }),
    ),
    revocationAcknowledged,
  });
}

// Cutover A2: every management write is journaled with its principal and call context BEFORE dispatch, and its outcome
// after. Bounded to 10000 rows; the input is recorded only as a digest (an instruction may be private).
function recordManagementCall(db, parsed, principal) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS management_calls(id INTEGER PRIMARY KEY, at TEXT NOT NULL, method TEXT NOT NULL, principal TEXT NOT NULL, authentication TEXT NOT NULL, deviceId TEXT, permissions TEXT NOT NULL, messageId TEXT, sessionId TEXT, inputDigest TEXT NOT NULL, outcome TEXT)",
  );
  const input = parsed.input,
    field = (k) =>
      input && typeof input === "object" && typeof input[k] === "string" ? input[k] : null;
  const id = Number(
    db
      .prepare(
        "INSERT INTO management_calls(at,method,principal,authentication,deviceId,permissions,messageId,sessionId,inputDigest) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        parsed.method,
        principal.id,
        principal.authentication,
        principal.deviceId ?? null,
        JSON.stringify([...principal.permissions].sort()),
        field("messageId"),
        field("sessionId") ?? field("session") ?? (typeof input === "string" ? input : null),
        createHash("sha256")
          .update(JSON.stringify(input ?? null))
          .digest("hex"),
      ).lastInsertRowid,
  );
  db.prepare("DELETE FROM management_calls WHERE id <= ?").run(id - 10000);
  return (outcome) =>
    db
      .prepare("UPDATE management_calls SET outcome=? WHERE id=?")
      .run(String(outcome).slice(0, 500), id);
}
// Only the host-owned management channel calls this entry point. A fresh private
// in-memory gate reaches the existing dispatcher without loading operator.secret.
export function managementDispatcher(control) {
  const gate = randomBytes(32).toString("base64url");
  const dispatch = rpc(control, gate);
  return (command, principal) => {
    let parsed;
    try {
      parsed = parseControllerCommand(command);
    } catch (error) {
      throw managementRefusal(error.message);
    }
    if (parsed.method === "health") return { ready: true };
    if (parsed.method === "list") {
      const rows = control.store.list();
      if (rows.length > 2048)
        throw Object.assign(Error("Enrollment summary capacity exceeded"), { code: "unavailable" });
      const result = projectList(control, rows).map(enrollmentSummary);
      if (Buffer.byteLength(JSON.stringify(result)) > 768 * 1024)
        throw Object.assign(Error("Enrollment summary capacity exceeded"), { code: "unavailable" });
      return result;
    }
    if (READ_METHODS.includes(parsed.method)) return dispatch({ ...parsed, operator: gate });
    requireManagementPrincipal(principal);
    // Manual account switching is an owner management write. A paired device may make it only when the host admitted
    // it with accounts.manage -- a separate grant the owner gives per device (U7), never implied by command-centre.manage
    // and never on the read tier (which requireManagementPrincipal above already refuses).
    if (
      parsed.method === "session-takeover" &&
      principal.authentication === "paired-device" &&
      !principal.permissions.includes("accounts.manage")
    )
      throw Object.assign(
        Error(
          "Account switching needs account management for this device; ask the owner to allow it",
        ),
        { code: "unauthorised" },
      );
    const done = recordManagementCall(control.store.db, parsed, principal);
    let result;
    try {
      result = dispatch({ ...parsed, operator: gate });
    } catch (e) {
      done("error: " + e.message);
      throw e;
    }
    return Promise.resolve(result).then(
      (value) => {
        done("ok");
        return value;
      },
      (e) => {
        done("error: " + e.message);
        throw e;
      },
    );
  };
}
