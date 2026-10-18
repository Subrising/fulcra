import { randomUUID } from "node:crypto";
import { type Command } from "commander";
import type { PaseoAgentSendOptions } from "@getpaseo/client";
import { collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { listAccounts, switchAccountSession } from "../account.js";
import { resolveSender, assertSenderDaemon } from "../../utils/send-sender.js";
import { readSendRoute, sshSend, readRemoteSendHost } from "../../utils/send-route.js";

/** Result type for agent send command */
export interface AgentSendResult {
  agentId: string;
  status:
    | "sent"
    | "held"
    | "allowed"
    | "completed"
    | "timeout"
    | "permission"
    | "error"
    | "queued"
    | "dispatching"
    | "delivered"
    | "refused"
    | "cancelled"
    | "uncertain";
  messageId?: string;
  pendingCount?: number;
  providerTurnId?: string;
  message: string;
}

/** Schema for agent send output */
export const agentSendSchema: OutputSchema<AgentSendResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "MESSAGE", field: "message", width: 40 },
  ],
};

export interface AgentSendOptions extends CommandOptions {
  notifyOnFinish?: boolean;
  steer?: boolean;
  queue?: boolean;
  wait?: boolean;
  nativeQueue?: boolean;
  messageId?: string;
  image?: string[];
  prompt?: string;
  promptFile?: string;
  from?: string;
  inboundOnly?: boolean;
  outboundMainOnly?: boolean;
  outboundServerOnly?: string;
  outboundRefusal?: string;
  checkOnly?: boolean;
}

export function addSendOptions(cmd: Command): Command {
  return cmd
    .description("Send a message/task to an existing agent")
    .argument("<id>", "Agent ID (or prefix)")
    .argument("[prompt]", "The message to send")
    .option("--prompt <text>", "Provide the message inline as a flag")
    .option("--prompt-file <path>", "Read the message from a UTF-8 text file")
    .option("--image <path>", "Attach image(s) to the message", collectMultiple, [])
    .option("--no-notify-on-finish", "Do not request a finish notice for this message")
    .option("--steer", "Inject into the running turn; queue if native steering is unavailable")
    .option("--queue", "Queue agent messages for one combined delivery (default for agent senders)")
    .option(
      "--native-queue",
      "Request native queue; requires an authenticated delegated operation, grants no authority",
    )
    .option(
      "--message-id <id>",
      "Stable ID required by --native-queue; retain it on uncertainty. Retry within 24 hours (daemon.receiptRetentionMs can change this window)",
    )
    .option(
      "--from <chat>",
      "The chat this message comes from, as <chat id> or <chat id>@<server id>, for a send relayed from another computer",
    )
    .option("--inbound-only", "Restrict a relayed send to the receiver's children and direct links")
    .option("--outbound-main-only", "Restrict a relayed role send to the current Main assistant")
    .option(
      "--outbound-server-only <id>",
      "Restrict a relayed send to its source-selected destination host",
    )
    .option(
      "--outbound-refusal <text>",
      "Source daemon reporting-line refusal for a restricted relay",
    )
    .option("--check-only", "Check receiver admission without sending input")
    .option("--no-wait", "Return immediately without waiting for completion");
}

/**
 * Read image files and convert them to base64 data URIs
 */
async function readImageFiles(
  imagePaths: string[],
): Promise<Array<{ data: string; mimeType: string }>> {
  return Promise.all(
    imagePaths.map(async (path) => {
      try {
        const buffer = await readFile(path);
        const ext = extname(path).toLowerCase();

        let mimeType = "image/jpeg";
        switch (ext) {
          case ".png":
            mimeType = "image/png";
            break;
          case ".jpg":
          case ".jpeg":
            mimeType = "image/jpeg";
            break;
          case ".gif":
            mimeType = "image/gif";
            break;
          case ".webp":
            mimeType = "image/webp";
            break;
          default:
            mimeType = "image/jpeg";
        }

        return { data: buffer.toString("base64"), mimeType };
      } catch (err) {
        if (err && typeof err === "object" && "code" in err) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw {
          code: "IMAGE_READ_ERROR",
          message: `Failed to read image file: ${path}`,
          details: message,
        } satisfies CommandError;
      }
    }),
  );
}

async function resolvePromptInput(options: {
  promptArgument: string | undefined;
  promptOption: string | undefined;
  promptFile: string | undefined;
}): Promise<string> {
  const promptText = options.promptArgument?.trim();
  const promptOptionText = options.promptOption?.trim();
  const promptFilePath = options.promptFile?.trim();
  const providedSourceCount = [promptText, promptOptionText, promptFilePath].filter(Boolean).length;

  if (providedSourceCount > 1) {
    const error: CommandError = {
      code: "CONFLICTING_PROMPT_INPUT",
      message: "Provide exactly one of prompt argument, --prompt, or --prompt-file",
    };
    throw error;
  }

  if (promptText) {
    return options.promptArgument as string;
  }

  if (promptOptionText) {
    return options.promptOption as string;
  }

  if (!promptFilePath) {
    const error: CommandError = {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details:
        "Usage: paseo agent send [options] <id> [prompt] | --prompt <text> | --prompt-file <path>",
    };
    throw error;
  }

  try {
    return await readFile(resolve(promptFilePath), "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "PROMPT_FILE_READ_ERROR",
      message: `Failed to read prompt file: ${promptFilePath}`,
      details: message,
    };
    throw error;
  }
}

type SendWaitState = Awaited<
  ReturnType<Awaited<ReturnType<typeof connectToDaemon>>["waitForFinish"]>
>;

function buildSendResult(agentIdArg: string, state: SendWaitState): AgentSendResult {
  const agentId = state.final?.id ?? agentIdArg;
  if (state.status === "timeout") {
    return { agentId, status: "timeout", message: "Timed out waiting for agent to finish" };
  }
  if (state.status === "permission") {
    return { agentId, status: "permission", message: "Agent is waiting for permission" };
  }
  if (state.status === "error") {
    return {
      agentId,
      status: "error",
      message: state.error ?? "Agent finished with error",
    };
  }
  return { agentId, status: "completed", message: "Agent completed processing the message" };
}

function validateNativeQueueOptions(
  options: AgentSendOptions,
  nativeQueue: boolean,
): string | undefined {
  const messageId = options.messageId;
  if (nativeQueue && (!messageId || messageId.length > 256 || messageId.trim() !== messageId)) {
    throw {
      code: "NATIVE_QUEUE_INVALID",
      message: "--native-queue requires a stable nonblank --message-id",
    } satisfies CommandError;
  }
  if (!nativeQueue && messageId !== undefined) {
    throw {
      code: "NATIVE_QUEUE_INVALID",
      message: "--message-id requires --native-queue",
    } satisfies CommandError;
  }
  if (nativeQueue && options.image?.length) {
    throw {
      code: "NATIVE_QUEUE_INVALID",
      message: "Native queue does not accept images",
    } satisfies CommandError;
  }
  return messageId;
}

function buildNativeSendResult(
  agentId: string,
  receipt: Awaited<
    ReturnType<Awaited<ReturnType<typeof connectToDaemon>>["sendNativeQueuedMessage"]>
  >,
): AgentSendResult {
  let message = `Native delivery receipt: ${receipt.state}; not task completion`;
  if (receipt.state === "queued")
    message = "Message queued; not yet delivered or provider accepted";
  if (receipt.state === "uncertain")
    message =
      "Delivery uncertain; retain the draft and this message ID, do not automatically resend";
  return {
    agentId,
    status: receipt.state,
    messageId: receipt.messageId,
    pendingCount: receipt.pendingCount,
    ...(receipt.providerTurnId ? { providerTurnId: receipt.providerTurnId } : {}),
    message,
  };
}

async function runSlashCommand(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  agentIdArg: string,
  prompt: string,
  hasImages: boolean,
): Promise<AgentSendResult | null> {
  const slash = /^\/([^/\s]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (slash) {
    if (hasImages) throw new Error("Slash commands do not accept images.");
    if (slash[1] === "account") {
      const args = (slash[2] ?? "").trim();
      const message =
        !args || args.toLowerCase() === "list"
          ? (await listAccounts(client, agentIdArg))
              .map((row) => `${row.name}: ${row.status.state}`)
              .join("\n") || "No pooled accounts for this session."
          : await switchAccountSession(client, agentIdArg, args);
      return { agentId: agentIdArg, status: "completed", message };
    }
    const { commands } = await client.listCommands({ agentId: agentIdArg });
    if (!commands.some((command) => command.name === slash[1]))
      throw new Error(`Unknown slash command: /${slash[1]}`);
  }

  return null;
}

function validateSendMode(options: AgentSendOptions): void {
  const modes = [options.steer, options.queue, options.nativeQueue].filter(Boolean);
  if (modes.length > 1)
    throw {
      code: "CONFLICTING_SEND_MODE",
      message: "Choose one of --steer, --queue, or --native-queue",
    } satisfies CommandError;
}

function sendOptions(
  options: AgentSendOptions,
  sender: ReturnType<typeof resolveSender>,
  images: Awaited<ReturnType<typeof readImageFiles>> | undefined,
  onDelivery: (note: string, state?: "held") => void,
): PaseoAgentSendOptions {
  return {
    images,
    ...(options.notifyOnFinish === false ? { notifyOnFinish: false } : {}),
    ...(sender ? { sender } : {}),
    ...(options.queue || (sender && !options.steer) ? { queue: true } : {}),
    ...(options.steer ? { activeTurnBehavior: "steer" as const } : {}),
    onDelivery,
  };
}

function completionPolicy(
  options: AgentSendOptions,
  sender: ReturnType<typeof resolveSender>,
  agentId: string,
) {
  const remote = Boolean(sender && /^[a-f0-9-]{36}@[a-z0-9_-]+$/i.test(agentId));
  return {
    background: options.wait === false || remote,
    messageId: options.wait === false && !remote ? undefined : randomUUID(),
  };
}

async function routeMissingSend(
  error: unknown,
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  agentId: string,
  prompt: string,
  sender: ReturnType<typeof resolveSender>,
  options: AgentSendOptions,
): Promise<AgentSendResult | null> {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "AGENT_NOT_FOUND")
    return null;
  const selected = process.env.FULCRA_SEND_RELAYED === "1" ? null : await readSendRoute(agentId);
  const info = client.getLastServerInfoMessage();
  const localHost = info?.hostname || "the selected host";
  if (!selected)
    throw {
      code: "AGENT_NOT_FOUND",
      message: `Session not found on ${localHost} (local daemon). No configured SSH route was used.`,
    } satisfies CommandError;
  if (info?.features?.agentSendReceipts !== true)
    throw new Error("Update the source host to use configured SSH send routes.");
  const check = sender
    ? await client.checkAgentMessageRoute({
        kind: "outbound",
        senderId: sender.agentId,
        targetId: selected.agentId,
      })
    : null;
  await readRemoteSendHost(selected.route);
  const relayedSender =
    sender && check
      ? {
          ...sender,
          ...(check.inboundOnly ? { inboundOnly: true as const } : {}),
          ...(check.outboundMainOnly ? { outboundMainOnly: true as const } : {}),
          ...(check.outboundServerOnly ? { outboundServerOnly: check.outboundServerOnly } : {}),
          ...(check.refusal ? { refusal: check.refusal } : {}),
        }
      : sender;
  return sshSend({
    ...selected,
    prompt,
    sender: relayedSender,
    localServerId: info?.serverId,
    localHost,
    options,
  });
}

function throwSendFailure(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw {
    code: "SEND_FAILED",
    message: `Failed to send message: ${message}`,
  } satisfies CommandError;
}

function restrictedSender(options: AgentSendOptions): ReturnType<typeof resolveSender> {
  let sender = resolveSender({ from: options.from });
  if (
    options.inboundOnly ||
    options.outboundMainOnly ||
    options.outboundServerOnly ||
    options.outboundRefusal
  ) {
    if (!options.from || !sender?.serverId)
      throw {
        code: "INVALID_FROM",
        message: "Restricted relay flags require --from with the original host identity.",
      } satisfies CommandError;
    sender = {
      ...sender,
      ...(options.inboundOnly ? { inboundOnly: true } : {}),
      ...(options.outboundMainOnly ? { outboundMainOnly: true } : {}),
      ...(options.outboundServerOnly ? { outboundServerOnly: options.outboundServerOnly } : {}),
      ...(options.outboundRefusal ? { refusal: options.outboundRefusal } : {}),
    };
  }
  return sender;
}

async function checkSendAdmission(input: {
  client: Awaited<ReturnType<typeof connectToDaemon>>;
  sender: ReturnType<typeof resolveSender>;
  agentId: string;
  options: AgentSendOptions;
}): Promise<SingleResult<AgentSendResult> | undefined> {
  const { client, sender, agentId, options } = input;
  if (options.checkOnly) {
    const check = await client.checkAgentMessageRoute({
      kind: "inbound",
      agentId: agentId,
      sender: sender ?? undefined,
    });
    if (!check.allowed)
      throw {
        code: "SEND_REFUSED",
        message: check.reason ?? "The receiver refused this message.",
      } satisfies CommandError;
    return {
      type: "single",
      data: {
        agentId: agentId,
        status: "allowed",
        message: "Admission check passed. No input was sent.",
      },
      schema: agentSendSchema,
    };
  }
  if (
    (sender?.inboundOnly || sender?.outboundMainOnly || sender?.outboundServerOnly) &&
    client.getLastServerInfoMessage()?.features?.agentSendReportingLines !== true
  )
    throw new Error("Update the host to enforce the source reporting-line restriction.");
  return undefined;
}

export async function runSendCommand(
  agentIdArg: string,
  prompt: string | undefined,
  options: AgentSendOptions,
  _command: Command,
): Promise<SingleResult<AgentSendResult>> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent send [options] <id> [prompt]",
    };
    throw error;
  }

  const nativeQueue = options.nativeQueue === true;
  validateSendMode(options);
  const messageId = validateNativeQueueOptions(options, nativeQueue);
  const promptInput = await resolvePromptInput({
    promptArgument: prompt,
    promptOption: options.prompt,
    promptFile: options.promptFile,
  });

  if (nativeQueue && promptInput.trimStart().startsWith("/")) {
    throw {
      code: "NATIVE_QUEUE_INVALID",
      message: "Native queue does not accept slash commands",
    } satisfies CommandError;
  }
  // FULCRA(orchestration): reporting lines. Stamp the sending chat; a send with no stamp is the owner.
  const sender = restrictedSender(options);
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    await assertSenderDaemon({ sender, serverId: client.getLastServerInfoMessage()?.serverId });
    const admission = await checkSendAdmission({ client, sender, agentId: agentIdArg, options });
    if (admission) return admission;
    if (nativeQueue) {
      const receipt = await client.sendNativeQueuedMessage(agentIdArg, promptInput, {
        messageId: messageId!,
      });
      return {
        type: "single",
        data: buildNativeSendResult(agentIdArg, receipt),
        schema: agentSendSchema,
      };
    }
    // Read image files if provided
    const images =
      options.image && options.image.length > 0 ? await readImageFiles(options.image) : undefined;

    const slashResult = await runSlashCommand(
      client,
      agentIdArg,
      promptInput,
      Boolean(images?.length),
    );
    if (slashResult) return { type: "single", data: slashResult, schema: agentSendSchema };

    // Send the message
    let deliveryNote: string | undefined;
    let deliveryState: "held" | undefined;
    const policy = completionPolicy(options, sender, agentIdArg);
    const completionMessageId = policy.messageId;
    await client.sendAgentMessage(agentIdArg, promptInput, {
      ...sendOptions(options, sender, images, (note, state) => {
        deliveryNote = note;
        // COMPAT(sendDeliveryState): added in v0.2.26; remove after 2027-04-19 once daemon floor >= v0.2.26.
        deliveryState =
          state ??
          (note === "Provider paused. Notice saved. No turn was started." ? "held" : undefined);
      }),
      ...(completionMessageId ? { messageId: completionMessageId } : {}),
    });

    if (deliveryState === "held") {
      return {
        type: "single",
        data: { agentId: agentIdArg, status: "held", message: deliveryNote! },
        schema: agentSendSchema,
      };
    }

    // If --no-wait, return immediately
    if (policy.background) {
      return {
        type: "single",
        data: {
          agentId: agentIdArg,
          status: "sent",
          message: deliveryNote ?? "Message sent, not waiting for completion",
        },
        schema: agentSendSchema,
      };
    }

    const state = await client.waitForFinish(agentIdArg, 600000, {
      messageId: completionMessageId!,
    }); // 10 minute timeout

    const result = buildSendResult(agentIdArg, state);
    return {
      type: "single",
      data: deliveryNote ? { ...result, message: `${deliveryNote} ${result.message}` } : result,
      schema: agentSendSchema,
    };
  } catch (err) {
    const routed = await routeMissingSend(err, client, agentIdArg, promptInput, sender, options);
    if (routed) return { type: "single", data: routed, schema: agentSendSchema };
    throwSendFailure(err);
  } finally {
    await client.close().catch(() => {});
  }
}
