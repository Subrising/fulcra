import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    /\\Fulcra\\acl-cache-v2\.json$/,
  );
  rmSync(t.dir, { recursive: true });
});
test("FU-714: the probe starts PowerShell hidden and NOT detached (detached PowerShell writes no output)", () => {
  const calls = [];
  windowsAclProbe("C:\\p714", PRIVATE_MASK, "me", (file, args, options) => {
    calls.push({ file, args, options });
    return "SAFE\r\n";
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(calls[0].options.windowsHide, true);
  assert.notEqual(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.FULCRA_ACL_PATH, "C:\\p714");
  assert.equal(calls[0].options.env.FULCRA_ACL_OWNER, "me");
  assert.equal(calls[0].options.env.FULCRA_ACL_MASK, String(PRIVATE_MASK));
});
test("FU-714/FU-716: SAFE passes, UNSAFE is a definite refusal, any other output is no answer", () => {
  const answer = (out) => windowsAclProbe("C:\\p714", PRIVATE_MASK, "me", () => out);
  assert.equal(answer("SAFE"), true);
  assert.equal(answer("SAFE\r\n"), true);
  assert.equal(answer("UNSAFE"), false);
  assert.equal(answer("UNSAFE\r\n"), false);
  assert.equal(answer(""), undefined); // what a detached PowerShell returns
  assert.equal(answer("\r\n"), undefined);
  assert.equal(answer("SAFE\r\nUNSAFE"), undefined);
  assert.equal(answer("NOT SAFE"), undefined);
  assert.equal(answer("safe"), undefined);
  const thrown = windowsAclProbe("C:\\p714", PRIVATE_MASK, "me", () => {
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  });
  assert.equal(thrown, undefined);
  // privateOwned refuses an empty answer and an error.
  const s = { mode: 0o700, uid: me, ino: 714, ctimeMs: 1, mtimeMs: 1 };
  const store = fileStore(undefined);
  assert.equal(privateOwned(s, "p714e", { platform: "win32", probe: () => false, store }), false);
  assert.equal(
    privateOwned(s, "p714u", { platform: "win32", probe: () => undefined, store }),
    false,
  );
});
test("FU-716: an empty probe output is never saved, so a later SAFE answer for the same state passes", () => {
  resetAclMemoryCache();
  const t = tempStore();
  try {
    const s = { mode: 0, uid: 0, ino: 716, ctimeMs: 7, mtimeMs: 16 };
    const file = "C:\\p716";
    let out = ""; // the broken detached build: PowerShell wrote nothing
    const probe = (f, mask, owner) => windowsAclProbe(f, mask, owner, () => out);
    const store = fileStore(t.file);
    assert.equal(privateOwned(s, file, { platform: "win32", probe, store }), false);
    assert.equal(store.get(`me|${PRIVATE_MASK}|${file}|716|7|16`), undefined);
    resetAclMemoryCache(); // a new process
    out = "SAFE\r\n";
    assert.equal(
      privateOwned(s, file, { platform: "win32", probe, store: fileStore(t.file) }),
      true,
    );
  } finally {
    resetAclMemoryCache();
    rmSync(t.dir, { recursive: true, force: true });
  }
});
test("FU-716: a thrown probe error is never saved either", () => {
  resetAclMemoryCache();
  const t = tempStore();
  try {
    const s = { mode: 0, uid: 0, ino: 7161, ctimeMs: 1, mtimeMs: 1 };
    let fail = true;
    const probe = (f, mask, owner) =>
      windowsAclProbe(f, mask, owner, () => {
        if (fail) throw new Error("timeout");
        return "SAFE";
      });
    assert.equal(
      privateOwned(s, "C:\\p7161", { platform: "win32", probe, store: fileStore(t.file) }),
      false,
    );
    resetAclMemoryCache();
    fail = false;
    assert.equal(
      privateOwned(s, "C:\\p7161", { platform: "win32", probe, store: fileStore(t.file) }),
      true,
    );
  } finally {
    resetAclMemoryCache();
    rmSync(t.dir, { recursive: true, force: true });
  }
});
const win32 = process.platform === "win32";
/** A folder that only I own and only I, SYSTEM and Administrators may use (as the release stage makes it). */
function privateWindowsDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .trim()
    .split(",")[1]
    .replaceAll('"', "");
  const icacls = (...args) =>
    execFileSync("icacls.exe", [dir, ...args], { windowsHide: true, stdio: "ignore" });
  icacls("/setowner", `*${sid}`);
  icacls(
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  );
  return dir;
}
test(
  "FU-714 Windows: a private folder of mine is SAFE with the real PowerShell probe",
  { skip: !win32 },
  () => {
    const dir = privateWindowsDir("fu714-acl-");
    try {
      assert.equal(windowsAclProbe(dir, PRIVATE_MASK, "me"), true);
      assert.equal(windowsAclProbe(dir, WRITE_MASK, "trusted"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "FU-714 Windows: a folder where Everyone may write is refused by the real probe",
  { skip: !win32 },
  () => {
    const dir = privateWindowsDir("fu714-acl-bad-");
    try {
      assert.equal(windowsAclProbe(dir, PRIVATE_MASK, "me"), true);
      execFileSync("icacls.exe", [dir, "/grant", "*S-1-1-0:(OI)(CI)W"], {
        windowsHide: true,
        stdio: "ignore",
      });
      assert.equal(windowsAclProbe(dir, PRIVATE_MASK, "me"), false);
      assert.equal(windowsAclProbe(dir, WRITE_MASK, "trusted"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("FU-714 Windows: a missing path is an error, never SAFE", { skip: !win32 }, () => {
  const missing = join(tmpdir(), `fu714-missing-${process.pid}-${Date.now()}`);
  assert.equal(windowsAclProbe(missing, PRIVATE_MASK, "me"), undefined);
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
    writeFileSync(join(t.dir, "acl-cache-v2.json"), JSON.stringify({ [key]: true }));
    let n = 0;
    const probe = () => (n++, false);
    const store = fileStore(aclCacheFile({}));
    assert.equal(store.get(key), undefined);
    assert.equal(privateOwned(s, "p678h", { platform: "win32", probe, store }), false);
    assert.equal(n, 1);
    store.set(key, false);
    assert.equal(readFileSync(join(t.dir, "acl-cache-v2.json"), "utf8").includes("false"), false);
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    rmSync(t.dir, { recursive: true });
  }
});
