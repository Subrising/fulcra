import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { privateOwned } from "../../orca-organization/server/owned.mjs";
// macOS sun_path includes its trailing NUL in the 104-byte bound.
const limit = 104;
// Windows has no Unix sockets in Node: the controller listens on a named pipe. Any local user can create a pipe with a
// guessable name first and wait for a client, so the name is NOT derivable: the controller picks a random 128-bit suffix
// at each start and writes the full name to <home>/control.pipe. Clients read the name only from that file, and only
// when it is a private file owned by this user. The pipe is also locked to this user by pipe-acl.mjs.
export const PIPE_FILE = "control.pipe";
const PIPE_NAME = /^\\\\\.\\pipe\\fulcra-[A-Za-z0-9_-]{1,32}-[a-f0-9]{32}$/;
export function pipeName(username = os.userInfo().username, suffix = randomBytes(16).toString("hex")) {
  const user = username.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  return `\\\\.\\pipe\\fulcra-${user}-${suffix}`;
}
/** Controller side: a fresh random pipe name, written to <home>/control.pipe. Returns the name. */
export function createPipeEndpoint(home, { username, suffix } = {}) {
  validateSocketDirectory(home);
  const file = path.join(home, PIPE_FILE);
  const name = pipeName(username, suffix);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, name + "\n", { mode: 0o600, flag: "w" });
  fs.renameSync(temp, file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !privateOwned(stat, file))
    throw Error("Private owned controller pipe file required");
  return name;
}
/** Client side: the pipe name, read only from a private file this user owns. Refuses anything else. */
export function readPipeName(home) {
  const file = path.join(home, PIPE_FILE);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") throw Error("The controller is not running: no pipe file");
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 || !privateOwned(stat, file))
    throw Error("Private owned controller pipe file required");
  const name = fs.readFileSync(file, "utf8").trim();
  if (!PIPE_NAME.test(name)) throw Error("Invalid controller pipe name");
  return name;
}
export function socketLocation(home, platform = process.platform) {
  // The name is secret and per start: see createPipeEndpoint and readPipeName. Nothing here is derivable.
  if (platform === "win32")
    return { socket: null, directory: home, external: false, pipe: true, pipeFile: path.join(home, PIPE_FILE) };
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
  if (location.pipe) return readPipeName(home);
  validateSocket(location.socket);
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
