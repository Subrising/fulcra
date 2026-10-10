import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { pipeName } from "./socket-location.mjs";
import { restrictPipeToUser } from "./pipe-acl.mjs";
import { privateOwned, windowsAclProbe } from "../../orca-organization/server/owned.mjs";

// Real Windows only: a real named pipe, a real DACL, and the real ACL rule on a real folder.
const win = { skip: process.platform !== "win32" };

test("a controller pipe is locked to this user and still serves a request after the lock", win, async () => {
  const name = pipeName(`C:\\fulcra-test-${randomBytes(6).toString("hex")}`);
  const server = net.createServer((c) => {
    c.on("error", () => {});
    c.once("data", (d) => c.end(`echo:${d.toString().trim()}\n`));
  });
  await new Promise((resolve, reject) => (server.once("error", reject), server.listen(name, resolve)));
  try {
    restrictPipeToUser(name);
    const ask = (text) =>
      new Promise((resolve, reject) => {
        const client = net.createConnection(name);
        let out = "";
        client.on("error", reject);
        client.on("data", (d) => (out += d));
        client.on("end", () => resolve(out.trim()));
        client.on("connect", () => client.write(text + "\n"));
      });
    assert.equal(await ask("one"), "echo:one");
    assert.equal(await ask("two"), "echo:two");
    // Instances created after the first connection must keep the locked descriptor.
    restrictPipeToUser(name);
  } finally {
    server.close();
  }
});

test("the ACL rule: a folder reset to this user and SYSTEM is private; granting Everyone makes it not", win, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-"));
  const icacls = (...args) => execFileSync("icacls.exe", [root, ...args], { stdio: "pipe" });
  try {
    icacls("/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`, "/grant:r", "SYSTEM:(OI)(CI)F");
    assert.equal(privateOwned(fs.lstatSync(root), root), true);
    icacls("/grant", "Everyone:(OI)(CI)R");
    // Cached by ctime: a changed ACL moves ctime, so the new state is judged afresh.
    assert.equal(windowsAclProbe(root, 852351), false);
    assert.equal(windowsAclProbe(path.join(root, "missing"), 0), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
