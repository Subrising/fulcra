import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid watcher PID');
  let out;
  try { out = (await exec('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], {timeout: 2000, maxBuffer: 16384, env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'}})).stdout.trim(); }
  catch (error) { if (error.code === 1 && !error.stdout?.trim()) return null; throw error; }
  const m = out.match(/^(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/);
  if (!m) throw Error('Invalid watcher process identity');
  return {pid, parent: Number(m[1]), started: m[2].replace(/\s+/g, ' '), command: m[3]};
}
export class WatchRegistry {
  constructor(directory, {inspect = processIdentity, kill = pid => process.kill(pid, 'SIGKILL'), limit = 16} = {}) {
    this.directory = directory; this.inspect = inspect; this.kill = kill; this.limit = limit; this.rows = new Map(); this.tail = Promise.resolve();
  }
  serial(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async refresh() {
    return this.serial(async () => {
      await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
      const dir = await fs.lstat(this.directory);
      if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('Private watcher registry required');
      const names = await fs.readdir(this.directory);
      if (names.length > this.limit * 2) throw Error('Watcher registry capacity exceeded');
      const rows = new Map();
      for (const name of names) {
        if (!/^[a-f0-9]{32}\.(json|tmp)$/.test(name)) throw Error('Unknown watcher registry entry');
        const file = path.join(this.directory, name); let stat, content;
        // An exiting child may remove its durable record after readdir, including
        // while a replacement service is reconciling that same private registry.
        try { stat = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Invalid watcher registry file');
        try { content = await fs.readFile(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const row = JSON.parse(content);
        if (Object.keys(row).sort().join() !== 'command,helper,helperSha,key,nonce,parent,parentStarted,pid,started' || row.nonce !== name.slice(0,32) || !/^[a-f0-9]{64}$/.test(row.helperSha) || typeof row.key !== 'string' || row.key.length > 8192 || !path.isAbsolute(row.helper) || path.basename(row.helper) !== 'watch-child.mjs' || typeof row.command !== 'string' || row.command.length > 8192 || !row.command.endsWith(' ' + row.helper + ' ' + row.nonce)) throw Error('Invalid watcher registry identity');
        const child = await this.inspect(row.pid);
        if (!child || child.started !== row.started || child.command !== row.command) { await fs.rm(file, {force:true}); continue; }
        if (sha(await fs.readFile(row.helper)) !== row.helperSha) throw Error('Owned watcher helper changed');
        const parent = await this.inspect(row.parent);
        if (!parent || parent.started !== row.parentStarted) { try { this.kill(row.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        // Kill-sent is not exit. A still-living child keeps its slot and path quarantine.
        const after = await this.inspect(row.pid);
        if (!after || after.started !== row.started || after.command !== row.command) await fs.rm(file, {force:true});
        else { if (name.endsWith('.tmp')) throw Error('Prior watcher registration is incomplete; waiting for verified cleanup'); rows.set(row.nonce, row); }
      }
      this.rows = rows; return [...rows.values()];
    });
  }
  async track({pid, nonce, key, helper}) {
    return this.serial(async () => {
      if (this.rows.size >= this.limit || [...this.rows.values()].some(x => x.key === key)) throw Error('Watcher capacity or path quarantine');
      const child = await this.inspect(pid), parent = await this.inspect(process.pid);
      if (!child || !parent || child.parent !== process.pid || child.command !== process.execPath + ' ' + helper + ' ' + nonce) throw Error('Watcher child identity changed before admission');
      const row = {pid, nonce, key, helper, helperSha: sha(await fs.readFile(helper)), command: child.command, started: child.started, parent: process.pid, parentStarted: parent.started};
      const tmp = path.join(this.directory, nonce + '.tmp'), file = path.join(this.directory, nonce + '.json');
      await fs.writeFile(tmp, JSON.stringify(row), {flag: 'wx', mode: 0o600, flush: true}); await fs.rename(tmp, file);
      const directory = await fs.open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      this.rows.set(nonce, row); return row;
    });
  }
  remove(nonce) {
    return this.serial(async () => { const row = this.rows.get(nonce); if (!row) return; const current = await this.inspect(row.pid); if (current?.started === row.started && current.command === row.command) return; await fs.rm(path.join(this.directory, nonce + '.json'), {force: true}); this.rows.delete(nonce); });
  }
}
