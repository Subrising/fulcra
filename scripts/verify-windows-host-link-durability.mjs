// Run on Windows against the built production helper. This never opens a daemon home.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32");
const modulePath = path.resolve(process.argv[2]);
const { writeWindowsPrivateFileAtomicSync: commit } = await import(pathToFileURL(modulePath).href);
const root = mkdtempSync(path.join(path.resolve(process.argv[3]), "durability-"));
const file = path.join(root, "journal-\u03bb.json");
const started = performance.now();
function privateAcl() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $acl = Get-Acl -LiteralPath ([Console]::In.ReadToEnd())
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $owner -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $owner -or $rules[0].IsInherited) { exit 1 }
  exit 0
} catch { exit 2 }
`;
  const result = spawnSync(
    path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { input: file, windowsHide: true, timeout: 30000 },
  );
  assert.equal(result.status, 0, "owner-only protected ACL");
}
try {
  commit(file, '{"generation":1}');
  assert.equal(readFileSync(file, "utf8"), '{"generation":1}');
  privateAcl();
  commit(file, Buffer.from('{"generation":2}'));
  assert.equal(readFileSync(file, "utf8"), '{"generation":2}');
  privateAcl();
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const {writeWindowsPrivateFileAtomicSync:commit}=await import(process.argv[1]);commit(process.argv[2],'{\"generation\":3}');process.exit(77);",
      pathToFileURL(modulePath).href,
      file,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  assert.equal(child.status, 77, "writer exits immediately after commit");
  assert.equal(readFileSync(file, "utf8"), '{"generation":3}');
  privateAcl();
  const blocked = path.join(root, "blocked");
  mkdirSync(blocked);
  assert.throws(
    () => commit(blocked, "must not replace a directory"),
    /Windows durable file commit failed/,
  );
  assert.deepEqual(readdirSync(root).sort(), ["blocked", path.basename(file)].sort());
  assert.throws(
    () => commit(path.join(root, "missing", "journal"), "value"),
    /Windows durable file commit failed/,
  );
  assert.equal(readFileSync(file, "utf8"), '{"generation":3}');
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
        "owner-only ACL after each commit",
        "writer exit and independent read",
        "rename failure",
        "create failure",
        "temporary cleanup",
        "previous receipt retained",
      ],
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
