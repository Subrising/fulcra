import test from "node:test";
import assert from "node:assert/strict";
import {
  ownedByMe,
  privateOwned,
  trustedCode,
  powershellExe,
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
test("POSIX: trustedCode allows root or me, refuses group/other write", { skip: !process.getuid }, () => {
  const o = { platform: "linux" };
  assert.equal(trustedCode(st(0o100755), "f", o), true);
  assert.equal(trustedCode(st(0o100755, 0), "f", o), true);
  assert.equal(trustedCode(st(0o100775), "f", o), false);
  assert.equal(trustedCode(st(0o100757), "f", o), false);
  assert.equal(trustedCode(st(0o100755, me + 1), "f", o), false);
});
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
  assert.equal(
    powershellExe({}),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
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
