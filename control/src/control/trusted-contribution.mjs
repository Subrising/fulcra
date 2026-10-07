import {
  bootstrapCandidate,
  admitBootstrap,
  requireBootstrapBinding,
} from "./native-bootstrap.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  canonicalTrustedPayload,
  normalizeTrustedPromptOptions,
} from "@getpaseo/protocol/trusted-input";
import { loadConfig } from "../config.mjs";
import { journalPolicy } from "./hook-journal-policy.mjs";
import { queuedJournalPolicy } from "./queued-journal-policy.mjs";
import { quotaDecision } from "./quota-observation.mjs";
import { socketLocation } from "./socket-location.mjs";
import { admitOwnedCleanup } from "./owned-cleanup-admission.mjs";
import { automaticPermissionProof, permissionMode } from "./automatic-permission.mjs";
export { PLUGIN_ID as OWN_ID } from "./plugin-identity.mjs";
import { PLUGIN_ID as OWN_ID } from "./plugin-identity.mjs";
export const hostContract = "1.1";
const fail = (reason) => {
  throw Error("Orca native admission refused: " + reason);
};
export function automaticDecision(db, agent, request) {
  try {
    if (
      agent.runtime?.status !== "known" ||
      request.provider !== agent.provider ||
      typeof agent.cwd !== "string" ||
      !agent.cwd ||
      db.prepare("SELECT mode FROM sessions WHERE id=?").get(agent.id)?.mode === "delegated"
    )
      return "ask";
    automaticPermissionProof(request, agent.cwd, permissionMode(agent), "-");
    return "allow";
  } catch {
    return "ask";
  }
}
export function sendPayload(text) {
  return {
    type: "prompt",
    prompt: text,
    options: normalizeTrustedPromptOptions({
      unarchive: true,
      replaceRunning: true,
      clearPendingPermissions: true,
      activeTurnBehavior: "interrupt",
    }),
  };
}
export function queuedSendPayload(text) {
  return { type: "prompt", prompt: text, options: normalizeTrustedPromptOptions() };
}
export function payloadDigest(agentId, kind, messageId, payload) {
  return createHash("sha256")
    .update(canonicalTrustedPayload({ agentId, kind, messageId, payload }))
    .digest("hex");
}
export function privateDenyRules(home) {
  // Private entries only: managed worktrees live under home/tasks.
  const entries = [
    "control.sock",
    "operator.secret",
    "controller.secret",
    "journal.sqlite*",
    "config.json",
    ".config-*",
    ".config.json-*",
    "tasks.json",
    ".tasks.json-*",
    "grants",
    "grants/**",
    "pairing",
    "pairing/**",
    "pairing.*",
    "device-pairing*",
    "devices",
    "devices/**",
    "devices.*",
    "memory",
    "memory/**",
    // Cutover A1/A3: the pinned Book transport profile and the owned task-root list are controller configuration.
    "book-transport.json",
    "task-roots.json",
    // W1 row 9: the owned daemon's sealed boot chain is the seat sweep's human-input evidence.
    "boots",
    "boots/**",
  ];
  const paths = entries.map((p) => path.join(home, p)),
    location = socketLocation(home);
  if (location.external) paths.push(location.directory, path.join(location.directory, "**"));
  const bashPaths = [...new Set(paths.map((p) => (p.endsWith("/**") ? p.slice(0, -3) : p)))];
  return [
    ...paths.flatMap((p) => ["Read", "Edit", "Write"].map((tool) => `${tool}(/${p})`)),
    ...bashPaths.map((p) => `Bash(*${p}*)`),
  ];
}
// A distribution-owned factory, never an ordinary plugin RPC or public mint endpoint.
export function createTrustedContribution({
  home = loadConfig().home,
  now = Date.now,
  managementBridge,
  rateSettingsFile = () => undefined,
  automaticResumeEnabled = () => false,
} = {}) {
  return (server) => {
    if (managementBridge !== undefined) {
      if (typeof managementBridge !== "function")
        throw Error("Invalid distribution management bridge");
      server.managementBridge.register(managementBridge);
    }
    const policy = journalPolicy(server.inputObservations, { rateSettingsFile }),
      queuedPolicy = queuedJournalPolicy(server.inputObservations, { rateSettingsFile }),
      usedPermissions = new Set(),
      operations = new Map(),
      attempts = new Map();
    const lockSleep = new Int32Array(new SharedArrayBuffer(4));
    const beginWrite = (db, deadline) => {
      let busy;
      for (;;) {
        // One monotonic budget, including time the OS oversleeps. Never retry writes.
        if (busy && performance.now() >= deadline) throw busy;
        try {
          db.exec("BEGIN IMMEDIATE");
          return;
        } catch (error) {
          if (deadline === undefined || (error.errcode & 0xff) !== 5) throw error; // SQLITE_BUSY only
          busy = error;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw busy;
        Atomics.wait(lockSleep, 0, 0, Math.min(25, remaining));
      }
    };
    const read = (write, callback, deadline) => {
      let db;
      try {
        db = new DatabaseSync(path.join(home, "journal.sqlite"), { readOnly: !write });
        // SQLite's busy handler budgets requested sleep, not elapsed time.
        // Keep every SQLite operation non-waiting; only BEGIN gets the shared deadline.
        db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
        if (write) beginWrite(db, deadline);
        else db.exec("BEGIN");
        const result = callback(db);
        if (write) db.exec("COMMIT");
        return result;
      } finally {
        db?.close();
      }
    };
    const facts = (agent, bootstrap = false) => {
      if (
        agent.runtime.status !== "known" ||
        agent.permissions.status !== "known" ||
        !agent.runtime.instanceId ||
        (!agent.runtime.nativeSessionId && !bootstrap) ||
        (!agent.runtime.model && !(bootstrap && agent.runtime.model === null))
      )
        fail("Live runtime or permission facts unavailable");
      return {
        ...agent,
        pendingPermissions: new Map(agent.permissions.requests.map((r) => [r.id, r])),
        inFlightPermissionResponses: new Set(agent.permissions.inFlightRequestIds),
      };
    };
    server.permissions?.automatic((agent, request) => {
      try {
        return read(false, (db) => automaticDecision(db, agent, request));
      } catch {
        return "ask";
      }
    });
    const own = (operation) => operation.pluginId === OWN_ID;
    const exact = (agent, operation, kind, messageId, attempt, payload) => {
      if (
        !own(operation) ||
        operation.agentId !== agent.id ||
        operation.kind !== kind ||
        operation.messageId !== messageId ||
        !attempt ||
        operation.attemptId !== attempt ||
        operation.payloadDigest !== payloadDigest(agent.id, kind, messageId, payload)
      )
        fail("Unverified or changed journal attempt/payload");
    };
    const send = (db, agent, operation, phase) => {
      const bootstrap = bootstrapCandidate(agent);
      const a = facts(agent, bootstrap),
        prefix = "orca-control:",
        id = operation.messageId?.startsWith(prefix)
          ? operation.messageId.slice(prefix.length)
          : null;
      if (!id || agent.archivedAt) fail("Missing send identity or archived session");
      const delivery = db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
      if (!delivery) fail("Missing journal delivery");
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_recoveries'",
          )
          .get() &&
        db
          .prepare(
            "SELECT 1 FROM provider_recoveries WHERE session=? AND kind='network' AND continuation=?",
          )
          .get(agent.id, id) &&
        automaticResumeEnabled() !== true
      )
        fail("Automatic network resume is off");
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='automatic_restart_resumes'",
          )
          .get()
      ) {
        const restart = db
          .prepare("SELECT * FROM automatic_restart_resumes WHERE session=? AND continuation=?")
          .get(agent.id, id);
        if (
          restart &&
          (automaticResumeEnabled() !== true || !["ready", "inflight"].includes(restart.state))
        )
          fail("Automatic restart resume is off or no longer current");
      }
      const intent = JSON.parse(delivery.result),
        body = JSON.parse(delivery.body);
      exact(
        a,
        operation,
        "prompt",
        prefix + id,
        intent.nativeAttemptId,
        intent.nativeQueue ? queuedSendPayload(body.text) : sendPayload(body.text),
      );
      if (intent.nativeQuotaWait?.attempt === operation.attemptId)
        fail("Attempt already refused before dispatch");
      const owner = attempts.get(operation.attemptId);
      if (owner && owner !== operation.operationId)
        fail("Journal attempt already bound to another operation");
      const before = operations.get(operation.operationId);
      requireSameOperationRuntime(before, a.runtime);
      if (intent.nativeQueue) queuedPolicy.admit(db, a, body.text, id, phase);
      else policy.admit(db, a, body.text, id, Boolean(a.activeTurnId || a.activeForegroundTurnId));
      if (bootstrap) admitBootstrap(db, a, operation, delivery, server.inputObservations.boot);
      else requireBootstrapBinding(db, a);
      if (!before) {
        if (operations.size >= 10000) fail("Operation capacity reached");
        operations.set(operation.operationId, { ...a.runtime });
        attempts.set(operation.attemptId, operation.operationId);
      }
      return { id, intent, agent: a };
    };
    // A separate committed connection makes revocation visible before any provider effect.
    // Do not alter the host's human-only observation contract or trust a caller's source claim.
    const recordExternalInput = (agent, input) => {
      // H7b on the owned daemon (W1 row 9): the host's orderly-shutdown closure (bootstrap stop() ->
      // trustedPlugins.shutdownClosure(closeAllAgents), its one caller) is not human input and must not end delegation,
      // or every clean restart takes every seat over. The key is that CALL PATH (cause 'shutdown', set by the host's
      // own context), never host state: a client close runs in its request's 'human' context whenever it resumes
      // (H7b review B1), and every other daemon close (provider retirement, load failure) still ends delegation.
      if (input.source === "daemon" && input.cause === "shutdown" && input.kind === "close") return;
      // Only the host's child-finish notification preserves delegation. A caller
      // supplying this prefix still passes through the external-input fence.
      if (
        input.source === "daemon" &&
        ["prompt", "steer", "replace"].includes(input.kind) &&
        (input.operation?.messageId ?? input.messageId)?.startsWith("paseo-notify:")
      )
        return;
      // Issued only by the host's strict owner/native metadata admission path, never from a wire label/prefix.
      if (
        input.source === "daemon" &&
        input.cause === "parent-adoption" &&
        input.kind === "configure" &&
        input.operation?.kind === "configure"
      )
        return;
      const deadline = performance.now() + 2000;
      let observedDb, mode;
      try {
        // A plain WAL read must not compete with unrelated controller writers.
        observedDb = new DatabaseSync(path.join(home, "journal.sqlite"), { readOnly: true });
        mode = observedDb.prepare("SELECT mode FROM sessions WHERE id=?").get(agent.id)?.mode;
      } catch (error) {
        if (input.source === "human") return; // Human input continues when authority is unreadable.
        throw error;
      } finally {
        observedDb?.close();
      }
      if (mode !== "delegated") return;
      return read(
        true,
        (db) => {
          const row = db.prepare("SELECT mode,generation FROM sessions WHERE id=?").get(agent.id);
          if (!row || row.mode !== "delegated") return;
          if (!Number.isSafeInteger(row.generation) || row.generation >= Number.MAX_SAFE_INTEGER)
            fail("External input generation unavailable");
          const reason = JSON.stringify({
            event: "external-input",
            source: input.source,
            kind: input.kind,
            operationId: input.operation.operationId,
          });
          db.prepare(
            "UPDATE deliveries SET state='refused',result=json_set(result,'$.nativeDispatched',json('false'),'$.wait.state','cancelled','$.wait.reason','External input ended delegation') WHERE session=? AND state='queued'",
          ).run(agent.id);
          db.prepare(
            "UPDATE sessions SET mode='human',generation=generation+1,token=NULL,expected=NULL WHERE id=? AND mode='delegated'",
          ).run(agent.id);
          db.prepare("INSERT INTO transfers VALUES (?,?,?,?,?,?)").run(
            randomUUID(),
            agent.id,
            row.generation + 1,
            "human",
            reason,
            new Date(now()).toISOString(),
          );
        },
        deadline,
      );
    };
    server.admission.onInput((agent, input) => {
      const operation = input.operation;
      const claimed =
        operation.messageId?.startsWith("orca-control:") ||
        operation.messageId?.startsWith("orca-permission:");
      if (!own(operation)) {
        if (claimed) fail("Unverified controller prefix");
        recordExternalInput(agent, input);
        return "allow";
      }
      if (input.provenance?.pluginId !== OWN_ID) fail("Missing own provenance");
      if (
        ["archive", "close"].includes(operation.kind) &&
        operation.messageId?.startsWith("orca-cleanup:")
      ) {
        read(false, (db) =>
          admitOwnedCleanup(db, agent, operation, {
            now: now(),
            pluginId: OWN_ID,
            digest: payloadDigest(agent.id, operation.kind, operation.messageId, {
              type: "command",
              command: operation.kind,
              arguments: {},
            }),
          }),
        );
        return "allow";
      }
      if (operation.kind === "permission") {
        if (!operation.messageId?.startsWith("orca-permission:")) fail("Missing permission intent");
        return "allow"; // The permission hook checks its canonical request and response.
      }
      read(bootstrapCandidate(agent), (db) => send(db, agent, operation, input.admissionPhase));
      return "allow";
    });
    server.guard("agent.permission_respond", (agent, requestId, response, input) => {
      if (!requestId.startsWith("orca-permission:")) {
        if (own(input.operation)) fail("Missing permission intent");
        return "allow";
      }
      try {
        return read(false, (db) => {
          const a = facts(agent),
            id = requestId.slice("orca-permission:".length);
          // A permission intent is itself a one-shot attempt; no retry of that row.
          exact(a, input.operation, "permission", requestId, id, {
            type: "permission",
            requestId,
            response,
          });
          const row = db.prepare("SELECT body FROM permission_intents WHERE id=?").get(id),
            body = row && JSON.parse(row.body);
          if (!body || body.nativeId !== a.runtime.nativeSessionId)
            fail("Permission native session changed");
          return { requestId: policy.admitPermission(db, a, id, response, usedPermissions) };
        });
      } catch (error) {
        throw Error("Orca native permission refused: " + error.message, { cause: error });
      }
    });
    server.admission.nativeQueuedReceipt((agent, operation, receipt) => {
      if (!own(operation) || !operation.messageId?.startsWith("orca-control:")) return;
      read(true, (db) => queuedPolicy.observe(db, facts(agent), operation, receipt));
    });
    server.claude.deny(() => privateDenyRules(home));
    server.admission.mcpRefresh((agent) =>
      read(false, (db) => {
        const a = facts(agent);
        if (a.archivedAt || a.activeTurnId || a.activeForegroundTurnId || a.pendingPermissions.size)
          return { allowed: false, revision: "unavailable" };
        return policy.mcpRefreshAdmissionInStore(db, a);
      }),
    );
    const turnRead = (agent, turn, write, callback) =>
      read(write, (db) => {
        const context = send(db, agent, turn.operation),
          runtime = context.agent.runtime;
        if (
          turn.instanceId !== runtime.instanceId ||
          turn.nativeSessionId !== runtime.nativeSessionId ||
          turn.model !== runtime.model ||
          turn.serviceTier !== runtime.serviceTier
        )
          fail("Prepared turn identity changed");
        return callback(db, context);
      });
    const receipt = (db, { id, intent }, turn, reason) => {
      if (!intent.wait) fail("No queued quota attempt");
      const value = {
        attempt: turn.operation.attemptId,
        boot: server.inputObservations.boot,
        nativeDispatched: false,
        operationId: turn.operation.operationId,
        payloadDigest: turn.operation.payloadDigest,
        reason,
        at: now(),
      };
      const result = db
        .prepare(
          "UPDATE deliveries SET result=json_set(result,'$.nativeQuotaWait',json(?)) WHERE id=? AND state='intent'",
        )
        .run(JSON.stringify(value), id);
      if (result.changes !== 1) fail("Quota receipt was not persisted");
    };
    server.admission.codexTurn({
      check(agent, turn, quota) {
        if (!own(turn.operation)) {
          if (turn.operation.messageId?.startsWith("orca-control:"))
            fail("Unverified controller prefix");
          return "allow";
        }
        return turnRead(agent, turn, true, (db, context) => {
          if (!context.intent.wait) return "allow";
          const decision = quotaDecision(quota, context.intent.wait.binding.quota, now());
          if (decision.state === "changed") fail(decision.reason);
          if (decision.state !== "ready") {
            receipt(db, context, turn, decision.reason);
            return "deny";
          }
          return "allow";
        });
      },
      onQuotaReadFailure(agent, turn, failure) {
        if (!own(turn.operation)) return;
        if (
          !["unavailable", "read_failed", "invalid_reply"].includes(failure.code) ||
          failure.nativeDispatched !== false
        )
          fail("Invalid quota failure");
        turnRead(agent, turn, true, (db, context) => receipt(db, context, turn, failure.code));
      },
    });
  };
}
export default function contribute(server) {
  createTrustedContribution()(server);
}

function requireSameOperationRuntime(before, runtime) {
  if (
    before &&
    ["instanceId", "nativeSessionId", "model", "serviceTier"].some(
      (key) => before[key] !== runtime[key],
    )
  )
    throw Error("Runtime changed during operation");
}
