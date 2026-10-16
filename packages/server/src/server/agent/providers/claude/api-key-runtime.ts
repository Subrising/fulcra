import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync, type ChildProcess } from "node:child_process";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";

interface ApiAccount {
  root: string;
  id: string;
  epoch: string | null;
}
const denied = () => new Error("The API account is revoked or unavailable");

// The controller uses the same native creation-time format for orphan recovery.
function processStart(pid: number | undefined): string | null {
  if (!pid) return null;
  const env: NodeJS.ProcessEnv = { LC_ALL: "C" };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[name]) env[name] = process.env[name];
  const options = {
    encoding: "utf8" as const,
    env,
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
  };
  if (process.platform === "win32") {
    const ps = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')`;
    return (
      execFileSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        options,
      ).trim() || null
    );
  }
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], options).trim() || null;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}

// A private lease binds the stop capability to this actual child, independently of assignment history.
export function guardClaudeApiRuntime(raw: string | undefined): {
  attach(child: ChildProcess): void;
  close(): void;
} {
  let account: ApiAccount;
  try {
    account = JSON.parse(raw ?? "");
    const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if (
      !path.isAbsolute(account.root) ||
      !uuid.test(account.id) ||
      (account.epoch !== null && !uuid.test(account.epoch))
    )
      throw denied();
    account.root = fs.realpathSync(account.root);
  } catch {
    throw denied();
  }
  const dir = path.join(account.root, "accounts/api-runtimes");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${randomUUID()}.json`);
  const stopToken = randomUUID();
  const lease = {
    accountId: account.id,
    epoch: account.epoch,
    ownerPid: process.pid,
    ownerStart: processStart(process.pid),
    address: "",
    stopToken,
    childPid: null as number | null,
    childStart: null as string | null,
  };
  const socketDir = process.platform === "win32" ? null : fs.mkdtempSync("/tmp/fulcra-api-");
  const address = socketDir
    ? path.join(socketDir, "control.sock")
    : `\\\\.\\pipe\\fulcra-api-${randomUUID()}`;
  lease.address = address;
  let child: ChildProcess | undefined;
  let invalid = false,
    stopping = false,
    closed = false;
  let watcher: fs.FSWatcher | undefined;
  const replies = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let input = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => replies.delete(socket));
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 64) {
        socket.end("denied\n");
        return;
      }
      if (!input.endsWith("\n")) return;
      const value = Buffer.from(input.trim()),
        expected = Buffer.from(stopToken);
      if (value.length !== expected.length || !timingSafeEqual(value, expected)) {
        socket.end("denied\n");
        return;
      }
      replies.add(socket);
      invalidate();
    });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    watcher?.close();
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* Missing cleanup evidence makes revoke fail. */
    }
    for (const socket of replies) socket.end("stopped\n");
    replies.clear();
    server.close();
    if (socketDir)
      try {
        fs.rmSync(socketDir, { recursive: true, force: true });
      } catch {
        /* Private temporary socket only. */
      }
  };
  const invalidate = () => {
    invalid = true;
    if (!child || stopping || closed) return;
    stopping = true;
    // Revoke must stop the captured descendants before an exiting root can prevent escalation.
    void terminateWithTreeKill(child, {
      gracefulSignal: "SIGKILL",
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 2000,
    })
      .then((result) => {
        if (result !== "kill-timeout") close();
        return result;
      })
      .catch(() => {
        /* Retain the lease and withhold acknowledgement after an uncertain stop. */
      });
  };
  const check = () => {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(account.root, "accounts/accounts.json"), "utf8"),
      );
      const current = state.accounts.find((item: { id: string }) => item.id === account.id);
      if (
        !current ||
        !current.enabled ||
        current.revoked ||
        current.localRevoked ||
        current.auth !== "ok" ||
        current.credentialKind !== "api-key" ||
        (current.keyEpoch ?? null) !== account.epoch
      )
        throw denied();
    } catch {
      invalidate();
    }
  };
  try {
    server.on("error", invalidate);
    server.listen(address);
    fs.writeFileSync(file, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
    watcher = fs.watch(path.join(account.root, "accounts"), check);
    watcher.on("error", invalidate);
    check();
    if (invalid) {
      close();
      throw denied();
    }
  } catch {
    close();
    throw denied();
  }
  return {
    close,
    attach(process) {
      child = process;
      try {
        lease.childPid = process.pid ?? null;
        lease.childStart = processStart(process.pid);
        fs.writeFileSync(file, JSON.stringify(lease), { mode: 0o600 });
      } catch {
        invalidate();
      }
      child.once("error", close);
      child.once("exit", () => {
        if (!stopping) close();
      });
      check();
      if (invalid) invalidate();
    },
  };
}
