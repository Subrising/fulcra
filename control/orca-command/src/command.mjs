import { localJson } from "../../src/local-machine.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadBinding, privateJson } from "../../orca-ingress/src/relay.mjs";
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const privateReplies = (root, account) =>
  root?.channels?.discord?.slashCommand?.ephemeral === true &&
  Object.entries(root.channels.discord.accounts ?? {})
    .filter(([key]) => key.trim().toLowerCase() === account.trim().toLowerCase())
    .every(([, value]) => [undefined, true].includes(value?.slashCommand?.ephemeral));
const help =
  "Fulcra: sessions [page] · delegate <session UUID> <generation> · ask <instruction> · status · send <request UUID> <instruction> · result <receipt UUID> · ack <receipt UUID>. Receipts track delivery; output and acceptance are separate. Ack releases retained preparation, allowing an identical instruction with a new UUID.";
export function commandOrigin(config) {
  if (
    !config ||
    !["accountId", "conversationId", "senderId"].every(
      (k) => typeof config[k] === "string" && config[k].length > 0 && config[k].length <= 128,
    ) ||
    !uuid(config.sessionId) ||
    !path.isAbsolute(config.bindingsDir ?? "")
  )
    throw Error("Invalid command configuration");
  return Object.freeze({
    accountId: config.accountId,
    conversationId: config.conversationId,
    provider: "discord",
    senderId: config.senderId,
    sessionId: config.sessionId,
  });
}
/** @returns {{action: 'help'|'status'|'sessions'|'delegate'|'send'|'result'|'ack', page?: number, sessionId?: string, generation?: number, messageId?: string, text?: string}} */
export function parseCommand(ctx) {
  const raw = ctx.commandBody;
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw) > 4096 ||
    [...raw].some((c) => {
      const code = c.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    }) ||
    !raw.isWellFormed()
  )
    throw Error("Command text was altered or exceeds 4096 UTF-8 bytes");
  const match = /^\/orca(?:[ \t\n]+([\s\S]*))?$/.exec(raw);
  if (
    !match ||
    (match[1] ?? "") !== (ctx.args ?? "") ||
    (ctx.args !== undefined && typeof ctx.args !== "string")
  )
    throw Error("Command text was altered or exceeds 4096 UTF-8 bytes");
  const args = match[1] ?? "";
  if (!args || args === "help") return { action: "help" };
  if (args === "sessions") return { action: "sessions", page: 1 };
  const page = /^sessions ([1-9][0-9]{0,3})$/.exec(args);
  if (page) return { action: "sessions", page: Number(page[1]) };
  const delegate = /^delegate ([a-f0-9-]+) ([1-9][0-9]{0,14})$/.exec(args);
  if (delegate && uuid(delegate[1]))
    return { action: "delegate", sessionId: delegate[1], generation: Number(delegate[2]) };
  const ask = /^ask[ \t\n]+([\s\S]+)$/.exec(args);
  if (ask?.[1].trim()) return { action: "send", messageId: randomUUID(), text: ask[1].trim() };
  if (args === "status") return { action: "status" };
  const command = /^(send|result|ack) ([a-f0-9-]+)(?:[ \t\n]+([\s\S]+))?$/.exec(args);
  if (
    !command ||
    !uuid(command[2]) ||
    (command[1] === "send" ? !command[3]?.trim() : command[3] !== undefined)
  )
    throw Error("Invalid command syntax");
  return {
    action: /** @type {'send'|'result'|'ack'} */ (command[1]),
    messageId: command[2],
    ...(command[1] === "send" ? { text: command[3].trim() } : {}),
  };
}
const refusal = (error) => {
  if (error.message === "Ingress request identity conflict")
    return "Request ID conflicts with retained work. Use its original receipt or a new UUID for a different instruction.";
  if (error.message?.includes("capacity reached"))
    return "Receipt capacity reached. Acknowledge confirmed receipts before assigning more work.";
  if (error.message === "Ingress origin binding differs from delegation")
    return "This delegation belongs to another entry point. Inspect it in Fulcra; changing entry points requires explicit delegation.";
  if (error.message === "Private Discord replies must be explicitly enabled")
    return "Fulcra requires private (ephemeral) Discord command replies. After restoring that setting, wait for the Discord channel restart and verify a private /orca help reply before continuing.";
  if (error.message === "Invalid command syntax") return help;
  if (error.message === "Command text was altered or exceeds 4096 UTF-8 bytes")
    return error.message + ". Shorten or correct the entire command; nothing was sent.";
  return "Fulcra unavailable or request refused. Inspect /orca sessions, current ownership and receipt before retrying. A refused delegation may already have changed generation; use the app to take over or delegate the observed generation explicitly.";
};
const safePreview = (value) =>
  typeof value === "string"
    ? value.slice(0, 900).replace(/@/g, "@\u200b").replace(/`/g, "\u02cb")
    : "";
export function createCommand({
  config,
  request,
  read = privateJson,
  grantsDir = undefined,
  workspace = undefined,
}) {
  const currentOrigin = commandOrigin(config),
    bindingsDir = config.bindingsDir,
    originHash = hash(currentOrigin);
  let generation = 0,
    active = false,
    busy = false;
  const service = {
    id: "orca-command",
    start(context) {
      generation++;
      active = false;
      if (!privateReplies(context?.config, currentOrigin.accountId))
        throw Error("Private Discord replies must be explicitly enabled");
      active = true;
    },
    stop() {
      generation++;
      active = false;
    },
  };
  const definition = {
    name: "orca",
    description: "Inspect or instruct your explicitly delegated Fulcra session.",
    channels: ["discord"],
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: [/** @type {const} */ ("operator.write")],
    async handler(ctx) {
      let receipt,
        acquired = false;
      try {
        if (
          !active ||
          ctx.senderIsOwner !== true ||
          ctx.isAuthorizedSender !== true ||
          ctx.channel !== "discord" ||
          ctx.channelId !== currentOrigin.conversationId ||
          ctx.gatewayClientScopes !== undefined ||
          ctx.accountId !== currentOrigin.accountId ||
          ctx.senderId !== currentOrigin.senderId ||
          ctx.from !== `discord:channel:${currentOrigin.conversationId}` ||
          ctx.to !== `slash:${currentOrigin.senderId}` ||
          ctx.messageThreadId !== undefined ||
          ctx.threadParentId !== undefined
        )
          throw Error("Owner command origin required");
        if (!privateReplies(ctx.config, currentOrigin.accountId))
          throw Error("Private Discord replies must be explicitly enabled");
        if (busy)
          return {
            text: "Another Fulcra command is still resolving. Wait for its receipt before sending another command.",
          };
        busy = true;
        acquired = true;
        const command = parseCommand(ctx);
        if (command.action === "help") return { text: help };
        const selectedOrigin = workspace?.currentOrigin() ?? currentOrigin,
          selectedHash = hash(selectedOrigin),
          epoch = generation;
        const unchanged = () => {
          if (
            !active ||
            epoch !== generation ||
            !privateReplies(ctx.config, currentOrigin.accountId) ||
            hash(workspace?.currentOrigin() ?? currentOrigin) !== selectedHash
          )
            throw Error("Command selection or service changed");
        };
        if (["sessions", "delegate"].includes(command.action)) {
          if (!workspace) throw Error("Workspace unavailable");
          return await workspace.run(command, unchanged);
        }
        const load = () =>
          loadBinding({ currentOrigin: selectedOrigin, bindingsDir, read, grantsDir });
        const bound = load(),
          fingerprint = hash(bound);
        if (bound.binding.sessionId !== selectedOrigin.sessionId)
          throw Error("Command target binding changed");
        const fresh = () => {
          unchanged();
          if (
            !active ||
            epoch !== generation ||
            !privateReplies(ctx.config, currentOrigin.accountId) ||
            hash(load()) !== fingerprint
          )
            throw Error("Command binding or service changed");
        };
        const call = async (method, input) => {
          fresh();
          const result = await request({ method, input, capability: bound.capability });
          fresh();
          return result;
        };
        const status = await call("inspect", selectedOrigin.sessionId);
        if (
          status.id !== selectedOrigin.sessionId ||
          status.task !== bound.binding.taskId ||
          status.mode !== "delegated" ||
          status.generation !== bound.binding.generation
        )
          throw Error("Bound session ownership changed");
        const location = `Session ${status.id} · task ${status.task} · delegation ${status.generation}`;
        if (command.action === "status")
          return {
            text: `${location}\nNative state: ${status.observed.status}; pending permissions: ${status.observed.pending}.\n${status.deliveries
              .slice(0, 5)
              .map((d) => `${d.id}: ${d.state}`)
              .join(
                "\n",
              )}\nOpen Fulcra: ${localJson("machine-values.json", {}).fulcraUrl ?? "http://127.0.0.1:6791"}`,
          };
        const input = {
          sessionId: status.id,
          messageId: command.messageId,
          originHash: selectedHash,
        };
        if (command.action === "result") {
          const result = await call("ingress-result", input);
          return {
            text: `Receipt ${command.messageId}: ${result.state}. Output observed: ${result.outputObserved === true}; turn ended: ${result.ended === true}. Independently accepted: no.\n${safePreview(result.outputPreview)}`,
          };
        }
        if (command.action === "ack") {
          await call("ingress-ack", input);
          return {
            text: `Receipt ${command.messageId} acknowledged. Preparation released; delivery history retained. This does not establish completion or acceptance.`,
          };
        }
        const messageId = await call("ingress-prepare", { ...input, text: command.text });
        if (!uuid(messageId)) throw Error("Controller returned invalid receipt");
        receipt = messageId;
        const delivery = await call("ingress-send", { ...input, messageId, text: command.text });
        const reused =
          messageId !== command.messageId
            ? `Existing receipt ${messageId} reused; no new instruction was created.\n`
            : "";
        return {
          text: `${reused}Receipt ${messageId}: ${delivery.state}. Independently accepted: no.\nUse /orca result ${messageId} to inspect output.`,
        };
      } catch (error) {
        return {
          text: receipt
            ? `Receipt ${receipt} retained; dispatch outcome unconfirmed. Inspect it before another instruction. ${refusal(error)}`
            : refusal(error),
        };
      } finally {
        if (acquired) busy = false;
      }
    },
  };
  return { definition, service, currentOrigin, originHash };
}
