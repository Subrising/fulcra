import fs from 'node:fs';
import path from 'node:path';
import { socketLocation, validateSocketDirectory } from './socket-location.mjs';
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owners = new WeakSet();
function stat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export function captureOwnedFiles(home, { pid, epoch }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof epoch !== 'string' || !epoch) throw Error('Invalid child ownership');
  const root = fs.lstatSync(home);
  if (!root.isDirectory() || root.uid !== process.getuid() || root.mode & 0o077 || fs.realpathSync(home) !== home) throw Error('Canonical private child home required');
  const lock = path.join(home, 'process.lock'), location = socketLocation(home), socket = location.socket;
  const socketDirectory = location.external && stat(location.directory) ? validateSocketDirectory(location.directory) : null;
  const fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let held;
  try {
    held = fs.fstatSync(fd);
    if (!held.isFile() || held.size > 1024 || held.uid !== process.getuid() || held.mode & 0o077) throw Error('Private owned lock required');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value.pid !== pid || value.epoch !== epoch) throw Error('Lock belongs to another child');
  } finally { fs.closeSync(fd); }
  const socketStat = stat(socket);
  if (socketStat && (!socketStat.isSocket() || socketStat.uid !== process.getuid() || socketStat.mode & 0o077)) throw Error('Private owned socket required');
  const owner = Object.freeze({ home, root, lock, socket, held, socketStat, socketDirectory, directory: location.external ? location.directory : null }); owners.add(owner); return owner;
}
export function recoverOwnedFiles(owner, { exited }) {
  if (!owners.has(owner) || exited !== true) throw Error('Observed owned-child exit required');
  if (!same(fs.lstatSync(owner.home), owner.root) || fs.realpathSync(owner.home) !== owner.home) throw Error('Child home ownership changed');
  const lock = stat(owner.lock), socket = stat(owner.socket);
  const directory = owner.directory ? stat(owner.directory) : null;
  if (directory && (!owner.socketDirectory || !same(directory, owner.socketDirectory))) throw Error('Socket directory ownership changed');
  if (directory) validateSocketDirectory(owner.directory);
  // Validate both before removing either. A replaced file is never recovered.
  if (lock && !same(lock, owner.held)) throw Error('Lock ownership changed');
  if (socket && (!owner.socketStat || !same(socket, owner.socketStat))) throw Error('Socket ownership changed');
  if (socket) fs.unlinkSync(owner.socket);
  if (lock) fs.unlinkSync(owner.lock);
  if (directory) { try { fs.rmdirSync(owner.directory); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; } }
  owners.delete(owner);
}
