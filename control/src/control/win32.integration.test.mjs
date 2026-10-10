import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pipeName, createPipeEndpoint, readPipeName, PIPE_FILE } from "./socket-location.mjs";
import { restrictPipeToUser, gateConnections } from "./pipe-acl.mjs";
import {
  privateOwned,
  ownedByMe,
  trustedCode,
  windowsAclProbe,
  WRITE_MASK,
  PRIVATE_MASK,
} from "../../orca-organization/server/owned.mjs";

// Real Windows only: a real named pipe, a real DACL, and the real ACL rules on real folders.
// Run in the desktop session: a file made in an elevated SSH session is owned by Administrators, not by this user.
const win = { skip: process.platform !== "win32" };
const user = () => process.env.USERNAME;
const icacls = (target, ...args) => execFileSync("icacls.exe", [target, ...args], { stdio: "pipe" });

// A private folder: owner is this user, access only for this user and SYSTEM.
function privateFolder() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-")));
  icacls(root, "/setowner", user());
  icacls(root, "/inheritance:r", "/grant:r", `${user()}:(OI)(CI)F`, "/grant:r", "SYSTEM:(OI)(CI)F");
  return root;
}

test("a controller pipe is gated until locked to this user, then serves", win, async () => {
  const name = pipeName();
  const gate = gateConnections((c) => {
    c.on("error", () => {});
    c.once("data", (d) => c.end(`echo:${d.toString().trim()}\n`));
  });
  const server = net.createServer(gate.handler);
  await new Promise((resolve, reject) => (server.once("error", reject), server.listen(name, resolve)));
  const ask = (text) =>
    new Promise((resolve) => {
      const client = net.createConnection(name);
      let out = "";
      client.on("error", () => resolve("error"));
      client.on("data", (d) => (out += d));
      client.on("close", () => resolve(out.trim()));
      client.on("connect", () => client.write(text + "\n"));
    });
  try {
    // Before the lock a connection is destroyed, not served.
    assert.notEqual(await ask("early"), "echo:early");
    await restrictPipeToUser(name);
    gate.open();
    assert.equal(await ask("one"), "echo:one");
    assert.equal(await ask("two"), "echo:two");
    // Instances created after the first connection keep the locked descriptor.
    await restrictPipeToUser(name);
  } finally {
    server.close();
  }
});

test("owner must be exactly this user for private files; code may also be owned by Administrators", win, (t) => {
  const root = privateFolder();
  try {
    assert.equal(privateOwned(fs.lstatSync(root), root), true);
    assert.equal(ownedByMe(fs.lstatSync(root), root), true);
    try {
      icacls(root, "/setowner", "Administrators");
    } catch {
      t.skip("cannot set the owner to Administrators in this session");
      return;
    }
    // Same ACL, other owner: no longer "mine", still acceptable as trusted code.
    assert.equal(windowsAclProbe(root, PRIVATE_MASK, "me"), false);
    assert.equal(windowsAclProbe(root, 0, "me"), false);
    assert.equal(windowsAclProbe(root, WRITE_MASK, "trusted"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("another principal with access fails; an inherit-only entry does not count; a missing path fails closed", win, () => {
  const root = privateFolder();
  try {
    icacls(root, "/grant", "Everyone:(OI)(CI)(IO)F");
    assert.equal(windowsAclProbe(root, PRIVATE_MASK, "me"), true, "inherit-only applies to children, not here");
    icacls(root, "/grant", "Everyone:(OI)(CI)R");
    assert.equal(windowsAclProbe(root, PRIVATE_MASK, "me"), false);
    assert.equal(windowsAclProbe(root, WRITE_MASK, "trusted"), true, "read-only is not a write right");
    assert.equal(windowsAclProbe(path.join(root, "missing"), 0, "me"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the pipe name file is private to this user: written by the controller, refused when widened", win, () => {
  const home = privateFolder();
  try {
    const name = createPipeEndpoint(home);
    assert.equal(readPipeName(home), name);
    const file = path.join(home, PIPE_FILE);
    icacls(file, "/grant", "Everyone:R");
    assert.throws(() => readPipeName(home), /Private owned/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("trustedCode follows the write rule on a real folder", win, () => {
  const root = privateFolder();
  try {
    assert.equal(trustedCode(fs.lstatSync(root), root), true);
    icacls(root, "/grant", "Everyone:(OI)(CI)W");
    assert.equal(trustedCode(fs.lstatSync(root), root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
