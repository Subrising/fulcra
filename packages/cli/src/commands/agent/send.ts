import { type Command } from "commander";
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
import { resolveSender } from "../../utils/send-sender.js";

/** Result type for agent send command */
export interface AgentSendResult {
  agentId: string;
  status:
    | "sent"
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
  wait?: boolean;
  nativeQueue?: boolean;
  messageId?: string;
  image?: string[];
  prompt?: string;
  promptFile?: string;
  from?: string;
}

export function addSendOptions(cmd: Command): Command {
  return cmd
    .description("Send a message/task to an existing agent")
    .argument("<id>", "Agent ID (or prefix)")
    .argument("[prompt]", "The message to send")
    .option("--prompt <text>", "Provide the message inline as a flag")
    .option("--prompt-file <path>", "Read the message from a UTF-8 text file")
    .option("--image <path>", "Attach image(s) to the message", collectMultiple, [])
    .option(
      "--native-queue",
      "Request native queue; requires an authenticated delegated operation, grants no authority",
    )
    .option(
      "--message-id <id>",
      "Stable message ID required by --native-queue; retain it on uncertainty",
    )
    .option(
      "--from <chat>",
      "The chat this message comes from, as <chat id> or <chat id>@<server id>, for a send relayed from another computer",
    )
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
  const sender = resolveSender({ from: options.from });
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
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
    await client.sendAgentMessage(agentIdArg, promptInput, {
      images,
      ...(sender ? { sender } : {}),
    });

    // If --no-wait, return immediately
    if (options.wait === false) {
      return {
        type: "single",
        data: {
          agentId: agentIdArg,
          status: "sent",
          message: "Message sent, not waiting for completion",
        },
        schema: agentSendSchema,
      };
    }

    const state = await client.waitForFinish(agentIdArg, 600000); // 10 minute timeout

    return {
      type: "single",
      data: buildSendResult(agentIdArg, state),
      schema: agentSendSchema,
    };
  } catch (err) {
    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "SEND_FAILED",
      message: `Failed to send message: ${message}`,
    };
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}
