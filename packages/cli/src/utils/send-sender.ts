import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CommandError } from "../output/index.js";

// FULCRA(orchestration): who sends (reporting lines, Fulcra 0.2.8). A send from a chat carries the chat's id, from
// PASEO_AGENT_ID (the daemon sets it in each chat's environment) or from --from for a send relayed from another
// computer. A send with no stamp is the owner and is never refused. A chat whose shell lost PASEO_AGENT_ID is caught
// by its process tree: an ancestor is a chat provider's CLI. These are cooperative rules, not security.

export interface Sender {
  agentId: string;
  serverId?: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  args: string;
}

const PROVIDER_CLIS = new Set(["claude", "codex", "opencode", "pi", "copilot"]);
const PROVIDER_SCRIPTS =
  /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli|@openai[\\/]codex|[\\/]opencode[\\/]/;

/** True when the process is a chat provider's CLI (the program a chat runs in). */
export function isChatProcess(info: Pick<ProcessInfo, "command" | "args">): boolean {
  const name = path.basename(info.command.trim()).toLowerCase();
  if (PROVIDER_CLIS.has(name)) return true;
  return (name === "node" || name === "bun") && PROVIDER_SCRIPTS.test(info.args);
}

/** The parent chain of this process, read with ps. Empty where ps is not available. */
export function readAncestors(start = process.ppid, limit = 40): ProcessInfo[] {
  if (process.platform === "win32") return [];
  const chain: ProcessInfo[] = [];
  let pid = start;
  for (let n = 0; n < limit && pid > 1; n++) {
    const ps = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const line = ps.stdout?.trim();
    if (ps.status !== 0 || !line) break;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) break;
    const args =
      spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim() ??
      "";
    chain.push({ pid, ppid: Number(match[1]), command: match[2]!, args });
    pid = Number(match[1]);
  }
  return chain;
}

function parseFrom(value: string): Sender {
  const [agentId, serverId, extra] = value.trim().split("@");
  if (!agentId || extra !== undefined || (serverId !== undefined && !serverId))
    throw {
      code: "INVALID_FROM",
      message: "--from takes a chat id, or <chat id>@<server id>",
    } satisfies CommandError;
  return serverId ? { agentId, serverId } : { agentId };
}

export function resolveSender(input: {
  from?: string;
  env?: NodeJS.ProcessEnv;
  ancestors?: () => ProcessInfo[];
}): Sender | null {
  const own = (input.env ?? process.env).PASEO_AGENT_ID?.trim();
  if (input.from !== undefined) {
    const from = parseFrom(input.from);
    if (own && own !== from.agentId)
      throw {
        code: "INVALID_FROM",
        message: "--from is only for a send relayed from another computer, not from inside a chat",
      } satisfies CommandError;
    return from;
  }
  if (own) return { agentId: own };
  if ((input.ancestors ?? readAncestors)().some(isChatProcess))
    throw {
      code: "SENDER_UNKNOWN",
      message: "This send comes from a chat with no identity; send it from your own chat",
    } satisfies CommandError;
  return null;
}
