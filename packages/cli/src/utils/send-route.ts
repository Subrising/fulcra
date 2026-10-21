import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Sender } from "./send-sender.js";
import type { AgentSendOptions, AgentSendResult } from "../commands/agent/send.js";

const routeSchema = z.object({
  host: z.string().trim().min(1),
  sshTarget: z.string().regex(/^[a-z0-9_][a-z0-9_.@:-]*$/i),
  cli: z
    .string()
    .startsWith("/")
    .refine((s) => !s.includes(String.fromCharCode(0)) && !/[\r\n]/.test(s)),
  home: z
    .string()
    .startsWith("/")
    .refine((s) => !s.includes(String.fromCharCode(0)) && !/[\r\n]/.test(s)),
});
const policySchema = z.object({
  sshRoutes: z.record(z.string().uuid(), routeSchema).optional(),
  roles: z.record(z.string(), z.string()).optional(),
});
export type SendRoute = z.infer<typeof routeSchema>;

export async function readSendRoute(identifier: string): Promise<{
  agentId: string;
  route: SendRoute;
} | null> {
  let text: string;
  try {
    text = await readFile(
      join(process.env.FULCRA_NOTICE_CONFIG || join(homedir(), ".config/fulcra"), "pause.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read SSH send routes. No remote send was attempted.", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid SSH send routes. No remote send was attempted.");
  }
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid SSH send routes. No remote send was attempted.");
  const key = identifier.startsWith("role:")
    ? parsed.data.roles?.[identifier.slice(5)]
    : identifier;
  if (!key) return null;
  const routes = Object.entries(parsed.data.sshRoutes ?? {});
  const exact = routes.find(([id]) => id === key);
  const matches = exact ? [exact] : routes.filter(([id]) => id.startsWith(key));
  if (matches.length > 1)
    throw new Error("The SSH send route is ambiguous. Use the full session ID.");
  return matches[0] ? { agentId: matches[0][0], route: matches[0][1] } : null;
}

// The prompt and sender travel on stdin. No password or prompt enters the SSH command.
// The destination CLI performs its normal sender, reporting-line, pause and hold checks.
const remoteScript = `import json,os,subprocess,sys,tempfile
request=json.load(sys.stdin)
env=dict(os.environ)
env.pop('PASEO_AGENT_ID',None)
env['FULCRA_SEND_RELAYED']='1'
if request.get('operation')=='metadata':
 result=subprocess.run([request['cli'],'--home',request['home'],'status','--send-routing','--json'],env=env,capture_output=True,text=True)
 sys.stdout.write(result.stdout if result.returncode==0 else result.stderr)
 sys.exit(result.returncode)
fd,name=tempfile.mkstemp(prefix='fulcra-send-')
try:
 with os.fdopen(fd,'w',encoding='utf-8') as stream: stream.write(request['prompt'])
 result=subprocess.run([request['cli'],'--home',request['home'],'send',request['agentId'],'--prompt-file',name,'--json','--no-wait',*request['flags']],env=env,capture_output=True,text=True)
 sys.stdout.write(result.stdout if result.returncode==0 else result.stderr)
 sys.exit(result.returncode)
finally: os.unlink(name)`;
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

interface RemoteSendRequest {
  route: SendRoute;
  agentId: string;
  prompt: string;
  sender: Sender | null;
  localServerId: string | undefined;
  localHost: string;
  options: AgentSendOptions;
}
interface SshResult {
  code: number | null;
  output: string;
}

export async function sshSend(request: RemoteSendRequest): Promise<AgentSendResult> {
  const { route, sender, options } = request;
  if (options.nativeQueue || options.image?.length || request.prompt.trimStart().startsWith("/"))
    throw new Error("SSH sends accept plain text only.");
  if (sender && !sender.serverId && !request.localServerId)
    throw new Error("Cannot identify the sending host. No remote send was attempted.");
  const flags = relayFlags({ sender, options, localServerId: request.localServerId });
  const body = JSON.stringify({
    ...route,
    agentId: request.agentId,
    prompt: request.prompt,
    flags,
  });
  const result = await runSsh(route, body);
  const warning =
    basename(route.cli) === "fulcra"
      ? ""
      : "Warning: This route may skip the Python pause guard. Use the host Fulcra launcher. ";
  try {
    const receipt = decodeReceipt(request, result);
    return { ...receipt, message: warning + receipt.message };
  } catch (error) {
    if (warning && error instanceof Error) error.message = warning + error.message;
    throw error;
  }
}

function relayFlags(input: {
  sender: Sender | null;
  options: AgentSendOptions;
  localServerId: string | undefined;
}): string[] {
  const { sender, options, localServerId } = input;
  return [
    ...(sender ? ["--from", `${sender.agentId}@${sender.serverId || localServerId}`] : []),
    ...(sender?.inboundOnly ? ["--inbound-only"] : []),
    ...(sender?.outboundMainOnly ? ["--outbound-main-only"] : []),
    ...(sender?.outboundServerOnly ? ["--outbound-server-only", sender.outboundServerOnly] : []),
    ...(sender?.outboundParent ? ["--outbound-parent", sender.outboundParent] : []),
    ...(sender?.refusal ? ["--outbound-refusal", sender.refusal] : []),
    ...(options.notifyOnFinish === false ? ["--no-notify-on-finish"] : []),
    ...(options.steer ? ["--steer"] : []),
    ...(options.queue ? ["--queue"] : []),
  ];
}

function runSsh(route: SendRoute, body: string): Promise<SshResult> {
  return new Promise<SshResult>((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=15",
        "--",
        route.sshTarget,
        `python3 -c ${shellQuote(remoteScript)}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let size = 0;
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) child.kill();
      else output += chunk.toString("utf8");
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          `SSH delivery to ${route.host} failed. Retain the draft; do not automatically retry.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.stdin.end(body);
  });
}

export async function readRemoteSendHost(
  route: SendRoute,
): Promise<{ serverId: string; mainAssistantId: string | null }> {
  const result = await runSsh(route, JSON.stringify({ ...route, operation: "metadata" }));
  const schema = z.object({
    sendRouting: z.object({ serverId: z.string().min(1), mainAssistantId: z.string().nullable() }),
  });
  let value: unknown;
  try {
    value = JSON.parse(result.output);
  } catch {
    throw new Error(
      `Cannot read reporting-line support from ${route.host}. Update the destination host.`,
    );
  }
  const parsed = schema.safeParse(value);
  if (result.code !== 0 || !parsed.success)
    throw new Error(
      `Cannot read reporting-line support from ${route.host}. Update the destination host.`,
    );
  return parsed.data.sendRouting;
}

function decodeReceipt(request: RemoteSendRequest, result: SshResult): AgentSendResult {
  const { route } = request;
  let data: AgentSendResult & { error?: { code?: string; message?: string } };
  try {
    data = JSON.parse(result.output);
  } catch {
    throw new Error(
      `SSH delivery to ${route.host} is uncertain. Retain the draft; do not automatically retry.`,
    );
  }
  if (result.code !== 0 && !data.error)
    throw new Error(
      `SSH delivery to ${route.host} is uncertain. Retain the draft; do not automatically retry.`,
    );
  if (result.code !== 0 || data.error) {
    // COMPAT(remoteSendMissing): added in v0.2.26; remove after 2027-04-19 once destination daemon floor >= v0.2.26.
    const oldMissing =
      data.error?.code === "SEND_FAILED" &&
      data.error.message === `Failed to send message: Agent not found: ${request.agentId}`;
    const missing = data.error?.code === "AGENT_NOT_FOUND" || oldMissing;
    throw Object.assign(
      new Error(
        missing
          ? `Session not found. Checked ${request.localHost} (local daemon) and ${route.host}.`
          : `Remote send to ${route.host} refused: ${data.error?.message || "No accepted receipt."}`,
      ),
      {
        code: missing ? "AGENT_NOT_FOUND" : "SEND_FAILED",
      },
    );
  }
  if (
    data.agentId !== request.agentId ||
    !["sent", "held", "queued", "refused"].includes(data.status)
  )
    throw new Error(
      `Unknown receipt from ${route.host}. Retain the draft; do not automatically retry.`,
    );
  // COMPAT(remoteHeldReceipt): added in v0.2.26; remove after 2027-04-19 once destination CLI floor >= v0.2.26.
  if (
    data.status === "sent" &&
    data.message === "Provider paused. Notice saved. No turn was started."
  )
    return { ...data, status: "held" };
  return data;
}
