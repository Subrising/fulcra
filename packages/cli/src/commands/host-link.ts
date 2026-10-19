import {
  initializeWindowsPrivateFiles,
  windowsAclIsSafe,
  WINDOWS_PRIVATE_MASK,
  writePrivateFileAtomicSync,
} from "@getpaseo/server";
import { connectToDaemon } from "../utils/client.js";
import { resolveSender } from "../utils/send-sender.js";
import { Command } from "commander";
import { z } from "zod";
import { constants } from "node:fs";
import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { addLocalDaemonOptions, withGlobalOptions } from "../utils/command-options.js";
import type { CommandOptions } from "../output/index.js";

const ReceiptSchema = z
  .object({
    serverId: z.string(),
    messageId: z.string().uuid(),
    state: z.string(),
    agentId: z.string().nullable(),
    token: z.string().nullable(),
    endpoint: z.string().url().nullable(),
  })
  .strict();
export type HostLinkCliReceipt = z.infer<typeof ReceiptSchema>;
interface RequestOptions {
  endpoint: string;
  credentialFile: string;
  receiptFile: string;
}
interface WorkerOptions {
  receiptFile: string;
  messageId?: string;
  promptFile?: string;
}

export function hostLinkEndpoint(raw: string, operation: "dispatch" | "worker"): string {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("Use HTTPS or literal loopback HTTP for host links.");
  url.pathname = `/api/host-links/${operation}`;
  return url.href;
}
async function privateRead(file: string, maxBytes = 256 * 1024): Promise<string> {
  await initializeWindowsPrivateFiles();
  const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const wrongMode =
      process.platform === "win32"
        ? !windowsAclIsSafe(resolve(file), WINDOWS_PRIVATE_MASK)
        : (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.();
    if (!stat.isFile() || wrongMode || stat.size > maxBytes)
      throw new Error("Use a private, bounded host-link file.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
export async function hostLinkNoticeStatus(home: string): Promise<{
  uncertain: number;
  exhausted: number;
  exhaustedWatches: number;
}> {
  const counts = { uncertain: 0, exhausted: 0, exhaustedWatches: 0 };
  let text: string;
  try {
    text = await privateRead(resolve(home, "host-links-outbox.json"), 8 * 1024 * 1024);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return counts;
    throw error;
  }
  const journal = z
    .record(
      z.string(),
      z.object({
        notifyOnFinish: z.boolean().optional(),
        complete: z.boolean().optional(),
        receivedNotices: z.array(z.object({ state: z.string() })).optional(),
        watch: z.object({ failures: z.number().int().min(0).max(8) }).optional(),
      }),
    )
    .safeParse(privateJson(text));
  if (!journal.success) throw new Error("The host-link notice journal requires repair.");
  for (const entry of Object.values(journal.data)) {
    if (!entry.notifyOnFinish) continue;
    if (!entry.complete && entry.watch?.failures === 8) counts.exhaustedWatches++;
    for (const notice of entry.receivedNotices ?? []) {
      if (notice.state === "uncertain") counts.uncertain++;
      if (notice.state === "exhausted") counts.exhausted++;
    }
  }
  return counts;
}
function privateJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The private host-link file requires repair.");
  }
}
async function post(endpoint: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Host-link request failed (${response.status}). Retain its message ID.`);
  return response.json();
}
export async function saveHostLinkReceipt(
  file: string,
  receipt: HostLinkCliReceipt,
): Promise<void> {
  const target = resolve(file);
  if (process.platform === "win32") {
    await initializeWindowsPrivateFiles();
    writePrivateFileAtomicSync(target, JSON.stringify(receipt), { durable: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function requestHostLink(
  file: string,
  options: RequestOptions,
): Promise<HostLinkCliReceipt> {
  const token = (await privateRead(options.credentialFile)).trim();
  if (!/^hchat1\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Use the source chat credential.");
  const body = privateJson(await privateRead(file));
  const receipt = ReceiptSchema.parse(
    await post(hostLinkEndpoint(options.endpoint, "dispatch"), token, body),
  );
  await saveHostLinkReceipt(options.receiptFile, receipt);
  return receipt;
}
async function workerRequest(options: WorkerOptions): Promise<unknown> {
  const receipt = ReceiptSchema.parse(privateJson(await privateRead(options.receiptFile)));
  if (
    !receipt.endpoint ||
    !receipt.agentId ||
    !receipt.token ||
    !/^hworker1\.[A-Za-z0-9_-]{43}$/.test(receipt.token)
  )
    throw new Error("The retained receipt has no worker credential.");
  return post(hostLinkEndpoint(receipt.endpoint, "worker"), receipt.token, {
    kind: "inspect",
    agentId: receipt.agentId,
  });
}
export async function promptHostLink(
  options: WorkerOptions & CommandOptions & { steer?: boolean; notifyOnFinish?: boolean },
) {
  const receipt = ReceiptSchema.parse(privateJson(await privateRead(options.receiptFile)));
  const sender = resolveSender({});
  if (!sender) throw new Error("Send remote work from its parent chat on the parent host.");
  if (!receipt.agentId) throw new Error("The retained receipt has no worker identity.");
  const messageId = z.string().uuid().parse(options.messageId);
  const prompt = await privateRead(z.string().min(1).parse(options.promptFile));
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    await client.sendAgentMessage(`${receipt.agentId}@${receipt.serverId}`, prompt, {
      sender,
      messageId,
      ...(options.steer ? { activeTurnBehavior: "steer" as const } : {}),
      ...(options.notifyOnFinish === false ? { notifyOnFinish: false } : {}),
    });
    return { agentId: receipt.agentId, messageId, state: "admitted" };
  } finally {
    await client.close();
  }
}

export function createHostLinkCommand(): Command {
  const command = new Command("host-link").description("Use restricted host links");
  command.addCommand(
    addLocalDaemonOptions(
      new Command("status").description("Count return notices that need an owner check"),
    ).action(
      withGlobalOptions(async (options: CommandOptions) => {
        if (options.daemonTarget.kind !== "instance") throw new Error("Use a local daemon home.");
        process.stdout.write(
          `${JSON.stringify(await hostLinkNoticeStatus(options.daemonTarget.home))}\n`,
        );
      }),
    ),
  );
  command
    .command("request")
    .argument("<request-file>", "Private JSON request with a retained message ID")
    .requiredOption("--endpoint <url>", "Source daemon URL")
    .requiredOption("--credential-file <path>", "Private source chat credential")
    .requiredOption("--receipt-file <path>", "Private output receipt")
    .action(async (file: string, options: RequestOptions) => {
      const receipt = await requestHostLink(file, options);
      process.stdout.write(
        `${JSON.stringify({ agentId: receipt.agentId, messageId: receipt.messageId, state: receipt.state })}\n`,
      );
    });
  command
    .command("inspect")
    .requiredOption("--receipt-file <path>", "Retained private worker receipt")
    .action(async (options: WorkerOptions) => {
      process.stdout.write(`${JSON.stringify(await workerRequest(options))}\n`);
    });
  command.addCommand(
    addLocalDaemonOptions(new Command("prompt"))
      .requiredOption("--receipt-file <path>", "Retained private worker receipt")
      .requiredOption("--message-id <id>", "Retained UUID for this prompt")
      .requiredOption("--prompt-file <path>", "Private UTF-8 prompt")
      .option("--steer", "Join the current remote turn when supported")
      .option("--no-notify-on-finish", "Do not request a finish notice")
      .action(
        withGlobalOptions(
          async (
            options: WorkerOptions & CommandOptions & { steer?: boolean; notifyOnFinish?: boolean },
          ) => {
            process.stdout.write(`${JSON.stringify(await promptHostLink(options))}\n`);
          },
        ),
      ),
  );
  return command;
}
