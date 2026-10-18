import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { socketLocation, validateSocketDirectory } from "./socket-location.mjs";
import { privateOwned, powershellExe } from "../../orca-organization/server/owned.mjs";
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owners = new WeakSet();
function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function captureOwnedFiles(home, { pid, epoch }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof epoch !== "string" || !epoch)
    throw Error("Invalid child ownership");
  const root = fs.lstatSync(home);
  if (!root.isDirectory() || !privateOwned(root, home) || fs.realpathSync(home) !== home)
    throw Error("Canonical private child home required");
  const lock = path.join(home, "process.lock"),
    location = socketLocation(home),
    socket = location.socket;
  const socketDirectory =
    location.external && stat(location.directory)
      ? validateSocketDirectory(location.directory)
      : null;
  const fd = fs.openSync(
    lock,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let held;
  try {
    held = fs.fstatSync(fd);
    if (!held.isFile() || held.size > 1024 || !privateOwned(held, lock))
      throw Error("Private owned lock required");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (value.pid !== pid || value.epoch !== epoch) throw Error("Lock belongs to another child");
  } finally {
    fs.closeSync(fd);
  }
  // A Windows named pipe is not a file: there is nothing to stat, own or remove.
  const socketStat = location.pipe ? null : stat(socket);
  if (socketStat && (!socketStat.isSocket() || !privateOwned(socketStat, socket)))
    throw Error("Private owned socket required");
  const owner = Object.freeze({
    home,
    root,
    lock,
    socket,
    held,
    socketStat,
    socketDirectory,
    directory: location.external ? location.directory : null,
    pipe: location.pipe === true,
    pipeFile: location.pipe === true ? location.pipeFile : null,
  });
  owners.add(owner);
  return owner;
}
export function recoverOwnedFiles(owner, { exited }) {
  if (!owners.has(owner) || exited !== true) throw Error("Observed owned-child exit required");
  if (!same(fs.lstatSync(owner.home), owner.root) || fs.realpathSync(owner.home) !== owner.home)
    throw Error("Child home ownership changed");
  const lock = stat(owner.lock),
    socket = owner.pipe ? null : stat(owner.socket);
  const directory = owner.directory ? stat(owner.directory) : null;
  if (directory && (!owner.socketDirectory || !same(directory, owner.socketDirectory)))
    throw Error("Socket directory ownership changed");
  if (directory) validateSocketDirectory(owner.directory);
  // Validate both before removing either. A replaced file is never recovered.
  if (lock && !same(lock, owner.held)) throw Error("Lock ownership changed");
  if (socket && (!owner.socketStat || !same(socket, owner.socketStat)))
    throw Error("Socket ownership changed");
  if (socket) fs.unlinkSync(owner.socket);
  // The pipe name file of a controller that exited: the pipe died with it.
  if (owner.pipeFile) fs.rmSync(owner.pipeFile, { force: true });
  if (lock) fs.unlinkSync(owner.lock);
  if (directory) {
    try {
      fs.rmdirSync(owner.directory);
    } catch (error) {
      if (error.code !== "ENOTEMPTY") throw error;
    }
  }
  owners.delete(owner);
}

/** Only ESRCH proves absence. Access failures and unknown errors preserve the lock. */
export function pidIsAlive(pid, { kill = process.kill } = {}) {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
/** When the process with this pid started, in ms; null when it cannot be read. Resolution is one second. */
export function pidStartMs(pid, { platform = process.platform, run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const windows = platform === "win32";
    const command = windows ? powershellExe() : "ps";
    const args = windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop';$lockProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FULCRA_LOCK_PID);if($lockProcess){([DateTimeOffset]$lockProcess.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}",
        ]
      : ["-o", "lstart=", "-p", String(pid)];
    const text = run(command, args, {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", ...(windows ? { FULCRA_LOCK_PID: String(pid) } : {}) },
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ms = windows && /^\d+$/.test(text) ? Number(text) : windows ? NaN : Date.parse(text);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}
/**
 * Recover a proved dead or reused PID, including a crash during the current OS boot.
 * A live owner or unreadable process identity stays protected. The margin covers start-time resolution.
 * File ownership and captured identity checks still apply before any runtime file is removed.
 */
export function recoverStaleProcessLock(
  home,
  { marginMs = 5000, isAlive = pidIsAlive, startMs = pidStartMs } = {},
) {
  const lock = path.join(home, "process.lock");
  const found = stat(lock);
  if (!found) return false;
  if (!found.isFile() || found.size > 1024) return false;
  let value;
  try {
    const fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw Error("Unreadable controller lock");
  }
  if (!Number.isSafeInteger(value?.pid) || value.pid < 1)
    throw Error("Invalid controller lock owner");
  // The wall clock can be wrong. A live pid in the lock means the controller may still run: refuse.
  // The system can give the same pid to another process. That process started after the
  // lock was written, so it is not the controller. If its start time is unknown, refuse (fail closed).
  if (isAlive(value.pid) !== false) {
    const started = startMs(value.pid);
    if (!Number.isFinite(started) || started <= found.mtimeMs + marginMs)
      throw Error("Controller lock pid is still running");
  }
  // The same identity and file checks as a recovery after an observed exit.
  const owner = captureOwnedFiles(home, {
    pid: value?.pid,
    epoch: value?.epoch,
  });
  if (!same(found, owner.held)) throw Error("Lock ownership changed during recovery");
  recoverOwnedFiles(owner, { exited: true });
  return true;
}
