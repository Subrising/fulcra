// FU-736: the daemon sends a report-up notice to a chat on another computer through the configured SSH send route
// (~/.config/fulcra/pause.json "sshRoutes", the same routes that `fulcra send` uses). The daemon retries a failed send
// itself, so a worker is not woken again to send its result.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

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
  sshRoutes: z.record(z.string(), routeSchema).optional(),
  roles: z.record(z.string(), z.string()).optional(),
});
export type SshSendRoute = z.infer<typeof routeSchema>;

/** "sent", or "no-route" when no SSH route names the chat. A failed send throws. */
export type RemoteSendOutcome = "sent" | "no-route";

function configDir(): string {
  return process.env.FULCRA_NOTICE_CONFIG || join(homedir(), ".config/fulcra");
}

/** The route for a chat ID (or a unique ID prefix) or a `role:<name>` reference; null when none is configured. */
export async function readSshSendRoute(
  identifier: string,
  dir: string = configDir(),
): Promise<{ agentId: string; route: SshSendRoute } | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "pause.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = policySchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("Invalid SSH send routes in pause.json");
  const key = identifier.startsWith("role:")
    ? parsed.data.roles?.[identifier.slice(5)]
    : identifier;
  if (!key) return null;
  const routes = Object.entries(parsed.data.sshRoutes ?? {});
  const exact = routes.find(([id]) => id === key);
  const matches = exact ? [exact] : routes.filter(([id]) => id.startsWith(key));
  if (matches.length !== 1) return null;
  return { agentId: matches[0]![0], route: matches[0]![1] };
}

// The prompt travels on stdin. The destination CLI makes its normal pause and hold checks.
const remoteScript = `import json,os,subprocess,sys,tempfile
request=json.load(sys.stdin)
env=dict(os.environ)
env.pop('PASEO_AGENT_ID',None)
env['FULCRA_SEND_RELAYED']='1'
fd,name=tempfile.mkstemp(prefix='fulcra-send-')
try:
 with os.fdopen(fd,'w',encoding='utf-8') as stream: stream.write(request['prompt'])
 result=subprocess.run([request['cli'],'--home',request['home'],'send',request['agentId'],'--prompt-file',name,'--json','--no-wait'],env=env,capture_output=True,text=True)
 sys.stdout.write(result.stdout if result.returncode==0 else result.stderr)
 sys.exit(result.returncode)
finally: os.unlink(name)`;
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function runSsh(route: SshSendRoute, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
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
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString("utf8");
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`SSH send to ${route.host} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`SSH send to ${route.host} failed (exit ${code}): ${output.trim()}`));
    });
    child.stdin.end(body);
  });
}

/** Sends a prompt to a chat on another computer through its SSH send route. */
export async function sendThroughSshRoute(
  identifier: string,
  prompt: string,
): Promise<RemoteSendOutcome> {
  const selected = await readSshSendRoute(identifier);
  if (!selected) return "no-route";
  await runSsh(
    selected.route,
    JSON.stringify({ ...selected.route, agentId: selected.agentId, prompt }),
  );
  return "sent";
}
