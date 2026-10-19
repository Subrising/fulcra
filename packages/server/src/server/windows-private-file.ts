import { Worker } from "node:worker_threads";
import path from "node:path";

// One PowerShell process compiles this helper once. No native Node addon is required.
// Flush the temporary file, rename, then reopen and Flush(true) on the target.
// WRITE_THROUGH alone does not guarantee a same-volume namespace commit.
const commitScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class FulcraPrivateCommit {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool MoveFileExW(string source, string target, uint flags);
  private static bool Retry(int error, Stopwatch clock) {
    if ((error != 5 && error != 32) || clock.ElapsedMilliseconds >= 1000) return false;
    Thread.Sleep(25);
    return true;
  }
  private static void Write(string target, string content) {
    string parent = Path.GetDirectoryName(target);
    string temporary = Path.Combine(parent, ".fulcra-" + Guid.NewGuid().ToString("N"));
    var owner = WindowsIdentity.GetCurrent().User;
    var security = new FileSecurity();
    security.SetOwner(owner);
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
    try {
      using (var file = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.FullControl,
          FileShare.None, 4096, FileOptions.None, security)) {
        byte[] bytes = Convert.FromBase64String(content);
        file.Write(bytes, 0, bytes.Length);
        file.Flush(true);
      }
      var clock = Stopwatch.StartNew();
      // No COPY_ALLOWED: the temporary file must stay on the same volume.
      while (!MoveFileExW(temporary, target, 0x1 | 0x8)) {
        int error = Marshal.GetLastWin32Error();
        if (!Retry(error, clock)) throw new System.ComponentModel.Win32Exception(error);
      }
      clock.Restart();
      while (true) {
        try {
          using (var targetFile = new FileStream(target, FileMode.Open, FileAccess.ReadWrite,
              FileShare.ReadWrite | FileShare.Delete)) targetFile.Flush(true);
          break;
        } catch (IOException error) {
          if (!Retry(error.HResult & 0xffff, clock)) throw;
        } catch (UnauthorizedAccessException) {
          if (!Retry(5, clock)) throw;
        }
      }
    } finally {
      if (File.Exists(temporary)) File.Delete(temporary);
    }
  }
  private static bool Safe(string target, long mask) {
    FileSystemSecurity acl = Directory.Exists(target)
      ? (FileSystemSecurity)Directory.GetAccessControl(target) : File.GetAccessControl(target);
    var sid = typeof(SecurityIdentifier);
    string me = WindowsIdentity.GetCurrent().User.Value;
    string[] allowed = { me, "S-1-5-18", "S-1-5-32-544",
      "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
    if (Array.IndexOf(allowed, acl.GetOwner(sid).Value) < 0) return false;
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, sid)) {
      if (rule.AccessControlType != AccessControlType.Allow ||
          (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0 ||
          Array.IndexOf(allowed, rule.IdentityReference.Value) >= 0) continue;
      if (((long)(uint)rule.FileSystemRights & mask) != 0) return false;
    }
    return true;
  }
  public static void Run() {
    Console.SetIn(new StreamReader(Console.OpenStandardInput(),
      new System.Text.UTF8Encoding(false), false, 65536));
    Console.WriteLine("READY");
    string operation;
    while ((operation = Console.ReadLine()) != null) {
      string target = Console.ReadLine();
      string value = Console.ReadLine();
      if (target == null || value == null) return;
      try {
        if (operation == "W") { Write(target, value); Console.WriteLine("OK"); }
        else if (operation == "A") Console.WriteLine(Safe(target, long.Parse(value)) ? "OK" : "FAIL");
        else return;
      } catch { Console.WriteLine("FAIL"); }
    }
  }
}
'@
  # Input values stay inside C#. PowerShell Module Logging cannot bind them.
  [FulcraPrivateCommit]::Run()
} catch { exit 1 }
`;

// The worker owns pipes and waits. The daemon's synchronous admission fences retain
// their order. Waits scale with bytes, with a 250 ms maximum; slow commits become uncertain.
const workerScript = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const child = spawn(workerData.executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
  '-EncodedCommand', Buffer.from(workerData.script, 'utf16le').toString('base64')],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
let active, timer, ready = false, failed = false, text = '';
const queue = [];
function complete(status) {
  clearTimeout(timer);
  if (active) {
    Atomics.store(active.state, 0, status);
    Atomics.notify(active.state, 0);
    active = undefined;
    parentPort.postMessage('SETTLED');
  }
}
function fail() {
  failed = true;
  complete(-2);
  for (const request of queue.splice(0)) {
    Atomics.store(request.state, 0, -2); Atomics.notify(request.state, 0);
  }
  parentPort.postMessage('FAILED');
  child.kill();
}
function next() {
  if (!ready || active || failed || !queue.length) return;
  active = queue.shift();
  timer = setTimeout(fail, 30000);
  child.stdin.write(active.input, (error) => { if (error) fail(); });
}
child.on('error', fail);
child.on('exit', fail);
child.stdin.on('error', fail);
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  text += chunk;
  if (text.length > 1024) return fail();
  let end;
  while ((end = text.indexOf('\n')) >= 0) {
    const line = text.slice(0, end).trim(); text = text.slice(end + 1);
    if (!ready && line === 'READY') {
      ready = true; parentPort.postMessage('READY'); next();
    } else if (ready && active && (line === 'OK' || line === 'FAIL')) {
      complete(line === 'OK' ? 1 : -1); next();
    } else return fail();
  }
});
parentPort.on('message', (request) => {
  request.state = new Int32Array(request.buffer);
  if (failed) { Atomics.store(request.state, 0, -2); Atomics.notify(request.state, 0); return; }
  queue.push(request); next();
});
`;

let helper: Worker | undefined;
let preparation: Promise<void> | undefined;
let pending: Int32Array | undefined;
let pendingOperation: "W" | "A" | undefined;
let unavailable = false;
let ready = false;

/** Start once, outside synchronous provider admission. Cold compilation never blocks the daemon. */
export function initializeWindowsPrivateFiles(
  logger: { warn(message: string): void } = console,
): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  if (preparation) return preparation;
  preparation = new Promise<void>((resolve, reject) => {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) return reject(new Error("Windows SystemRoot is unavailable."));
    const worker = new Worker(workerScript, {
      eval: true,
      workerData: {
        executable: path.win32.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        script: commitScript,
      },
    });
    helper = worker;
    let started = false;
    let failedOnce = false;
    const timer = setTimeout(() => failed(), 30000);
    const failed = () => {
      if (failedOnce || helper !== worker) return;
      failedOnce = true;
      unavailable = true;
      ready = false;
      void worker.terminate();
      clearTimeout(timer);
      reject(new Error("Windows durable file helper is unavailable."));
      const commitPending =
        pendingOperation === "W" && pending && [0, -2].includes(Atomics.load(pending, 0));
      logger.warn(
        commitPending
          ? "Windows durable file helper exited; commit requires reconciliation."
          : "Windows durable file helper exited.",
      );
      // A settled write is safe to read again. Never clear an uncertain write fence.
      // A failed cold start stays unavailable; only a previously ready helper restarts.
      if (started && !commitPending) {
        pending = undefined;
        pendingOperation = undefined;
        preparation = undefined;
        queueMicrotask(() => {
          if (helper !== worker) return;
          helper = undefined;
          void initializeWindowsPrivateFiles(logger).catch(() => {});
        });
      }
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.on("message", (message: unknown) => {
      if (failedOnce) return;
      if (message === "SETTLED") return;
      if (message !== "READY") return failed();
      clearTimeout(timer);
      started = true;
      ready = true;
      unavailable = false;
      worker.unref();
      resolve();
    });
  });
  return preparation;
}

export function windowsPrivateFilesReady(): boolean {
  return ready && !unavailable;
}

/** Do not read an old receipt while an earlier timed-out commit can still change it. */
export function assertWindowsPrivateFilesSettled(): void {
  if (!helper || !ready || unavailable || (pending && [0, -2].includes(Atomics.load(pending, 0))))
    throw new Error("Windows durable file commit requires reconciliation.");
}

function request(operation: "W" | "A", filePath: string, value: string, byteLength = 0): boolean {
  assertWindowsPrivateFilesSettled();
  const target = path.resolve(filePath);
  if (/[\r\n]/.test(target)) throw new Error("Windows private file path is invalid.");
  const state = new Int32Array(new SharedArrayBuffer(4));
  pending = state;
  pendingOperation = operation;
  helper!.postMessage({ buffer: state.buffer, input: `${operation}\n${target}\n${value}\n` }, []);
  const waitMs = Math.min(250, 50 + Math.ceil((15 * byteLength) / (1024 * 1024)));
  Atomics.wait(state, 0, 0, waitMs);
  const result = Atomics.load(state, 0);
  if (result === 0) throw new Error("Windows durable file commit requires reconciliation.");
  return result === 1;
}

export function windowsPrivateFileAclIsSafe(filePath: string, mask: number): boolean {
  try {
    return request("A", filePath, String(mask));
  } catch {
    return false;
  }
}

export function writeWindowsPrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  const bytes =
    typeof data === "string"
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!request("W", filePath, bytes.toString("base64"), bytes.byteLength))
    throw new Error("Windows durable file commit failed.");
}

/** Wait on the original helper receipt; do not repeat the write. */
export async function waitForWindowsPrivateFilesSettled(): Promise<void> {
  if (unavailable || (pending && Atomics.load(pending, 0) === -2))
    throw new Error("Windows durable file helper is unavailable.");
  if (!pending || Atomics.load(pending, 0) !== 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      const fatal = unavailable || (pending && Atomics.load(pending, 0) === -2);
      if (pending && Atomics.load(pending, 0) === 0 && !fatal) return;
      cleanup();
      if (fatal) reject(new Error("Windows durable file helper is unavailable."));
      else resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Windows durable file commit requires reconciliation."));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timer);
      helper?.off("message", done);
    };
    helper?.on("message", done);
    done();
  });
}
