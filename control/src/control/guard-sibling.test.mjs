import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  guardFolderHash,
  guardSiblingBytes,
  writeGuardSibling,
  GUARD_SIBLING,
} from "./guard-sibling.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.resolve(here, "../../..");

test("a staged guard gets its permission sibling, loadable where no node_modules reaches", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-sibling-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = path.join(dir, "abc", "admission-guard.mjs");
  fs.mkdirSync(path.dirname(guard));
  const bytes = guardSiblingBytes(here, product);
  const file = writeGuardSibling(guard, bytes);
  assert.equal(path.basename(file), GUARD_SIBLING);
  assert.equal(path.dirname(file), path.dirname(guard));
  assert.ok(
    !bytes.toString().includes('"@getpaseo/plugin/server/git"'),
    "package import is pinned",
  );
  const staged = await import(file);
  assert.equal(typeof staged.automaticPermissionProof, "function");
  writeGuardSibling(guard, bytes); // identical rewrite is accepted
  assert.throws(() => writeGuardSibling(guard, Buffer.from("// other")), /drift/);
});

test("deploy-admission copies the sibling when it applies a guard", () => {
  const text = fs.readFileSync(path.join(here, "deploy-admission.mjs"), "utf8");
  assert.match(text, /writeGuardSibling\(destination, guardSibling\)/);
});

test("a release that changes only the sibling stages into a new folder, with no drift error", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-folder-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = Buffer.from("// guard");
  const first = Buffer.from("// permission one");
  const second = Buffer.from("// permission two");
  assert.notEqual(guardFolderHash(guard, first), guardFolderHash(guard, second));
  assert.equal(guardFolderHash(guard, first), guardFolderHash(guard, first));
  const stage = (sibling) => {
    const file = path.join(dir, guardFolderHash(guard, sibling), "admission-guard.mjs");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return writeGuardSibling(file, sibling);
  };
  stage(first);
  assert.doesNotThrow(() => stage(second));
  assert.equal(fs.readdirSync(dir).length, 2);
});

test("the manifest records the sibling hash so activation verifies it", () => {
  const text = fs.readFileSync(path.join(here, "deploy-admission.mjs"), "utf8");
  assert.match(text, /files: \{ \[siblingDestination\]: digest\(guardSibling\) \}/);
});
