import { localMachine } from "../../src/local-machine.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
const home = localMachine("legacyControllerHome");
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === keys;
export function privateJson(file, limit) {
  if (fs.realpathSync(file) !== file) throw Error("Private binding path changed");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit)
      throw Error("Invalid private binding file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
export function origin(context, trustedOwnerSessionKey) {
  if (
    context?.senderIsOwner !== true ||
    typeof context.agentId !== "string" ||
    !context.agentId ||
    typeof context.sessionKey !== "string" ||
    !context.sessionKey ||
    !uuid(context.sessionId)
  )
    throw Error("Trusted owner conversation required");
  const local =
    (context.oneShotCliRun === true ||
      (typeof trustedOwnerSessionKey === "string" &&
        trustedOwnerSessionKey === context.sessionKey)) &&
    !context.nativeChannelId &&
    !context.requesterSenderId &&
    (!context.messageChannel || context.messageChannel === "webchat");
  if (
    !local &&
    (typeof context.nativeChannelId !== "string" ||
      !context.nativeChannelId ||
      typeof context.requesterSenderId !== "string" ||
      !context.requesterSenderId)
  )
    throw Error("Trusted channel and sender required");
  return {
    mode: local ? "local" : "channel",
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    requesterSenderId: context.requesterSenderId ?? null,
    nativeChannelId: context.nativeChannelId ?? null,
  };
}
export const bindingName = (value) => hash(JSON.stringify(value)) + ".json";
export function loadBinding({
  currentOrigin,
  bindingsDir,
  read = privateJson,
  grantsDir = `${home}/grants`,
}) {
  const encodedOrigin = JSON.stringify(currentOrigin);
  if (!path.isAbsolute(bindingsDir)) throw Error("Absolute private bindings directory required");
  const binding = read(path.join(bindingsDir, bindingName(currentOrigin)), 8192);
  if (
    !exact(binding, "generation,origin,sessionId,taskId,version") ||
    binding.version !== 1 ||
    JSON.stringify(binding.origin) !== encodedOrigin ||
    !uuid(binding.sessionId) ||
    !uuid(binding.taskId) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1
  )
    throw Error("Invalid conversation binding");
  const grant = read(path.join(grantsDir, `${binding.sessionId}-${binding.generation}.json`), 1024);
  if (
    grant.sessionId !== binding.sessionId ||
    grant.generation !== binding.generation ||
    !/^[A-Za-z0-9_-]{43}$/.test(grant.capability)
  )
    throw Error("Invalid bound delegation");
  return { binding, capability: grant.capability };
}
export function createRelay({
  context,
  bindingsDir,
  trustedOwnerSessionKey,
  request,
  read = privateJson,
  grantsDir = `${home}/grants`,
  wake,
  checkCall = () => {},
}) {
  checkCall();
  wake?.check();
  const currentOrigin = wake ? wake.binding.origin : origin(context, trustedOwnerSessionKey);
  if (wake && !["agentId", "sessionKey", "sessionId"].every((k) => context[k] === currentOrigin[k]))
    throw Error("Wake conversation changed");
  const load = () => loadBinding({ currentOrigin, bindingsDir, read, grantsDir });
  return async (action, args, toolCallId, signal) => {
    checkCall();
    signal?.throwIfAborted();
    if (
      !["status", "assign", "result", "ack"].includes(action) ||
      !exact(
        args,
        action === "assign"
          ? "text"
          : action === "result"
            ? "messageId"
            : action === "ack"
              ? "messageId,outputEvidenceHash"
              : "",
      )
    )
      throw Error("Invalid ingress arguments");
    if (
      action === "assign" &&
      (typeof args.text !== "string" || !args.text.trim() || Buffer.byteLength(args.text) > 16384)
    )
      throw Error("Nonempty instruction within 16384 UTF-8 bytes required");
    if (action === "result" && !uuid(args.messageId)) throw Error("Valid delivery ID required");
    let bound;
    try {
      bound = load();
    } catch (error) {
      if (action === "status" && error.code === "ENOENT")
        return {
          bound: false,
          origin: currentOrigin,
          note: "An operator must bind this exact conversation before control is available.",
        };
      throw error;
    }
    const fingerprint = hash(JSON.stringify(bound));
    const fresh = () => {
      checkCall();
      wake?.check();
      signal?.throwIfAborted();
      if (hash(JSON.stringify(load())) !== fingerprint)
        throw Error("Conversation binding changed; refresh before proceeding");
    };
    const call = (method, input) => request({ method, input, capability: bound.capability });
    const status = await call("inspect", bound.binding.sessionId);
    fresh();
    if (
      status.id !== bound.binding.sessionId ||
      status.task !== bound.binding.taskId ||
      status.mode !== "delegated" ||
      status.generation !== bound.binding.generation
    )
      throw Error("Bound session ownership changed");
    if (action === "status")
      return {
        bound: true,
        sessionId: status.id,
        taskId: status.task,
        generation: status.generation,
        nativeState: status.observed.status,
        pendingPermissions: status.observed.pending,
        observedAt: status.observed.observedAt,
        deliveries: status.deliveries.map((d) => {
          const n = JSON.parse(d.result ?? "{}").notification;
          return {
            messageId: d.id,
            kind: d.kind,
            state: d.state,
            ...(n
              ? {
                  notification: {
                    id: n.id,
                    state: n.state,
                    supersededBy: n.supersededBy ?? null,
                    observedAt: n.observedAt,
                  },
                }
              : {}),
          };
        }),
        accepted: false,
      };
    if (wake) {
      if (["result", "ack"].includes(action) && args.messageId !== wake.binding.sourceMessageId)
        throw Error("Wake is scoped to another delivery");
      fresh();
      const input = {
        sessionId: status.id,
        notificationId: wake.notificationId,
        originHash: hash(JSON.stringify(currentOrigin)),
      };
      const method =
        action === "result" ? "notify-read" : action === "ack" ? "notify-ack" : "notify-assign";
      const result = await call(method, {
        ...input,
        ...(action === "assign"
          ? { text: args.text }
          : action === "ack"
            ? { outputEvidenceHash: args.outputEvidenceHash }
            : {}),
      });
      fresh();
      return result;
    }
    if (action === "ack") throw Error("Completion acknowledgment requires its current wake");
    if (action === "result") {
      const result = await call("ingress-result", {
        sessionId: status.id,
        messageId: args.messageId,
        originHash: hash(JSON.stringify(currentOrigin)),
      });
      fresh();
      return result;
    }
    if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 512)
      throw Error("Runtime tool call identity required");
    const proposedId = randomUUID(),
      originHash = hash(JSON.stringify(currentOrigin));
    const messageId = await call("ingress-prepare", {
      sessionId: status.id,
      messageId: proposedId,
      text: args.text,
      originHash,
    });
    fresh();
    if (!uuid(messageId)) throw Error("Controller preparation returned invalid identity");
    let delivery;
    try {
      delivery = await call("ingress-send", {
        sessionId: status.id,
        messageId,
        text: args.text,
        originHash,
      });
    } catch {
      return {
        messageId,
        state: "unconfirmed",
        accepted: false,
        note: "Inspect this delivery before another instruction. A transport failure is not proof that input was unsent.",
      };
    }
    try {
      fresh();
    } catch (error) {
      return {
        messageId,
        state: delivery.state,
        accepted: false,
        note:
          error.code === "ORCA_HOST_CALL_ENDED"
            ? "Receipt retained; the host call run ended after dispatch. Inspect this delivery before another instruction."
            : signal?.aborted
              ? "Call cancelled after dispatch; receipt retained. Inspect status."
              : "Receipt retained; conversation binding changed after dispatch. Future input requires current delegation.",
      };
    }
    return {
      messageId,
      sessionId: status.id,
      state: delivery.state,
      reusedIdentity: messageId !== proposedId,
      accepted: false,
      note: "Identical instructions within this delegation reuse one delivery. Acknowledgment is separate from completed or accepted work.",
    };
  };
}
