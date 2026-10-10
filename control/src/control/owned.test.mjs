import test from "node:test";
import assert from "node:assert/strict";
import { ownedByMe, privateOwned, trustedCode } from "../../orca-organization/server/owned.mjs";

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
test("Windows: the ACL probe decides, mode and uid are ignored, and the mask differs by question", () => {
  const calls = [];
  const probe = (file, mask) => (calls.push([file, mask]), file === "good");
  const o = { platform: "win32", probe };
  assert.equal(privateOwned(st(0o100666, 0), "good", o), true);
  assert.equal(privateOwned(st(0o100600), "bad", o), false);
  assert.equal(ownedByMe(st(0o100666, 0), "good", o), true);
  assert.equal(trustedCode(st(0o100666, 0), "good", o), true);
  assert.deepEqual([...new Set(calls.map((c) => c[1]))].sort((a, b) => a - b), [0, 852310, 852351]);
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
test("Windows: a throwing or non-true probe fails closed", () => {
  const o = { platform: "win32", probe: () => "SAFE" };
  assert.equal(privateOwned(st(0), "x", o), false);
});
