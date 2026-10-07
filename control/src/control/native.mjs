import { portable } from "../portable-config.mjs";
import {
  resolveProviderModel,
  checkCapability,
  checkOverride,
  checkProvider,
} from "./provider-model.mjs";
import { hostInputFence } from "./native-fence.mjs";
const uuidLike = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
import {
  supervisorServer,
  toolPolicy,
  TOOL_SURFACE,
  SUPERVISOR_SERVER,
  MEMORY_SERVER,
  refreshToolsFor,
} from "./tool-surface.mjs";
import { sessionDefaults } from "./provider-mode.mjs";
import { canonicalMemoryConfig } from "../canonical-memory-route.mjs";
import fs from "node:fs";
import path from "node:path";
import { catalogActivation } from "./catalog-activation.mjs";
import { boundNativeInputs } from "./trusted-native-input.mjs";
import { payloadDigest } from "./trusted-contribution.mjs";
import { receiptFor } from "./receipt.mjs";
import { completionFor } from "./completion.mjs";
import { permissionResultFor } from "./permission-result.mjs";
import { randomUUID } from "node:crypto";
import { nativeIdentity } from "./native-identity.mjs";
import { agentWatch } from "./agent-watch.mjs";
import { nameNewWorkspace, nameExistingWorkspaces } from "./workspace-titles.mjs";
import { createPaseoApi } from "./client-sdk.mjs";
export { CONTROLLER_HOME as HOME } from "./installation-settings.mjs";
import { CONTROLLER_HOME as HOME } from "./installation-settings.mjs";
// The namespace the controller stamps on every prompt it dispatches. Deliberately NOT imported from
// admission-guard.mjs: that module is the deployed, pinned guard with its own copy of this literal, and
// coupling the controller's build to it would mean a redeploy to change either. Kept in one place here
// so the length is never spelled as 13 again.
export const CONTROL_PREFIX = "orca-control:";

// The prefix is a CLAIM, not a credential. Any daemon client -- the app, the paseo CLI, an MCP tool, a
// plugin, a relay client -- can set clientMessageId to whatever it likes; the wire schema is an optional
// string and the server only trims it. So this reports what the prompt claims and nothing more, and the
// name says so. The controller decides whether the claim is TRUE by looking for its own deliveries row:
// see Controller.controlDispatched.
//
// Extracted from inspect() so it can be executed by a test. Inside the closure it was unreachable
// without a live daemon, so the prefix detection and the slice were never run by the suite.
export function projectPromptId(rawPromptId) {
  const promptClaimsControl = rawPromptId?.startsWith(CONTROL_PREFIX) ?? false;
  return {
    promptClaimsControl,
    lastPromptId: promptClaimsControl ? rawPromptId.slice(CONTROL_PREFIX.length) : rawPromptId,
  };
}

// Which model selection the creation path hands to resolveProviderModel, extracted from create() so it
// can be EXECUTED by a test rather than only matched as text. That distinction is the point: the guard in
// session-config.test.mjs is a regex over file contents, and a re-pin that evades the regex -- building
// the same literal with a join, say -- passed it while changing what every session got. A test that calls
// this and follows the answer through a fake inventory cannot be fooled that way.
//
// A portable installation still wins. Its `providers` map is mandatory (portable-config.mjs validates it)
// and is a deliberate per-installation choice that predates session defaults, so overriding it here would
// silently change installations that had already answered this question. The consequence is stated rather
// than hidden: on a portable installation this path takes the config value and `chosen.model` -- including
// a per-spawn override -- is not consulted. An operator who wants a portable install to follow its host
// sets `providers.claude` to the bare family, which its validator already accepts.
export function creationModel(provider, chosen, config = portable) {
  // DESIGN-NEXT-BUILD A2: a role default or an explicit per-spawn model is a deliberate selection for THIS session and
  // outranks the portable pin. Everything else keeps the pin, exactly as before (installation `models` included).
  if (chosen.source?.model === "role" || chosen.source?.model === "override") return chosen.model;
  return config?.providers[provider] ?? chosen.model;
}

export async function readNativeQuota(client, daemon, id) {
  const agent = client.agents.ref(id);
  await agent.refresh();
  if (
    agent.current()?.provider !== "codex" ||
    daemon.getLastServerInfoMessage()?.features?.agentQuotaRead !== true
  )
    return null;
  const result = await daemon.readAgentQuota(id);
  if (result.agentId !== id) throw Error("Quota target changed");
  return result.quota;
}
import { permissionChannel } from "./permission-channel.mjs";
// H7 item 5 (PRIME-ANSWERS-12): ./SESSION-ID in every controller-created session's job directory, written at creation.
// The directory may have been prepared by the seat before the session existed (role_job_directory), so whatever is at
// ./SESSION-ID is never opened or written through: the id goes to a fresh private file (O_EXCL, no-follow) that is then
// RENAMED into place. A rename replaces the directory entry itself, so a planted symlink, FIFO or HARD LINK (review
// H7 B3) is replaced and its target is never truncated, written or chmodded; a directory in its place makes it fail.
// Best effort: the session already exists, so a failure is reported in the creation result and never fails creation.
export function writeSessionId(cwd, id) {
  const target = path.join(cwd, "SESSION-ID"),
    temporary = path.join(cwd, `.SESSION-ID.${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeSync(fd, id + "\n");
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export { permissionChannel } from "./permission-channel.mjs";
export async function connectNative({ daemon, issueProvenance, getHandshakeBoot } = {}) {
  if (!daemon?.isConnected || typeof issueProvenance !== "function")
    throw Error("Authenticated controller channel unavailable");
  const activation = catalogActivation(daemon, { getHandshakeBoot });
  await activation.refresh();
  const verifyActivation = () => activation.require();
  const inputs = boundNativeInputs({ daemon, issueProvenance, verifyActivation });
  const channel = permissionChannel(daemon);
  await channel.ready();
  const client = createPaseoApi(daemon),
    watching = agentWatch(client);
  const verifyNew = async (id, messageId, taskId) => {
    const agent = client.agents.ref(id);
    await agent.refresh();
    const snapshot = agent.current(),
      timeline = await agent.timeline.refetch({ limit: 1 });
    if (
      snapshot?.cwd !== path.join(HOME, "tasks", messageId) ||
      snapshot.labels?.owner !== "orca-control" ||
      snapshot.labels?.task !== taskId ||
      snapshot.lastUserMessageAt ||
      !Array.isArray(timeline?.entries) ||
      timeline.entries.length ||
      timeline.error ||
      timeline.hasOlder ||
      timeline.gap ||
      timeline.reset ||
      timeline.staleCursor
    )
      throw Error("Fresh managed native session identity cannot be established");
  };
  return {
    currentBoot: verifyActivation,
    verifyNew,
    close: async () => {
      activation.close();
      await Promise.allSettled([watching.close(), channel.close(), client.dispose()]);
      await daemon.close();
    },
    permission: inputs.permission,
    // H7 item 5 (merged): the journaled answer to a pending question, provenance-bound like permission and admitted
    // by the bound policy's admitQuestionAnswer (hook-journal-policy.mjs), never as a tool/file/command permission.
    answer: inputs.answer,
    permissionResult: (id, callId, cursor) =>
      permissionResultFor(client.agents.ref(id), callId, cursor),
    completion: (id, messageId, progress) =>
      completionFor(client.agents.ref(id), messageId, progress),
    snapshot: async (id) => {
      const agent = client.agents.ref(id);
      await agent.refresh();
      const value = agent.current();
      if (!value) throw Error("Native snapshot unavailable");
      return value;
    },
    cleanupIdle: async (id, observed, archive, intent) => {
      verifyActivation();
      const kind = archive ? "archive" : "close",
        messageId = "orca-cleanup:" + intent;
      const inputProvenance = await issueProvenance({
        agentId: id,
        kind,
        messageId,
        attemptId: intent,
        payloadDigest: payloadDigest(id, kind, messageId, {
          type: "command",
          command: kind,
          arguments: {},
        }),
      });
      verifyActivation();
      await daemon.cleanupIdleAgent({
        agentId: id,
        archive,
        messageId,
        inputProvenance,
        runtimeInstanceId: observed.runtimeInstanceId,
        updatedAt: observed.updatedAt,
        lastUserMessageAt: observed.lastUserMessageAt ?? null,
        boot: observed.inputSequence.boot,
        humanAt: observed.inputSequence.humanAt,
      });
      verifyActivation();
    },
    automaticResumeEnabled: async () => {
      verifyActivation();
      const { config } = await daemon.getDaemonConfig();
      verifyActivation();
      return config.autoResumeOnLimit !== false;
    },
    quota: async (id) => {
      verifyActivation();
      const quota = await readNativeQuota(client, daemon, id);
      verifyActivation();
      return quota;
    },
    // The host's own feature flags, from the verified daemon connection (v1.13 R3-1: ctx.device is checked here).
    hostFeature: (name) => daemon.getLastServerInfoMessage()?.features?.[name] === true,
    // v1.13 R3-2: the human-typed messages of a session after a timeline point, read by the controller itself. A prompt
    // that claims the controller prefix is not human input. Refuses rather than guesses when the timeline is broken.
    async humanMessagesSince(id, since) {
      const agent = client.agents.ref(id);
      await agent.refresh();
      const page = await agent.timeline.refetch({ limit: 100 });
      if (page.gap || page.reset || page.staleCursor || !since || page.epoch !== since.epoch)
        throw new Error("Native timeline is incomplete");
      return (page.entries ?? [])
        .filter(
          (e) =>
            e.item?.type === "user_message" &&
            e.seqStart > since.seq &&
            !projectPromptId(e.item.clientMessageId ?? e.item.messageId ?? "").promptClaimsControl,
        )
        .sort((a, b) => a.seqStart - b.seqStart)
        .map((e) => ({ seq: e.seqStart, text: String(e.item.text ?? "").slice(0, 4000) }));
    },
    subscribe: (handler) =>
      client.agents.subscribe((update) => {
        if (update.kind === "upsert") handler(update.agent);
      }),
    watch: () => watching.watch(),
    receipt: (id, messageId, text) => receiptFor(id, CONTROL_PREFIX + messageId, text),
    refreshTools: (id, messageId) =>
      refreshToolsFor(client.agents.ref(id), messageId, verifyActivation),
    // H7 items 3-4 (provider-recovery.mjs): restart the provider runtime in place with its history -- the daemon's fenced
    // same-config reconnect (agent.mcp.refresh, reconnect: true), admitted by the guard's mcpRefreshAdmission.
    recover: async (id) => {
      verifyActivation();
      if (daemon.getLastServerInfoMessage()?.features?.agentMcpReconnect !== true)
        throw Error("This host cannot restart a session in place");
      const s = await daemon.getAgentMcpRefreshState(id);
      if (!s) throw Error("Session unavailable");
      const r = await daemon.refreshAgentMcp({
        agentId: id,
        expected: {
          provider: s.provider,
          sessionId: s.sessionId,
          configRevision: s.configRevision,
        },
        changes: {},
        reconnect: true,
      });
      verifyActivation();
      return { outcome: r.outcome, reason: r.reason ?? null };
    },
    contextRotationState: (id) => daemon.getAgentMcpRefreshState(id),
    rotateContext: (request) => daemon.rotateAgentContext(request),
    compactionTail: async (id, cursor) => {
      verifyActivation();
      const agent = client.agents.ref(id);
      await agent.refresh();
      if (agent.current()?.status !== "running") return null;
      const page = await agent.timeline.refetch({
        limit: 128,
        projection: "canonical",
        ...(cursor ? { direction: "after", cursor } : {}),
      });
      verifyActivation();
      return {
        ...page,
        status: page.agent?.status ?? agent.current()?.status,
        maxSeq: page.window?.maxSeq,
      };
    },
    // Fresh start: the provider-reported context usage and whether the session is busy. Read-only.
    contextUsage: async (id) => {
      verifyActivation();
      const agent = client.agents.ref(id);
      await agent.refresh();
      const snapshot = agent.current();
      if (!snapshot) return null;
      const work = snapshot.backgroundWork?.count;
      return {
        status: snapshot.status,
        used: snapshot.lastUsage?.contextWindowUsedTokens ?? null,
        limit: snapshot.lastUsage?.contextWindowMaxTokens ?? null,
        background: Number.isInteger(work) && work > 0 ? work : 0,
        pending: snapshot.pendingPermissions?.length ?? 0,
        lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
      };
    },
    // H6 item 6: the session's state and the newest timeline entries, for usage-limit detection. Read-only.
    limitTail: async (id) => {
      verifyActivation();
      const agent = client.agents.ref(id);
      await agent.refresh();
      const snapshot = agent.current();
      if (!snapshot) throw Error("Session unavailable");
      const page = await agent.timeline.refetch({ limit: 4, projection: "canonical" });
      if (page.gap || page.reset || page.staleCursor || page.error)
        throw Error("Native timeline is incomplete");
      return {
        provider: snapshot.provider,
        status: snapshot.status,
        updatedAt: snapshot.updatedAt ?? null,
        lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
        entries: page.entries ?? [],
        maxSeq: page.window?.maxSeq,
      };
    },
    // Update-7: `parent` (the session that asked for this one: a manager or a seat holder) and `project` are recorded as
    // labels, so every host's Sessions and Organisation show who owns it. Never the product's parent label: archiving a
    // parent there cascades to its children.
    async create(a, { fresh = false, parent = null, project = null } = {}) {
      verifyActivation();
      const memory = canonicalMemoryConfig(a.provider);
      const cwd = path.join(HOME, "tasks", a.messageId);
      fs.mkdirSync(path.dirname(cwd), { recursive: true, mode: 0o700 });
      fs.mkdirSync(cwd, { recursive: !fresh, mode: 0o700 });
      if (fs.realpathSync(cwd) !== cwd) throw new Error("Session directory contains symlink");
      // One capability-aware selector, so no creation path inlines its own options object and drifts.
      // The model comes from it too, now. It used to be chosen here from a hardcoded family/model literal
      // naming the previous Opus release -- an explicit pin, which resolveProviderModel returns verbatim --
      // so every session this path created ignored the model the host advertises as its default and came
      // up on that literal. session-config.test.mjs now fails on such a literal anywhere outside the
      // selector, which is why this comment describes it instead of quoting it.
      // A portable installation still wins, because its providers map is a deliberate per-installation
      // choice made before session defaults existed; sessionDefaults supplies the value for everyone else.
      // DESIGN-NEXT-BUILD A2/A4: the role (when the path knows it) selects a default between the override and the
      // installation; checkCapability verifies role/override values against the installed provider's model list.
      const { chosen, fallback } = await checkCapability(
        client,
        a.provider,
        sessionDefaults(a.provider, a.defaults, undefined, a.role ?? null),
        cwd,
        () => sessionDefaults(a.provider, a.defaults),
      );
      const provider = await resolveProviderModel(client, creationModel(a.provider, chosen), cwd);
      const config = {
        provider,
        modeId: chosen.modeId,
        thinkingOptionId: chosen.thinkingOptionId,
        ...(chosen.options ? { options: chosen.options } : {}),
        systemPrompt: `You are an independent Orca session assigned to task ${a.taskId}. Work only on the stated outcome and in your owned directory. Explain consequential design or cross-system choices before acting. Produce, review and verify actual outputs; an idle turn is not task acceptance. Preserve existing repair owners, provider settings and Radius holds. Do not create schedules, contact unrelated sessions or publish without task authority.`,

        // H6 item 5: the Orca tool surface comes from tool-surface.mjs, the one definition refreshTools also uses.
        mcpServers: { [SUPERVISOR_SERVER]: supervisorServer(a.messageId), [MEMORY_SERVER]: memory },
        toolPolicy: toolPolicy(),
      };
      const agent = await client.agents.create({
        idempotencyKey: a.messageId,
        config,
        cwd,
        title: a.title,
        env: { PASEO_PASSWORD: "" },
        labels: {
          owner: "orca-control",
          task: a.taskId,
          "orca.manager-tools": "1",
          ...(a.role ? { "fulcra.role": a.role } : {}),
          ...(uuidLike(parent) ? { "fulcra.parent-session": parent } : {}),
          ...(uuidLike(project) ? { "fulcra.project": project } : {}),
        },
      });
      if (fresh) await verifyNew(agent.id, a.messageId, a.taskId);
      // H7 item 5: preserve the creation's durable session identity file.
      const sessionIdFile = writeSessionId(cwd, agent.id);
      // Creation already succeeded. Failure to observe its instance must only disable bootstrap.
      let runtimeInstanceId;
      try {
        await agent.refresh();
        runtimeInstanceId = agent.current()?.runtimeInstanceId;
      } catch {
        /* Do not reuse a cached identity or turn a delivered creation into uncertainty. */
      }
      // C2 #5: the workspace is named after tasks/<messageId> (a UUID); give it the session title. Cosmetic, so never fatal.
      await nameNewWorkspace({ agents: client.agents, daemon }, agent.id, a.title).catch(() => {});
      // `provider` is the RESOLVED selection, so a caller sees the model the session actually got rather
      // than the bare family that asked for it. Without this, "did the default apply" is unanswerable
      // from the creation result and has to be measured from the process table afterwards.
      return {
        id: agent.id,
        cwd,
        sessionIdFile,
        ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
        managerToolsVersion: "1",
        roleToolsVersion: "1",
        toolSurface: TOOL_SURFACE,
        model: provider,
        mode: {
          modeId: chosen.modeId,
          thinkingOptionId: chosen.thinkingOptionId,
          automatic: chosen.automatic,
          source: chosen.source,
        },
        role: chosen.role ?? null,
        ...(fallback.length ? { fallback } : {}),
      };
    },
    // C2 #5: one-off, best-effort titles for workspaces of sessions created before the fix.
    nameWorkspaces: (ids) => nameExistingWorkspaces({ agents: client.agents, daemon }, ids),
    // Update-7 W3: an explicit model / effort this host's provider does not list is refused before anything is created.
    checkOverride: (a) => checkOverride(client, a.provider, a.defaults, HOME),
    checkProvider: (provider) => checkProvider(client, provider, HOME),
    // DESIGN-NEXT-BUILD A4 (C10): what a creation under this role would launch here, checked exactly as create() checks it.
    async roleCapability(provider, role) {
      const configured = sessionDefaults(provider, {}, undefined, role),
        { chosen, fallback } = await checkCapability(client, provider, configured, HOME, () =>
          sessionDefaults(provider),
        );
      const pick = (d) => ({
        model: d.model,
        thinkingOptionId: d.thinkingOptionId,
        modeId: d.modeId,
        source: d.source,
      });
      return { configured: pick(configured), effective: pick(chosen), fallback };
    },
    async inspect(id) {
      const boot = verifyActivation();
      const agent = client.agents.ref(id);
      await agent.refresh();
      const snapshot = agent.current();
      if (!snapshot) throw new Error("Session unavailable");
      const barrier = hostInputFence(snapshot, boot);
      let page = await agent.timeline.refetch({ limit: 100 }),
        users = [];
      const timelineCursor = { epoch: page.epoch, seq: page.window.maxSeq };
      for (let n = 0; n < 20; n++) {
        if (page.gap || page.reset || page.staleCursor)
          throw new Error("Native timeline is incomplete");
        users = (page.entries ?? [])
          .filter((e) => e.item?.type === "user_message")
          .sort((a, b) => a.seqStart - b.seqStart);
        if (users.length || !page.hasOlder || !page.startCursor) break;
        page = await agent.timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit: 100,
        });
      }
      const last = users.at(-1),
        rawPromptId = last ? (last.item.clientMessageId ?? last.item.messageId) : null;
      const { promptClaimsControl, lastPromptId } = projectPromptId(rawPromptId);
      if ((last && !lastPromptId) || (!last && snapshot.lastUserMessageAt))
        throw new Error("Latest human-input identity cannot be established");
      const identity = nativeIdentity(snapshot);
      return {
        id,
        boot,
        runtimeInstanceId: snapshot.runtimeInstanceId ?? null,
        model: snapshot.runtimeInfo?.model ?? snapshot.model,
        serviceTier: snapshot.features?.some(
          (f) => f.id === "fast_mode" && f.type === "toggle" && f.value === true,
        )
          ? "fast"
          : null,
        fenceProtocol: barrier.fenceProtocol,
        saturated: barrier.saturated,
        humanAt: barrier.humanAt,
        timelineCursor,
        status: snapshot.status,
        archivedAt: snapshot.archivedAt ?? null,
        pending: snapshot.pendingPermissions?.length ?? 0,
        nativeId: identity.nativeId,
        nativeIdentity: identity,
        lastPromptId,
        promptClaimsControl,
        lastUserAt: snapshot.lastUserMessageAt ?? null,
        observedAt: new Date().toISOString(),
        lastError: snapshot.lastError ?? null,
        interruptedTurn: snapshot.interruptedTurn ?? null,
      };
    },
    send: inputs.send,
    sendQueued: inputs.sendQueued,
  };
}
