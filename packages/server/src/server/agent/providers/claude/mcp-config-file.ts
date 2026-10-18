import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// FULCRA(orchestration): FU-349. The Agent MCP bearer token must not sit in the process list. The Claude SDK passes
// `--mcp-config <inline JSON>` in argv, and any process of the same user can read argv. This moves each inline JSON
// value to a file only the owner can read and passes the path instead. The file is removed when the process exits.
//
// Limit: a process of the same OS user can still read this file and the process environment. This hides the token
// from the process list; it is not a full separation between agents (FU-161, per-agent credential).

export interface MovedMcpConfig {
  args: string[];
  /** Removes the file. Safe to call more than once. */
  cleanup: () => void;
}

const FLAG = "--mcp-config";

export function moveMcpConfigOffArgv(args: string[]): MovedMcpConfig {
  let dir: string | undefined;
  let counter = 0;
  const moveValue = (value: string): string => {
    if (!value.trimStart().startsWith("{")) return value;
    if (!dir) {
      dir = mkdtempSync(path.join(tmpdir(), "fulcra-mcp-"));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = path.join(dir, `mcp-${(counter += 1)}.json`);
    writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
    return file;
  };
  const moved: string[] = [];
  let inFlag = false;
  for (const arg of args) {
    if (arg === FLAG) {
      inFlag = true;
      moved.push(arg);
    } else if (arg.startsWith(`${FLAG}=`)) {
      inFlag = false;
      moved.push(`${FLAG}=${moveValue(arg.slice(FLAG.length + 1))}`);
    } else if (inFlag && !arg.startsWith("--")) {
      moved.push(moveValue(arg));
    } else {
      inFlag = false;
      moved.push(arg);
    }
  }
  return {
    args: moved,
    cleanup: () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    },
  };
}
