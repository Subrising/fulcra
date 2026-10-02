import { permissionMode } from "../control/automatic-permission.mjs";
import { randomUUID } from "node:crypto";
import { permissionChannel } from "../control/permission-channel.mjs";
import { permissionResultFor } from "../control/permission-result.mjs";
import { pageResult } from "../../orca-organization/shared/history.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { secret, bookProvider } from "./protocol.mjs";
import { delegationFence } from "../control/native-fence.mjs";
import { nativeIdentity } from "../control/native-identity.mjs";
import { receiptFor } from "../control/receipt.mjs";
import { completionFor } from "../control/completion.mjs";
import { projectBookActivity } from "./activity.mjs";
import { projectMessages } from "../../orca-organization/shared/work-messages.mjs";
export async function connectBookNative(profile) {
  const source = pathToFileURL(profile.runtimeSource + "/src/host-profile.mjs").href;
  const { profile: load, verifyTree, workerOptions } = await import(source),
    runtime = load(profile.runtimeSource + "/config", "macbook");
  const verify = () => {
    for (const [file, expected] of Object.entries(runtime.pins)) {
      if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected)
        throw Error("Book runtime pin changed");
    }
    verifyTree(runtime.installation + "/node_modules", runtime.installedTree);
  };
  verify();
  const { createPaseoApi } = await import(
    pathToFileURL(runtime.installation + "/node_modules/@getpaseo/client/dist/index.js").href
  );
  const { DaemonClient } = await import(
    pathToFileURL(runtime.installation + "/node_modules/@getpaseo/client/dist/daemon-client.js")
      .href
  );
  process.env.ORCA_HOST = "macbook";
  const daemon = new DaemonClient({
    clientId: "orca-book-receiver-" + randomUUID(),
    clientType: "cli",
    url: "ws://127.0.0.1:6791/ws",
    password: secret(runtime.home + "/controller.secret"),
    connectTimeoutMs: 5000,
  });
  const channel = permissionChannel(daemon, 5000),
    client = createPaseoApi(daemon);
  const close = async () => {
    await Promise.allSettled([channel.close(), client.dispose?.()]);
    await daemon.close();
  };
  try {
    await daemon.connect();
    const { memoryConfig, runtime: loaded } = await import(
      pathToFileURL(profile.runtimeSource + "/src/runtime.mjs").href
    );
    if (loaded.home !== runtime.home || loaded.installation !== runtime.installation)
      throw Error("Wrong imported Book runtime");
    const adapter = bookNative(client, profile, {
      ...runtime,
      optionsFor: (family) => workerOptions(runtime, family),
      memory: memoryConfig(),
    });
    return {
      ...adapter,
      close,
      permission: async (id, intentId) => {
        await channel.ready();
        verify();
        return daemon.respondToPermissionAndWait(
          id,
          "orca-permission:" + intentId,
          { behavior: "allow" },
          10000,
        );
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export function bookMemoryPolicy(provider, memory) {
  if (provider !== "codex") return undefined;
  if (!Object.hasOwn(memory ?? {}, "shared-memory") || !memory["shared-memory"])
    throw Error("Injected canonical memory server required for Book Codex");
  return {
    preapproved: ["shared_memory_read", "shared_memory_search"].map((tool) => ({
      kind: /** @type {const} */ ("mcp"),
      server: "shared-memory",
      tool,
    })),
  };
}
function displayMetadata(snapshot) {
  const label = (value, limit) =>
    typeof value === "string"
      ? Array.from(value, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
          .join("")
          .trim()
          .slice(0, limit) || null
      : null;
  return {
    title: label(snapshot.title, 256),
    model: label(snapshot.runtimeInfo?.model, 120) ?? label(snapshot.model, 120),
  };
}
// DESIGN-NEXT-BUILD A3/A4. What a Book creation runs with. Nothing forwarded: the enrolled model at medium, exactly as
// before. A forwarded model / effort is used only when this host's provider lists it (the controller cannot see this
// host's inventory); otherwise the enrolled value is kept and the fallback is reported back. Never launches an unoffered pair.
export async function bookSelection(client, provider, p, enrolled) {
  const out = { model: enrolled, thinkingOptionId: "medium", fallback: [] };
  if (p.model === undefined && p.thinkingOptionId === undefined) return out;
  let models = null;
  try {
    const inv = await client.providers?.listModels?.(provider, {});
    if (inv && !inv.error && inv.provider === provider && Array.isArray(inv.models))
      models = inv.models.filter(
        (m) => m?.provider === provider && m.isSelectable !== false && typeof m.id === "string",
      );
  } catch {
    /* unavailable: keep the enrolled values */
  }
  const why = (reason) => (models ? reason : "catalog-unavailable");
  if (p.model !== undefined) {
    if (models?.some((m) => m.id === p.model)) out.model = p.model;
    else
      out.fallback.push({
        field: "model",
        requested: p.model,
        used: enrolled,
        reason: why("model-not-offered"),
      });
  }
  if (p.thinkingOptionId !== undefined) {
    const offered = (models?.find((m) => m.id === out.model)?.thinkingOptions ?? []).map(
      (o) => o?.id,
    );
    if (offered.includes(p.thinkingOptionId)) out.thinkingOptionId = p.thinkingOptionId;
    else
      out.fallback.push({
        field: "thinkingOptionId",
        requested: p.thinkingOptionId,
        used: "medium",
        reason: why("effort-not-offered"),
      });
  }
  return out;
}
export function bookNative(client, profile, runtime) {
  const ref = (id) => client.agents.ref(id);
  const snapshot = async (id) => {
    const a = ref(id);
    await a.refresh();
    const s = a.current();
    if (!s) throw Error("Book session unavailable");
    return s;
  };
  return {
    tasks: profile.tasks,
    permissionResult: (id, callId, cursor) => permissionResultFor(ref(id), callId, cursor),
    async create(p) {
      const provider = bookProvider(p),
        options = runtime.optionsFor(provider),
        toolPolicy = bookMemoryPolicy(provider, runtime.memory);
      const enrolled = provider === "codex" ? "gpt-6-astra" : runtime.workerModels?.claude;
      if (
        provider === "claude" &&
        (typeof enrolled !== "string" || !/^claude-[a-z0-9][a-z0-9.-]{1,100}$/.test(enrolled))
      )
        throw Error("Explicit enrolled Book Claude model required");
      // DESIGN-NEXT-BUILD A3/A4: a forwarded role (or explicit) model / effort is used only if THIS host's provider offers it.
      const selection = await bookSelection(client, provider, p, enrolled),
        model = selection.model;
      const cwd = path.join(profile.tasks, p.messageId);
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(cwd) !== cwd) throw Error("Book task directory changed");
      const agent = await client.agents.create({
        idempotencyKey: p.messageId,
        cwd,
        title: p.title,
        env: { PASEO_PASSWORD: "" },
        labels: { owner: "orca-book-task", task: p.taskId, "orca.route": p.sessionId },
        config: {
          provider: provider + "/" + model,
          thinkingOptionId: selection.thinkingOptionId,
          options,
          ...(toolPolicy ? { toolPolicy } : {}),
          mcpServers: runtime.memory,
          systemPrompt:
            provider === "claude"
              ? `You are an independent persistent Claude session assigned to Paperclip task ${p.taskId} by the Codex Orca orchestrator, not David. Work only on the assigned outcome in your owned directory. No peer delegation, external messages, publication, service changes or Radius launch/teardown. Human takeover wins. A turn ending is not verified task completion.`
              : `You are an independent persistent Codex session assigned to Paperclip task ${p.taskId} by the Codex Orca orchestrator, not David. Work only on the assigned outcome in your owned directory. No peer delegation, Claude, external messages, publication, service changes or Radius launch/teardown. Human takeover wins. A turn ending is not verified task completion.`,
        },
      });
      const s = await snapshot(agent.id),
        page = await ref(agent.id).timeline.refetch({ limit: 1 });
      if (
        s.provider !== provider ||
        s.cwd !== cwd ||
        s.labels?.["orca.route"] !== p.sessionId ||
        s.labels?.task !== p.taskId ||
        s.labels?.owner !== "orca-book-task" ||
        s.lastUserMessageAt ||
        !Array.isArray(page.entries) ||
        page.entries.length ||
        page.error ||
        page.hasOlder ||
        page.gap ||
        page.reset ||
        page.staleCursor
      )
        throw Error("Fresh Book session identity cannot be established");
      return {
        id: agent.id,
        cwd,
        ...(selection.fallback.length || p.model !== undefined || p.thinkingOptionId !== undefined
          ? {
              selection: {
                model: selection.model,
                thinkingOptionId: selection.thinkingOptionId,
                fallback: selection.fallback,
              },
            }
          : {}),
      };
    },
    async inspect(id) {
      const s = await snapshot(id),
        b = JSON.parse(s.labels?.["orca.native-barrier"] ?? "null");
      delegationFence(b);
      if (b.receiverRelease !== profile.release) throw Error("Reviewed Book guard is not active");
      let page = await ref(id).timeline.refetch({ limit: 100 }),
        last;
      const timelineCursor = { epoch: page.epoch, seq: page.window?.maxSeq };
      if (typeof timelineCursor.epoch !== "string" || !Number.isSafeInteger(timelineCursor.seq))
        throw Error("Invalid Book timeline cursor");
      for (let n = 0; n < 20; n++) {
        if (
          page.error ||
          page.gap ||
          page.reset ||
          page.staleCursor ||
          page.epoch !== timelineCursor.epoch
        )
          throw Error("Incomplete Book timeline");
        last = (page.entries ?? [])
          .filter((e) => e.item?.type === "user_message")
          .sort((a, b) => a.seqStart - b.seqStart)
          .at(-1);
        if (last || !page.hasOlder) break;
        if (!page.startCursor || n === 19) throw Error("Book timeline bound exceeded");
        page = await ref(id).timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit: 100,
        });
      }
      const raw = last?.item.clientMessageId ?? last?.item.messageId ?? null,
        identity = nativeIdentity(s);
      if ((last && !raw) || (!last && s.lastUserMessageAt) || identity.conflict)
        throw Error("Book input/native identity unavailable");
      return {
        id,
        cwd: s.cwd,
        provider: s.provider,
        currentModeId: permissionMode(s),
        ...displayMetadata(s),
        owner: s.labels?.owner,
        task: s.labels?.task,
        route: s.labels?.["orca.route"],
        ...b,
        status: s.status,
        pending: s.pendingPermissions?.length ?? 0,
        pendingPermissions: s.pendingPermissions ?? [],
        activeTurn: s.activeTurn ?? null,
        attentionTimestamp: s.attentionTimestamp ?? null,
        attentionReason: s.attentionReason ?? null,
        archivedAt: s.archivedAt ?? null,
        lastPromptId: raw?.startsWith("orca-control:") ? raw.slice(13) : raw,
        lastUserAt: s.lastUserMessageAt ?? null,
        nativeId: identity.nativeId,
        nativeIdentity: identity,
        timelineCursor,
        observedAt: new Date().toISOString(),
        lastError: s.lastError ?? null,
      };
    },
    async activityIdentity(id) {
      const s = await snapshot(id),
        b = JSON.parse(s.labels?.["orca.native-barrier"] ?? "null");
      delegationFence(b);
      const identity = nativeIdentity(s);
      if (b.receiverRelease !== profile.release || identity.conflict)
        throw Error("Book activity native identity unavailable");
      return {
        id,
        cwd: s.cwd,
        provider: s.provider,
        owner: s.labels?.owner,
        task: s.labels?.task,
        route: s.labels?.["orca.route"],
        ...b,
        status: s.status,
        pending: s.pendingPermissions?.length ?? 0,
        archivedAt: s.archivedAt ?? null,
        nativeId: identity.nativeId,
        nativeIdentity: identity,
        lastUserAt:
          s.lastUserMessageAt == null ? null : new Date(s.lastUserMessageAt).toISOString(),
        observedAt: new Date().toISOString(),
      };
    },
    activity: async (id, cwd) =>
      projectBookActivity(
        await ref(id).timeline.refetch({ limit: 50, projection: "canonical" }),
        cwd,
      ),
    activityPage: async (id, cwd, request, scope, includeMessages = false) => {
      const p = await ref(id).timeline.refetch(request),
        continuation = pageResult(p, request, scope, id);
      return {
        ...projectBookActivity(
          {
            ...p,
            entries: p.entries.slice(-50),
            hasOlder: continuation.cursor !== null,
            hasNewer: false,
          },
          cwd,
        ),
        ...continuation,
        ...(includeMessages ? { messages: projectMessages(p.entries) } : {}),
      };
    },
    send: (id, text, messageId) => ref(id).send(text, { messageId: "orca-control:" + messageId }),
    receipt: (id, messageId, text) =>
      receiptFor(id, "orca-control:" + messageId, text, runtime.home + "/agent-requests"),
    completion: (id, messageId, progress) => completionFor(ref(id), messageId, progress),
  };
}
