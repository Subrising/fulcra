import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { origin, privateJson } from "./relay.mjs";
// Fulcra J3b (CONTRACTS v1.6 §3.5): the Fulcra inbox in a paired Discord/OpenClaw conversation. The owner-verified
// origin comes ONLY from the runtime tool context (senderIsOwner strictly true, bound agent, channel and sender), via
// the existing origin() check; tool arguments can never carry or change it. The controller then compares it with
// the hashes it stored at pairing. Held-message bodies are never returned: the controller does not send them.
// v1.13 R3-3: every call carries the OpenClaw conversation (sessionKey) and the owner turn it arrived in (runId); the
// controller refuses a turn it has already seen. Residual (stated in CONTRACTS §3.5 rule 2): the controller trusts
// this report, which a same-user process holding the channel file could imitate until origins are gateway-signed.
// v1.13 R3-4: this relay does not edit chat posts (no Gateway change); updates ride in list replies, and the
// controller settles one only when a later owner turn lists again.
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === keys;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function chatOrigin(context) {
  const o = origin(context);
  if (o.mode !== "channel")
    throw Error("The Fulcra inbox answers only in a paired chat conversation");
  if (typeof context.runId !== "string" || !context.runId || context.runId.length > 200)
    throw Error("Trusted owner turn required");
  return {
    senderIsOwner: true,
    agentId: o.agentId,
    nativeChannelId: o.nativeChannelId,
    senderId: o.requesterSenderId,
    sessionKey: o.sessionKey,
    turnId: context.runId,
  };
}
// The binding file name is the conversation's, not the turn's: the same file serves every later turn.
// One private binding per (agent, chat channel, owner sender), written at pairing: { version, channelId, capability }.
export const inboxBindingName = (o) =>
  `inbox-channel-${hash(JSON.stringify([o.agentId, o.nativeChannelId, o.senderId]))}.json`;
function writePrivate(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}
export function createInboxRelay({
  context,
  bindingsDir,
  request,
  read = privateJson,
  write = writePrivate,
}) {
  const current = chatOrigin(context);
  if (!path.isAbsolute(bindingsDir)) throw Error("Absolute private bindings directory required");
  const file = path.join(bindingsDir, inboxBindingName(current));
  const listed = () => call("cc-inbox-list", { origin: current });
  const bound = () => {
    const b = read(file, 1024);
    if (
      !exact(b, "capability,channelId,version") ||
      b.version !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(b.capability)
    )
      throw Error("Invalid inbox channel binding");
    return b;
  };
  const call = (method, input) => {
    const b = bound();
    return request({
      method,
      input: { channelId: b.channelId, ...input },
      capability: b.capability,
    });
  };
  const itemAt = async (n) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 50)
      throw Error("Use the number shown in the list");
    const item = (await listed()).items.find((i) => i.n === n);
    if (!item) throw Error("That number is not in the list any more; list again");
    return item;
  };
  return async (action, args, signal) => {
    signal?.throwIfAborted();
    const shape = { pair: "code", list: "", show: "n", answer: "confirm,n,note,option" }[action];
    if (shape === undefined || !exact(args, shape)) throw Error("Invalid inbox arguments");
    if (action === "pair") {
      if (typeof args.code !== "string" || !/^\d{6}$/.test(args.code))
        throw Error("Type the 6-digit code shown in the Fulcra app");
      const r = await request({
        method: "cc-channel-pair",
        input: { code: args.code, origin: current },
      });
      write(file, { version: 1, channelId: r.channel.id, capability: r.capability });
      return {
        paired: true,
        label: r.channel.label,
        answersCountAsYou: r.channel.answersCountAsOwner,
        text: r.channel.answersCountAsOwner
          ? "Paired. Answers you give here count as yours."
          : "Paired. Answers given here are marked as answered by the operator until you pair from a confirmed device.",
      };
    }
    if (action === "list") return { text: (await listed()).text };
    const item = await itemAt(args.n);
    if (action === "show") return { text: (await call("cc-inbox-show", { key: item.key })).text };
    const shown = await call("cc-inbox-show", { key: item.key });
    if (!shown.decision) throw Error("Only decisions can be answered here");
    const option =
      typeof args.option === "number"
        ? shown.decision.options.find((o) => o.n === args.option)
        : shown.decision.options.find(
            (o) =>
              o.id === args.option || o.title.toLowerCase() === String(args.option).toLowerCase(),
          );
    if (!option && !(shown.decision.options.length === 0 && args.option === "answer"))
      throw Error("Name one of the numbered options");
    if (typeof args.note !== "string" || args.note.length > 500)
      throw Error("Keep the note under 500 characters");
    if (typeof args.confirm !== "boolean") throw Error("Invalid inbox arguments");
    // §3.2 #3 in chat: a hard-to-undo option is sent only on a second, explicit confirmation.
    if (option?.destructive && args.confirm !== true)
      return {
        text: `"${option.title}" is hard to undo. Answer again with confirm to proceed.`,
        needsConfirmation: true,
      };
    signal?.throwIfAborted();
    const r = await call("cc-inbox-answer", {
      key: item.key,
      optionId: option?.id ?? "answer",
      note: args.note,
      messageId: randomUUID(),
      expectedRevision: shown.decision.revision,
      confirmDestructive: option?.destructive === true && args.confirm === true,
      origin: current,
    });
    return { text: r.text };
  };
}
