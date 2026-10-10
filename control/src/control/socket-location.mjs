import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { privateOwned } from "../../orca-organization/server/owned.mjs";
// macOS sun_path includes its trailing NUL in the 104-byte bound.
const limit = 104;
// Windows has no Unix sockets in Node: the controller listens on a named pipe, \\.\pipe\fulcra-<user>-<digest>.
// The pipe is locked to this user by pipe-acl.mjs when the server starts.
export function pipeName(home, username = os.userInfo().username) {
  const user = username.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const digest = createHash("sha256").update(home).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\fulcra-${user}-${digest}`;
}
export function socketLocation(home, platform = process.platform) {
  if (platform === "win32")
    return { socket: pipeName(home), directory: home, external: false, pipe: true };
  const direct = path.join(home, "control.sock");
  if (Buffer.byteLength(direct) < limit)
    return { socket: direct, directory: home, external: false };
  // Host and children inherit the same per-user macOS TMPDIR.
  const temporary = fs.realpathSync(os.tmpdir());
  validateSocketDirectory(temporary);
  const digest = createHash("sha256").update(home).digest("hex").slice(0, 24);
  const directory = path.join(temporary, `cc-${digest}`),
    socket = path.join(directory, "c.sock");
  if (Buffer.byteLength(socket) >= limit) throw Error("Per-user temporary socket address too long");
  return { socket, directory, external: true };
}
export function validateSocketDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !privateOwned(stat, directory) ||
    fs.realpathSync(directory) !== directory
  )
    throw Error("Canonical private owned socket directory required");
  return stat;
}
export function prepareSocketLocation(home) {
  validateSocketDirectory(home);
  const location = socketLocation(home);
  if (location.external) {
    try {
      fs.mkdirSync(location.directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    validateSocketDirectory(location.directory);
  }
  if (!location.pipe) validateSocket(location.socket);
  return location.socket;
}
export function resolveSocketPath(home) {
  const location = socketLocation(home);
  validateSocketDirectory(location.directory);
  if (!location.pipe) validateSocket(location.socket);
  return location.socket;
}

function validateSocket(socket) {
  let stat;
  try {
    stat = fs.lstatSync(socket);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    !privateOwned(stat, socket)
  )
    throw Error("Private owned socket required");
}
