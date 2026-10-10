import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { socketLocation, validateSocketDirectory } from "./socket-location.mjs";
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
  if (
    !root.isDirectory() ||
    root.uid !== process.getuid() ||
    root.mode & 0o077 ||
    fs.realpathSync(home) !== home
  )
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
    if (!held.isFile() || held.size > 1024 || held.uid !== process.getuid() || held.mode & 0o077)
      throw Error("Private owned lock required");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (value.pid !== pid || value.epoch !== epoch) throw Error("Lock belongs to another child");
  } finally {
    fs.closeSync(fd);
  }
  const socketStat = stat(socket);
  if (
    socketStat &&
    (!socketStat.isSocket() || socketStat.uid !== process.getuid() || socketStat.mode & 0o077)
  )
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
  });
  owners.add(owner);
  return owner;
}
export function recoverOwnedFiles(owner, { exited }) {
  if (!owners.has(owner) || exited !== true) throw Error("Observed owned-child exit required");
  if (!same(fs.lstatSync(owner.home), owner.root) || fs.realpathSync(owner.home) !== owner.home)
    throw Error("Child home ownership changed");
  const lock = stat(owner.lock),
    socket = stat(owner.socket);
  const directory = owner.directory ? stat(owner.directory) : null;
  if (directory && (!owner.socketDirectory || !same(directory, owner.socketDirectory)))
    throw Error("Socket directory ownership changed");
  if (directory) validateSocketDirectory(owner.directory);
  // Validate both before removing either. A replaced file is never recovered.
  if (lock && !same(lock, owner.held)) throw Error("Lock ownership changed");
  if (socket && (!owner.socketStat || !same(socket, owner.socketStat)))
    throw Error("Socket ownership changed");
  if (socket) fs.unlinkSync(owner.socket);
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

/** When this computer last started, in ms. */
export const systemBootMs = () => Date.now() - os.uptime() * 1000;
/** True when a process with this pid exists. EPERM means it exists but belongs to another user. */
export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
/** When the process with this pid started, in ms; null when it cannot be read. Resolution is one second. */
export function pidStartMs(pid) {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
/**
 * Fulcra 0.2.9: a controller lock written before this computer last started cannot belong to a running controller, so
 * the host may recover it. After a restart, the lock of the killed controller stayed and every new controller refused
 * to start. A lock written since the start is never touched here. The margin covers the rounding of the boot time.
 * Returns true when it removed the lock (and the lock's socket).
 */
export function recoverPreBootLock(
  home,
  { bootMs = systemBootMs(), marginMs = 5000, isAlive = pidIsAlive, startMs = pidStartMs } = {},
) {
  const lock = path.join(home, "process.lock");
  const found = stat(lock);
  if (!found) return false;
  if (!found.isFile() || found.size > 1024 || found.mtimeMs >= bootMs - marginMs) return false;
  let value;
  try {
    const fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw Error("Unreadable controller lock from before the restart");
  }
  // The wall clock can be wrong. A live pid in the lock means the controller may still run: refuse.
  // After a restart the system can give the same pid to another process. That process started after the
  // lock was written, so it is not the controller. If its start time is unknown, refuse (fail closed).
  if (Number.isSafeInteger(value?.pid) && value.pid > 0 && isAlive(value.pid)) {
    const started = startMs(value.pid);
    if (started === null || started <= found.mtimeMs + marginMs)
      throw Error("Controller lock pid is still running");
  }
  // The same identity and file checks as a recovery after an observed exit.
  const owner = captureOwnedFiles(home, {
    pid: value?.pid,
    epoch: value?.epoch,
  });
  recoverOwnedFiles(owner, { exited: true });
  return true;
}
