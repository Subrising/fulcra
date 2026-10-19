// Run on an idle Windows PC against the production helper. Never open a daemon home.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32");
function idle() {
  assert.equal(existsSync("D:\\pc-busy.flag"), false, "PC busy flag must be absent");
}
idle();
const modulePath = path.resolve(process.argv[2]);
const api = await import(pathToFileURL(modulePath).href);
const { writeWindowsPrivateFileAtomicSync: commit } = api;
const started = performance.now();
await api.initializeWindowsPrivateFiles();
const initializeMs = Math.round(performance.now() - started);
const root = mkdtempSync(path.join(path.resolve(process.argv[3]), "durability-"));
const file = path.join(root, "journal-\u03bb.json");
const durations = [];
const payloadSizes = [];
const blocking = [];
const uncertainSizes = [];
async function save(bytes) {
  idle();
  payloadSizes.push(Buffer.byteLength(bytes));
  const start = performance.now();
  try {
    commit(file, bytes);
  } catch (error) {
    if (!/requires reconciliation/.test(error.message)) throw error;
    uncertainSizes.push(Buffer.byteLength(bytes));
  }
  blocking.push(performance.now() - start);
  await api.waitForWindowsPrivateFilesSettled();
  durations.push(performance.now() - start);
  assert.deepEqual(readFileSync(file), Buffer.from(bytes));
  assert.equal(
    api.windowsPrivateFileAclIsSafe(file, 852310 + 0x10000000 + 0x40000000 + 1 + 0x80000000),
    true,
  );
}
function powershell(script, args = [], target = file) {
  return spawnSync(
    path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
      ...args,
    ],
    { windowsHide: true, timeout: 30000, env: { ...process.env, FU377_FILE: target } },
  );
}
try {
  assert.equal(
    powershell(
      String.raw`
$s = New-Object Security.AccessControl.DirectorySecurity
$m = [Security.Principal.WindowsIdentity]::GetCurrent().User
$s.SetOwner($m)
$s.SetAccessRuleProtection($true, $false)
$r = New-Object Security.AccessControl.FileSystemAccessRule($m, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$s.AddAccessRule($r)
Set-Acl -LiteralPath $env:FU377_FILE -AclObject $s
`,
      [],
      root,
    ).status,
    0,
  );
  assert.equal(
    api.windowsPrivateFileAclIsSafe(root, 852310 + 0x10000000 + 0x40000000 + 1 + 0x80000000),
    true,
    "private directory ACL",
  );
  await save('{"generation":1}');
  assert.equal(
    powershell(String.raw`
$a = Get-Acl -LiteralPath $env:FU377_FILE
$s = [Security.Principal.SecurityIdentifier]
$m = [Security.Principal.WindowsIdentity]::GetCurrent().User
$r = $a.GetAccessRules($true, $true, $s)
if (!$a.AreAccessRulesProtected -or $a.GetOwner($s) -ne $m -or $r.Count -ne 1 -or $r[0].IdentityReference -ne $m) { exit 1 }
`).status,
    0,
    "protected owner-only ACL",
  );
  await save(Buffer.from('{"generation":2}'));
  await save(Buffer.from([0, 255, 13, 10, 128, 0]));
  for (let i = 0; i < 20; i++) await save(JSON.stringify({ generation: i + 3 }));
  for (const mib of [1, 2, 8]) await save(Buffer.alloc(mib * 1024 * 1024, 120));
  // Exercise the Windows journal limit repeatedly. Each near-cap save must be acknowledged.
  for (let i = 0; i < 20; i++) await save(Buffer.alloc(1024 * 1024, 120));
  assert.deepEqual(uncertainSizes, [], "scaled waits acknowledge writes through 8 MiB");
  assert.ok(Math.max(...blocking) <= 250, "commits stay within the bounded wait");
  assert.ok(
    blocking.every((ms, index) => payloadSizes[index] > 1024 * 1024 || ms <= 100),
    "near-cap commits stay below 100 ms",
  );
  await save('{"generation":3}');
  const writer = path.join(root, "writer.mjs");
  writeFileSync(
    writer,
    "const a=await import(process.argv[2]);await a.initializeWindowsPrivateFiles();a.writeWindowsPrivateFileAtomicSync(process.argv[3],'{\"generation\":4}');process.exit(77);",
  );
  const child = spawnSync(process.execPath, [writer, pathToFileURL(modulePath).href, file], {
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(child.status, 77, "writer exits immediately after commit");
  assert.equal(readFileSync(file, "utf8"), '{"generation":4}');

  idle();
  const aclChanged = powershell(String.raw`
$a = Get-Acl -LiteralPath $env:FU377_FILE
$s = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$r = New-Object System.Security.AccessControl.FileSystemAccessRule($s, 'Read', 'Allow')
$a.AddAccessRule($r)
Set-Acl -LiteralPath $env:FU377_FILE -AclObject $a
`);
  assert.equal(aclChanged.status, 0);
  assert.equal(
    api.windowsPrivateFileAclIsSafe(file, 852310 + 0x10000000 + 0x40000000 + 1 + 0x80000000),
    false,
    "public-read ACL refused",
  );
  await save('{"generation":5}');

  // A separate process holds a short sharing lock. The helper retries after the caller's bounded timeout.
  idle();
  const lockScript = path.join(root, "lock.ps1");
  writeFileSync(
    lockScript,
    String.raw`
$f = [IO.File]::Open($env:FU377_FILE, 'Open', 'Read', 'Read')
[Console]::WriteLine('LOCKED')
Start-Sleep -Milliseconds 300
$f.Close()
`,
  );
  const holder = spawn(
    path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lockScript],
    {
      windowsHide: true,
      env: { ...process.env, FU377_FILE: file },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const holderExit = once(holder, "exit");
  await once(holder.stdout, "data");
  const lockStart = performance.now();
  assert.throws(() => commit(file, '{"generation":6}'), /requires reconciliation/);
  const lockBlockedMs = performance.now() - lockStart;
  assert.ok(lockBlockedMs <= 100);
  await holderExit;
  await api.waitForWindowsPrivateFilesSettled();
  assert.equal(
    readFileSync(file, "utf8"),
    '{"generation":6}',
    "original timed-out commit completes without replay",
  );

  const leftover = path.join(root, ".fulcra-leftover");
  writeFileSync(leftover, "old incomplete bytes");
  await save('{"generation":7}');
  assert.equal(
    readFileSync(leftover, "utf8"),
    "old incomplete bytes",
    "never replay or remove an unowned orphan",
  );
  const blocked = path.join(root, "blocked");
  mkdirSync(blocked);
  assert.throws(
    () => commit(blocked, "must not replace a directory"),
    /Windows durable file commit/,
  );
  await api.waitForWindowsPrivateFilesSettled();
  assert.throws(
    () => commit(path.join(root, "missing", "journal"), "value"),
    /Windows durable file commit/,
  );
  await api.waitForWindowsPrivateFilesSettled();
  assert.deepEqual(
    readdirSync(root).sort(),
    ["blocked", path.basename(file), ".fulcra-leftover", "lock.ps1", "writer.mjs"].sort(),
  );
  assert.equal(readFileSync(file, "utf8"), '{"generation":7}');
  console.log(
    JSON.stringify({
      result: "PASS",
      platform: "win32",
      node: process.version,
      checks: [
        "create",
        "replace",
        "unicode path",
        "binary input",
        "1 MiB near-cap acknowledgements",
        "2 MiB payload",
        "8 MiB payload",
        "owner-only file and directory ACLs",
        "public-read ACL refused",
        "writer exit and independent read",
        "bounded event-loop wait",
        "sharing lock retry",
        "timeout original receipt",
        "leftover not replayed",
        "rename failure",
        "create failure",
        "temporary cleanup",
        "previous receipt retained",
      ],
      initializeMs,
      perSaveMs: durations.map((elapsedMs, index) => ({
        index,
        payloadBytes: payloadSizes[index],
        elapsedMs,
        mainThreadBlockedMs: blocking[index],
      })),
      warmSaveMs: {
        count: durations.length,
        max: Math.max(...durations),
        mean: durations.reduce((a, b) => a + b, 0) / durations.length,
      },
      mainThreadBlockedMs: { max: Math.max(...blocking) },
      uncertainSizes,
      lockBlockedMs,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
