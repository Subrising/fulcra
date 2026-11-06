import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ownedByMe,
  privateOwned,
  trustedCode,
  powershellExe,
  fileStore,
  aclCacheFile,
  resetAclMemoryCache,
  windowsAclProbe,
  WRITE_MASK,
  PRIVATE_MASK,
} from "../../orca-organization/server/owned.mjs";

const me = process.getuid?.() ?? 1000;
const st = (mode, uid = me) => ({ mode, uid, ino: Math.random(), ctimeMs: 1, mtimeMs: 1 });

test("POSIX: privateOwned needs my uid and no group/other bits", { skip: !process.getuid }, () => {
  const o = { platform: "linux" };
  assert.equal(privateOwned(st(0o100600), "f", o), true);
  assert.equal(privateOwned(st(0o100640), "f", o), false);
  assert.equal(privateOwned(st(0o100604), "f", o), false);
  assert.equal(privateOwned(st(0o100600, me + 1), "f", o), false);
});
test("POSIX: ownedByMe looks at the uid only", { skip: !process.getuid }, () => {
  const o = { platform: "linux" };
  assert.equal(ownedByMe(st(0o100666), "f", o), true);
  assert.equal(ownedByMe(st(0o100600, me + 1), "f", o), false);
});
test(
  "POSIX: trustedCode allows root or me, refuses group/other write",
  { skip: !process.getuid },
  () => {
    const o = { platform: "linux" };
    assert.equal(trustedCode(st(0o100755), "f", o), true);
    assert.equal(trustedCode(st(0o100755, 0), "f", o), true);
    assert.equal(trustedCode(st(0o100775), "f", o), false);
    assert.equal(trustedCode(st(0o100757), "f", o), false);
    assert.equal(trustedCode(st(0o100755, me + 1), "f", o), false);
  },
);
test("Windows: the ACL probe decides, mode and uid are ignored; the owner rule is exact for me and wide for code", () => {
  const calls = [];
  const probe = (file, mask, owner) => (calls.push([file, mask, owner]), file === "good");
  const o = { platform: "win32", probe };
  assert.equal(privateOwned(st(0o100666, 0), "good", o), true);
  assert.equal(privateOwned(st(0o100600), "bad", o), false);
  assert.equal(ownedByMe(st(0o100666, 0), "good", o), true);
  assert.equal(trustedCode(st(0o100666, 0), "good", o), true);
  const by = (name) => calls.filter((c) => c[0] === "good").map((c) => c[2]);
  assert.deepEqual(by(), ["me", "me", "trusted"]);
  assert.deepEqual(
    [...new Set(calls.map((c) => c[1]))].sort((a, b) => a - b),
    [0, WRITE_MASK, PRIVATE_MASK].sort((a, b) => a - b),
  );
});
test("masks include the generic rights and stay unsigned", () => {
  assert.ok(WRITE_MASK >= 0 && PRIVATE_MASK >= 0);
  for (const bit of [0x10000000, 0x40000000]) assert.ok(Math.floor(WRITE_MASK / bit) % 2 === 1);
  for (const bit of [0x10000000, 0x40000000, 0x80000000, 0x20000000])
    assert.ok(Math.floor(PRIVATE_MASK / bit) % 2 === 1, `private mask lacks ${bit.toString(16)}`);
  assert.ok(PRIVATE_MASK > WRITE_MASK);
});
test("PowerShell is the absolute system path, never a bare name", () => {
  assert.equal(
    powershellExe({ SystemRoot: "D:\\WIN" }),
    "D:\\WIN\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(powershellExe({}), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});
test("Windows: an answer is cached per file state and refreshed when ctime moves", () => {
  let n = 0;
  const probe = () => (n++, true);
  const o = { platform: "win32", probe };
  const s = { mode: 0, uid: 0, ino: 7, ctimeMs: 10, mtimeMs: 10 };
  privateOwned(s, "c", o);
  privateOwned(s, "c", o);
  assert.equal(n, 1);
  privateOwned({ ...s, ctimeMs: 11 }, "c", o);
  assert.equal(n, 2);
});
test("Windows: the owner rule is part of the cache key", () => {
  const seen = [];
  const probe = (f, m, owner) => (seen.push(owner), true);
  const o = { platform: "win32", probe };
  const s = { mode: 0, uid: 0, ino: 9, ctimeMs: 5, mtimeMs: 5 };
  ownedByMe(s, "k", o);
  trustedCode(s, "k", o);
  assert.deepEqual(seen, ["me", "trusted"]);
});
test("Windows: a throwing or non-true probe fails closed", () => {
  const o = { platform: "win32", probe: () => "SAFE" };
  assert.equal(privateOwned(st(0), "x", o), false);
});

// FU-678: the answer is kept in a file, so a new process (each plugin start) does not run PowerShell again.
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "acl-cache-"));
  const file = join(dir, "sub", "acl.json");
  return { dir, file, open: () => fileStore(file) };
}
test("FU-678: a second process reads the saved answer and does not run the probe", () => {
  const t = tempStore();
  let n = 0;
  const probe = () => (n++, true);
  const s = { mode: 0, uid: 0, ino: 101, ctimeMs: 1, mtimeMs: 1 };
  assert.equal(privateOwned(s, "p678a", { platform: "win32", probe, store: t.open() }), true);
  resetAclMemoryCache();
  assert.equal(privateOwned(s, "p678a", { platform: "win32", probe, store: t.open() }), true);
  assert.equal(n, 1);
  rmSync(t.dir, { recursive: true });
});
test("FU-678: a changed mtime or ctime asks the probe again", () => {
  const t = tempStore();
  let n = 0;
  const probe = () => (n++, true);
  const s = { mode: 0, uid: 0, ino: 102, ctimeMs: 1, mtimeMs: 1 };
  privateOwned(s, "p678b", { platform: "win32", probe, store: t.open() });
  resetAclMemoryCache();
  privateOwned({ ...s, mtimeMs: 2 }, "p678b", { platform: "win32", probe, store: t.open() });
  resetAclMemoryCache();
  privateOwned({ ...s, ctimeMs: 2 }, "p678b", { platform: "win32", probe, store: t.open() });
  assert.equal(n, 3);
  rmSync(t.dir, { recursive: true });
});
test("FU-678: an UNSAFE answer stays a refusal from the saved file, and an error is never saved", () => {
  const t = tempStore();
  const s = { mode: 0, uid: 0, ino: 103, ctimeMs: 1, mtimeMs: 1 };
  let n = 0;
  const unsafe = () => (n++, false);
  assert.equal(
    trustedCode(s, "p678c", { platform: "win32", probe: unsafe, store: t.open() }),
    false,
  );
  resetAclMemoryCache();
  const safe = () => (n++, true);
  assert.equal(trustedCode(s, "p678c", { platform: "win32", probe: safe, store: t.open() }), false);
  assert.equal(n, 1);
  const s2 = { ...s, ino: 104 };
  let m = 0;
  const failing = () => (m++, undefined);
  assert.equal(
    trustedCode(s2, "p678d", { platform: "win32", probe: failing, store: t.open() }),
    false,
  );
  resetAclMemoryCache();
  assert.equal(
    trustedCode(s2, "p678d", { platform: "win32", probe: failing, store: t.open() }),
    false,
  );
  assert.equal(m, 2);
  const saved = JSON.parse(readFileSync(t.file, "utf8"));
  assert.equal(Object.keys(saved).length, 1);
  rmSync(t.dir, { recursive: true });
});
test("FU-678: no file state means no cache; a damaged cache file is ignored", () => {
  let n = 0;
  const probe = () => (n++, true);
  const o = { platform: "win32", probe };
  privateOwned(undefined, "p678e", o);
  privateOwned(undefined, "p678e", o);
  assert.equal(n, 2);
  const t = tempStore();
  const store = fileStore(join(t.dir, "missing.json"));
  assert.equal(store.get("x"), undefined);
  assert.match(
    aclCacheFile({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }),
    /acl-cache-v1\.json$/,
  );
  rmSync(t.dir, { recursive: true });
});
test("FU-678: the default probe starts PowerShell hidden and detached", () => {
  assert.equal(typeof windowsAclProbe, "function");
  assert.match(
    readFileSync(new URL("../../orca-organization/server/owned.mjs", import.meta.url), "utf8"),
    /windowsHide: true,\s*\/\/[^\n]*\n\s*detached: true/,
  );
});
test("FU-678: no absolute LOCALAPPDATA means no cache file, and a planted file is never read", () => {
  assert.equal(aclCacheFile({}), undefined);
  assert.equal(aclCacheFile({ LOCALAPPDATA: "relative\\dir" }), undefined);
  const t = tempStore();
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = t.dir;
  try {
    const s = { mode: 0, uid: 0, ino: 201, ctimeMs: 1, mtimeMs: 1 };
    const key = `me|${PRIVATE_MASK}|p678h|201|1|1`;
    // Hostile file where the old fallback (os.tmpdir) would look.
    writeFileSync(join(t.dir, "acl-cache-v1.json"), JSON.stringify({ [key]: true }));
    let n = 0;
    const probe = () => (n++, false);
    const store = fileStore(aclCacheFile({}));
    assert.equal(store.get(key), undefined);
    assert.equal(privateOwned(s, "p678h", { platform: "win32", probe, store }), false);
    assert.equal(n, 1);
    store.set(key, false);
    assert.equal(readFileSync(join(t.dir, "acl-cache-v1.json"), "utf8").includes("false"), false);
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    rmSync(t.dir, { recursive: true });
  }
});
