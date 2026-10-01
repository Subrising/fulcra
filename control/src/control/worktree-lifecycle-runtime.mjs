import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeLifecycle, contained } from './worktree-lifecycle.mjs';
const exec = promisify(execFile);
// All sessions whose working directories share this job must be known and inactive.
export function createWorktreeLifecycle(control, home, options = {}) {
  return new WorktreeLifecycle({ home, db: control.store.db,
    // Even if a controller is installed inside an old job, that job cannot retire itself.
    protectedPaths: [fileURLToPath(import.meta.url)],
    session: async (_id, dir) => {
      const rows = control.store.list().filter(r => r.cwd === dir || r.cwd.startsWith(dir + path.sep));
      try {
        const file = await contained(path.join(home, 'tasks'), path.join(dir, 'SESSION-ID'));
        const id = (await fs.readFile(file, 'utf8')).trim();
        if (!rows.some(r => r.id === id)) rows.push({ id });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!rows.length) return { state: 'unknown' };
      const snapshots = await Promise.all(rows.map(r => control.native.snapshot(r.id)));
      const label = snapshots.find(s => s?.title)?.title;
      if (snapshots.some(s => !s)) return { state: 'unknown' };
      if (snapshots.some(s => s.activeTurn || ['running', 'working', 'starting'].includes(s.status))) return { state: 'live', label };
      if (snapshots.every(s => s.archivedAt)) return { state: 'archived', label, at: new Date(Math.max(...snapshots.map(s => Date.parse(s.archivedAt)))).toISOString() };
      if (snapshots.every(s => s.archivedAt || s.status === 'idle')) return { state: 'idle', label };
      return { state: 'unknown' };
    },
    // PR inspection is read-only and injectable. No shell, fetch URL or command comes from RPC input.
    pr: async (_id, dir) => {
      const values = [];
      const visit = async d => {
        await contained(path.join(home, 'tasks'), d);
        const entries = await fs.readdir(d, { withFileTypes: true });
        if (entries.some(e => e.name === '.git')) {
          try { const { stdout } = await exec('gh', ['pr', 'view', '--json', 'state,mergedAt'], { cwd: d, timeout: 10000, maxBuffer: 65536 }); values.push(JSON.parse(stdout)); }
          catch { values.push(null); }
          return;
        }
        for (const e of entries) if (e.isDirectory() && !['inputs', 'kept-files', 'node_modules', 'dist', 'build'].includes(e.name)) await visit(path.join(d, e.name));
      };
      await visit(dir);
      // Every repo must be merged: one merged PR must not retire another repo's open work.
      if (values.length && values.every(v => v?.state === 'MERGED' && v.mergedAt)) return { state: 'merged', at: new Date(Math.max(...values.map(v => Date.parse(v.mergedAt)))).toISOString() };
      return { state: values.some(v => v?.state === 'OPEN') ? 'open' : 'unknown' };
    }, ...options });
}
