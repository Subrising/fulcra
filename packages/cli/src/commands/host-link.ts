import { Command } from "commander";
import { z } from "zod";
import { constants } from "node:fs";
import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
async function privateRead(file: string): Promise<string> {
  const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const wrongMode =
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.());
    if (!stat.isFile() || wrongMode || stat.size > 256 * 1024)
      throw new Error("Use a private, bounded host-link file.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
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
async function workerRequest(kind: "inspect" | "prompt", options: WorkerOptions): Promise<unknown> {
  const receipt = ReceiptSchema.parse(privateJson(await privateRead(options.receiptFile)));
  if (
    !receipt.endpoint ||
    !receipt.agentId ||
    !receipt.token ||
    !/^hworker1\.[A-Za-z0-9_-]{43}$/.test(receipt.token)
  )
    throw new Error("The retained receipt has no worker credential.");
  const body =
    kind === "inspect"
      ? { kind, agentId: receipt.agentId }
      : {
          kind,
          agentId: receipt.agentId,
          messageId: z.string().uuid().parse(options.messageId),
          prompt: await privateRead(z.string().min(1).parse(options.promptFile)),
        };
  return post(hostLinkEndpoint(receipt.endpoint, "worker"), receipt.token, body);
}
export function createHostLinkCommand(): Command {
  const command = new Command("host-link").description("Use restricted host links");
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
      process.stdout.write(`${JSON.stringify(await workerRequest("inspect", options))}\n`);
    });
  command
    .command("prompt")
    .requiredOption("--receipt-file <path>", "Retained private worker receipt")
    .requiredOption("--message-id <id>", "Retained UUID for this prompt")
    .requiredOption("--prompt-file <path>", "Private UTF-8 prompt")
    .action(async (options: WorkerOptions) => {
      const result = ReceiptSchema.parse(await workerRequest("prompt", options));
      process.stdout.write(
        `${JSON.stringify({ agentId: result.agentId, messageId: result.messageId, state: result.state })}\n`,
      );
    });
  return command;
}
