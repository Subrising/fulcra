import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
// macOS sun_path includes its trailing NUL in the 104-byte bound.
const limit = 104;
export function socketLocation(home) {
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
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
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
  validateSocket(location.socket);
  return location.socket;
}
export function resolveSocketPath(home) {
  const location = socketLocation(home);
  validateSocketDirectory(location.directory);
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
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error("Private owned socket required");
}
