// Process metadata only. Never request command lines or environments.
import { execFileSync } from "node:child_process";
import path from "node:path";

export function processSnapshot() {
  const env = { LC_ALL: "C" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[key]) env[key] = process.env[key];
  const options = {
    encoding: "utf8",
    env,
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  };
  if (process.platform === "win32") {
    const ps = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='start';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
    const data = JSON.parse(
      execFileSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        options,
      ),
    );
    return (Array.isArray(data) ? data : [data]).map((p) => ({
      pid: p.ProcessId,
      parent: p.ParentProcessId,
      start: p.start,
    }));
  }
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,stat=,lstart="], options)
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      return !match || match[3].startsWith("Z")
        ? []
        : [{ pid: Number(match[1]), parent: Number(match[2]), start: match[4] }];
    });
}

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Invalid process reference");
  return processSnapshot().find((p) => p.pid === pid)?.start ?? null;
}

export async function stopRecordedTree(pid, start) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string" || !start)
    throw Error("API runtime process identity is unavailable");
  const snapshot = processSnapshot();
  const root = snapshot.find((p) => p.pid === pid);
  if (!root) return;
  if (root.start !== start) throw Error("API runtime process identity changed");
  const targets = [root];
  for (let i = 0; i < targets.length; i++)
    targets.push(
      ...snapshot.filter(
        (p) =>
          p.parent === targets[i].pid &&
          Date.parse(p.start) >= Date.parse(targets[i].start) &&
          !targets.some((t) => t.pid === p.pid),
      ),
    );
  // Capture first, then stop descendants before their parent can exit.
  for (const target of targets.toReversed()) {
    const current = processIdentity(target.pid);
    if (current === null) continue;
    if (current !== target.start) throw Error("API runtime process identity changed");
    try {
      process.kill(target.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 2000;
  for (;;) {
    const current = processSnapshot();
    if (!targets.some((t) => current.some((p) => p.pid === t.pid && p.start === t.start))) return;
    if (Date.now() >= deadline) throw Error("API runtime tree stop could not be confirmed");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
