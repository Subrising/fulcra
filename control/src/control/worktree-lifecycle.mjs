import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { assertColumns } from './schema.mjs';
const exec = promisify(execFile);
const outputNames = new Set(['node_modules', 'dist', 'build', '.turbo', '.next', '.expo', '.cache', 'cache', 'caches', '.gradle', 'android-sdk', 'android-ndk']);
const kept = p => p.split(path.sep).includes('inputs') || /(?:\.md|\.(?:png|jpg|jpeg|webp|svg|json|txt|log|pdf))$/i.test(p) || path.basename(p) === 'SESSION-ID';
// One predicate for ignored-file admission and copying: evidence has no silent size cutoff.
const preserveEvidence = p => !p.split(path.sep).includes('node_modules') && kept(p);
const inside = (root, p) => p !== root && p.startsWith(root + path.sep);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
export async function contained(root, target, allowLeafLink = false) {
  const canonical = await fs.realpath(target);
  if (!inside(root, canonical)) throw Error('Path escapes the tasks root'); // containment fence
  // Refuse aliases even when they point back inside: no symlink traversal during deletion.
  if (canonical !== path.resolve(target) && !(allowLeafLink && (await fs.lstat(target)).isSymbolicLink() && await fs.realpath(path.dirname(target)) === path.dirname(target))) throw Error('Symlink paths are not eligible');
  return canonical;
}
async function mkdirInside(root, directory) {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Invalid kept-files destination');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    const next = path.join(current, segment);
    if (current !== root) await contained(root, current);
    try { await fs.mkdir(next); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await contained(root, next); current = next;
  }
}
export function retention(value) {
  if (value !== 'never' && (!Number.isSafeInteger(value) || value < 0 || value > 36500)) throw Error('Choose 0–36500 days or never');
  return value;
}
// V2 can inject read/write of config.worktreeLifecycle.retentionDays without changing the scanner.
export function lifecycleSettings(home) {
  const file = path.join(home, 'worktree-lifecycle.json');
  return {
    async get() { try { return retention(JSON.parse(await fs.readFile(file, 'utf8')).retentionDays); } catch (e) { if (e.code === 'ENOENT') return 'never'; throw e; } },
    async set(value) { retention(value); const temporary = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify({ retentionDays: value }) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); return value; },
  };
}
export class WorktreeLifecycle {
  constructor({ home, db, session, pr = async () => null, settings = lifecycleSettings(home), now = Date.now, protectedPaths = [] }) {
    Object.assign(this, { home: path.resolve(home), db, session, pr, settings, now, protectedPaths });
    this.root = path.join(this.home, 'tasks'); this.plans = new Map(); this.requests = new Map(); this.busy = false;
    db.exec(`CREATE TABLE IF NOT EXISTS cc_job_cleanup(id TEXT PRIMARY KEY,job TEXT NOT NULL,paths TEXT NOT NULL,bytes INTEGER NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,state TEXT NOT NULL)`);
    assertColumns(db, 'cc_job_cleanup', 'id,job,paths,bytes,reason,at,state');
  }
  request(key, start) {
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.error) throw Error(existing.error);
      return existing.value ?? { pending: true, operationId: key };
    }
    for (const [id, r] of this.requests) if ((r.value || r.error) && r.at < this.now() - 3600000) this.requests.delete(id);
    if (this.requests.size >= 20) throw Error('Too many clean-up requests; try again later');
    const record = { at: this.now() }; this.requests.set(key, record);
    record.promise = Promise.resolve().then(start).then(value => { record.value = { pending: false, operationId: key, value }; }, () => { record.error = 'Clean-up could not finish; inspect the journal and refresh'; });
    return { pending: true, operationId: key };
  }
  previewRequest(input = {}) {
    if (input.operationId) {
      if (this.requests.get(input.operationId)?.kind !== 'preview') throw Error('Preview expired; start again');
      return this.request(input.operationId);
    }
    const active = [...this.requests.entries()].find(([, r]) => r.kind === 'preview' && !r.value && !r.error);
    if (active) return { pending: true, operationId: active[0] };
    const key = randomUUID(), out = this.request(key, async () => {
      const plan = await this.dryRun();
      return { ...plan, jobs: plan.jobs.map(j => ({ ...j, keep: j.keep.slice(0, 100) })) };
    });
    this.requests.get(key).kind = 'preview'; return out;
  }
  applyRequest(input) {
    const existing = this.requests.get(input.planId);
    if (existing && existing.kind !== 'apply') throw Error('Invalid apply token');
    if (!existing && this.busy) throw Error('Clean-up is already running');
    const out = this.request(input.planId, () => this.apply(input));
    this.requests.get(input.planId).kind = 'apply'; return out;
  }
  async stop() { await Promise.allSettled([...this.requests.values()].map(r => r.promise)); }
  async walk(dir, visit, category = 'kept') {
    await contained(this.root, dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name); await contained(this.root, p, entry.isSymbolicLink());
      if (entry.isSymbolicLink() && entry.name === '.git') throw Error('Symlink paths are not eligible');
      const kind = entry.name === 'node_modules' ? 'nodeModules' : outputNames.has(entry.name) ? 'buildOutput' : category;
      const stat = await fs.lstat(p);
      await visit(p, entry, stat, kind);
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'kept-files') await this.walk(p, visit, kind);
    }
  }
  async inspect(id, days, accounting = false) {
    const job = { id, label: `Job ${id.slice(0, 8)}`, state: 'unknown', pr: 'unknown', eligible: false, blockers: [], worktrees: [], remove: [], keep: [], bytes: 0, sizes: { worktrees: 0, nodeModules: 0, buildOutput: 0, kept: 0 } };
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) || id === 'admission') throw Error('Invalid job directory');
      const dir = await contained(this.root, path.join(this.root, id));
      for (const protectedPath of this.protectedPaths) {
        const installation = await fs.realpath(protectedPath);
        if (dir === installation || inside(dir, installation)) throw Error('Installation files are protected');
      }
      const s = await this.session(id, dir); job.state = s?.state ?? 'unknown';
      if (typeof s?.label === 'string' && s.label.trim()) job.label = s.label.replace(/\s+/g, ' ').slice(0, 120);
      const p = await this.pr(id, dir); job.pr = p?.state ?? 'unknown';
      const finished = [s?.state === 'archived' ? s.at : null, p?.state === 'merged' ? p.at : null].map(Date.parse).filter(Number.isFinite);
      if (!['idle', 'archived'].includes(job.state)) job.blockers.push(job.state === 'live' ? 'Session is live or running' : 'Session state is unknown');
      if (!finished.length) job.blockers.push('No dated merged pull request or archived session');
      else if (this.now() - Math.max(...finished) < (days === 'never' ? 7 : days) * 86400000) job.blockers.push('Retention period has not passed');
      const files = [], roots = [];
      await this.walk(dir, (p, e, st, category) => { if (files.length >= 100000) throw Error('Job is too large for a safe scan'); files.push({ p, symbolic: e.isSymbolicLink(), directory: e.isDirectory(), size: st.blocks == null ? st.size : st.blocks * 512, category }); if (e.name === '.git') roots.push(path.dirname(p)); });
      if (files.some(f => f.category !== 'kept' && /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|gradle\.properties|.*\.(?:jks|keystore|pem|key))$/i.test(f.p))) job.blockers.push('Signing or configuration files need attention');
      for (const wt of roots) {
        const common = await fs.realpath(path.resolve(wt, await git(wt, 'rev-parse', '--git-common-dir')));
        const listing = await git(common, 'worktree', 'list', '--porcelain');
        const record = listing.split('\n\n').find(r => r.split('\n').includes(`worktree ${wt}`));
        if (!record) throw Error('Worktree registration is missing');
        const branch = record.split('\n').find(l => l.startsWith('branch '))?.slice(7) ?? null;
        const blockers = [];
        if (record.split('\n').some(l => /^locked(?: |$)/.test(l))) blockers.push('Locked worktree needs attention');
        const flags = (await git(wt, 'ls-files', '-v', '-z')).split('\0');
        if (flags.some(l => /^[a-zS] /.test(l))) blockers.push('Hidden index flags or sparse files need attention');
        const sparse = await git(wt, 'config', '--get-regexp', '^core\\.sparseCheckout$').catch(e => { if (e.code === 1) return ''; throw e; });
        if (sparse) blockers.push('Sparse checkout needs attention');
        if (inside(wt, common) || wt === common) blockers.push('Repository owns its Git history');
        if (roots.some(other => other !== wt && inside(wt, other))) blockers.push('Nested repository needs attention');
        const status = await git(wt, 'status', '--porcelain=v1', '--untracked-files=all');
        if (status) blockers.push(status.split('\n').some(l => l.startsWith('??')) ? 'Untracked files need attention' : 'Uncommitted changes need attention');
        // Verify against live remote tips. Unknown local objects fail closed; preview never rewrites shared refs.
        const remotes = (await git(wt, 'remote')).split('\n').filter(Boolean);
        if (!remotes.length) blockers.push('No remote branch can confirm this work is pushed');
        else {
          const remoteHeads = new Set();
          for (const remote of remotes) {
            for (const line of (await git(wt, 'ls-remote', '--heads', remote)).split('\n')) {
              const match = /^([a-f0-9]{40,64})\s+refs\/heads\//.exec(line); if (match) remoteHeads.add(match[1]);
            }
          }
          if (remoteHeads.size > 10000) throw Error('Too many remote branches to verify safely');
          const unpushed = Number(await git(wt, 'rev-list', '--count', 'HEAD', '--not', ...remoteHeads));
          if (unpushed > 0) blockers.push(`${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}`); // fully pushed fence
        }
        if (roots.some(other => other !== wt && (common === other || inside(other, common)))) blockers.push('Git history belongs to another job worktree');
        if (files.some(f => f.directory && path.basename(f.p) === 'kept-files' && inside(wt, f.p))) blockers.push('Preserved files inside a worktree need attention');
        if (!branch) blockers.push('Detached worktree needs attention');
        const ignored = (await git(wt, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z')).split('\0').filter(Boolean);
        if (ignored.some(p => /(?:^|\/)(?:gradle\.properties|.*\.(?:jks|keystore|pem|key))$/i.test(p))) blockers.push('Ignored signing or configuration files need attention');
        if (ignored.some(p => !p.split('/').some(x => outputNames.has(x)) && !preserveEvidence(p))) blockers.push('Unrecognised ignored files need attention');
        job.worktrees.push({ path: path.relative(dir, wt) || '.', branch, head: await git(wt, 'rev-parse', 'HEAD'), blockers });
        for (const b of blockers) job.blockers.push(`${path.relative(dir, wt) || '.'}: ${b}`);
      }
      // A blocked job is left entirely intact, including ignored build output.
      for (const f of files) {
        const rel = path.relative(dir, f.p), wt = roots.find(r => f.p === r || inside(r, f.p));
        const preserve = preserveEvidence(wt ? path.relative(wt, f.p) : rel) || (!wt && !rel.split(path.sep).includes('node_modules'));
        f.preserve = preserve;
        if (preserve && f.symbolic) job.blockers.push('Evidence symlink needs attention');
        if (preserve && !f.directory) job.keep.push(rel);
        const kind = preserve ? 'kept' : f.category !== 'kept' ? f.category : wt ? 'worktrees' : 'kept';
        job.sizes[kind] += f.size;
        if (!preserve && (wt || rel.split(path.sep).includes('node_modules'))) job.bytes += f.size;
        if (f.directory && path.basename(f.p) === 'node_modules' && !wt && !roots.some(r => inside(f.p, r)) && !job.remove.some(r => inside(path.join(dir, r), f.p))) job.remove.push(rel);
      }
      // Keep a working copy available for fresh PR inspection until loose output is gone.
      job.remove = [...job.remove, ...roots.map(r => path.relative(dir, r) || '.')];
      if (files.some(f => f.directory && path.basename(f.p) === 'kept-files' && job.remove.some(r => inside(path.join(dir, r), f.p)))) job.blockers.push('Preserved files inside a removal path need attention');
      job.bytes = files.filter(f => !f.preserve && job.remove.some(r => f.p === path.join(dir, r) || inside(path.join(dir, r), f.p))).reduce((n, f) => n + f.size, 0);
      // Removing a job-root worktree would also remove its kept-files destination.
      if (roots.includes(dir)) job.blockers.push('Job-root worktree needs manual separation of kept files');
      job.eligible = job.blockers.length === 0 && job.remove.length > 0;
      if (accounting) Object.defineProperty(job, 'removedBytes', { value: target => files.filter(f => !f.preserve && (f.p === target || inside(target, f.p))).reduce((n, f) => n + f.size, 0) });
    } catch (e) { job.eligible = false; job.blockers.push(['Path escapes the tasks root', 'Symlink paths are not eligible', 'Invalid job directory', 'Job is too large for a safe scan', 'Installation files are protected'].includes(e.message) ? e.message : 'Inspection failed; nothing will be removed'); }
    if (!job.eligible) job.bytes = 0;
    return job;
  }
  async dryRun() {
    // R8 first-run has config/tasks.json, but no tasks/ directory until a job exists.
    // Only an absent root is an empty inventory; dangling/escaping links still fail closed.
    let entries = [];
    try {
      await fs.lstat(this.root);
      if (await fs.realpath(this.root) !== this.root) throw Error('Canonical tasks root required');
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT' || await fs.lstat(this.root).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; })) throw error;
    }
    const days = await this.settings.get(), jobs = [];
    for (const entry of entries) if (entry.isDirectory() || entry.isSymbolicLink()) jobs.push(await this.inspect(entry.name, days));
    const candidates = [];
    // Candidate listing never traverses symlinks and never grants deletion authority.
    const admission = path.join(this.home, 'admission');
    try {
      if (await fs.realpath(admission) === admission) for (const e of await fs.readdir(admission, { withFileTypes: true })) if (e.isDirectory() && e.name.startsWith('candidate-')) {
        const p = path.join(admission, e.name), st = await fs.stat(p);
        const size = async d => { let bytes = 0; for (const x of await fs.readdir(d, { withFileTypes: true })) { if (x.isSymbolicLink()) continue; const q = path.join(d, x.name), s = await fs.lstat(q); bytes += s.blocks * 512; if (x.isDirectory()) bytes += await size(q); } return bytes; };
        candidates.push({ name: e.name, bytes: await size(p), ageDays: Math.max(0, Math.floor((this.now() - st.mtimeMs) / 86400000)) });
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const planId = randomUUID(), observedAt = new Date(this.now()).toISOString();
    this.plans.set(planId, { at: this.now(), jobs: jobs.filter(j => j.eligible), days });
    for (const [key, p] of this.plans) if (p.at < this.now() - 900000 || this.plans.size > 20) this.plans.delete(key);
    return { version: 1, observedAt, partial: false, planId, retentionDays: days, jobs, candidates };
  }
  async apply({ planId, confirm }, { automatic = false } = {}) {
    if (confirm !== true || !this.plans.has(planId)) throw Error('Preview the clean-up again before confirming');
    if (this.busy) throw Error('Clean-up is already running');
    const plan = this.plans.get(planId); this.plans.delete(planId);
    if (this.now() - plan.at > 900000) throw Error('Preview expired; refresh before confirming');
    this.busy = true; const results = [];
    try {
      for (const listed of plan.jobs) {
        if (automatic && await this.settings.get() === 'never') { results.push({ id: listed.id, bytes: 0, state: 'skipped', reason: 'Automatic clean-up was disabled' }); continue; }
        const fresh = await this.inspect(listed.id, await this.settings.get());
        if (!fresh.eligible || JSON.stringify(fresh.remove) !== JSON.stringify(listed.remove) || JSON.stringify(fresh.worktrees) !== JSON.stringify(listed.worktrees)) { results.push({ id: listed.id, bytes: 0, state: 'skipped', reason: fresh.blockers.join('; ') || 'Contents changed; preview again' }); continue; }
        const dir = path.join(this.root, listed.id), removed = []; let bytes = 0;
        const receipt = randomUUID();
        if (this.db.prepare('SELECT count(*) n FROM cc_job_cleanup').get().n >= 10000) throw Error('Clean-up journal is full; archive it before continuing');
        this.db.prepare('INSERT INTO cc_job_cleanup VALUES (?,?,?,?,?,?,?)').run(receipt, listed.id, '[]', 0, 'Finished job; rechecked before removal', new Date(this.now()).toISOString(), 'intent');
        try {
          for (const rel of fresh.remove) {
            // Recheck the whole job before EVERY destructive operation, including session state.
            if (automatic && await this.settings.get() === 'never') throw Error('Automatic clean-up was disabled');
            const check = await this.inspect(listed.id, await this.settings.get(), true);
            if (check.blockers.length) throw Error('Job changed during clean-up');
            const target = await contained(this.root, path.join(dir, rel));
            const wt = check.worktrees.find(w => w.path === rel);
            const reclaimed = check.removedBytes(target);
            {
              const destination = path.join(dir, 'kept-files', receipt, rel);
              for (const file of check.keep.filter(f => inside(target, path.join(dir, f)))) {
                const source = await contained(this.root, path.join(dir, file));
                const dest = path.join(destination, path.relative(target, source));
                await mkdirInside(this.root, path.dirname(dest));
                await fs.copyFile(source, dest, 1);
              }
            }
            if (wt) {
              const common = await fs.realpath(path.resolve(target, await git(target, 'rev-parse', '--git-common-dir')));
              await git(common, 'worktree', 'remove', '--', target); // never --force; Git independently checks dirtiness
            } else {
              if (path.basename(target) !== 'node_modules' || check.worktrees.some(w => inside(target, path.join(dir, w.path)))) throw Error('Only loose dependencies may be removed');
              await fs.rm(target, { recursive: true });
            }
            removed.push(rel); bytes += reclaimed;
            this.db.prepare('UPDATE cc_job_cleanup SET paths=?,bytes=? WHERE id=?').run(JSON.stringify(removed), bytes, receipt);
          }
          this.db.prepare("UPDATE cc_job_cleanup SET bytes=?,state='complete' WHERE id=?").run(bytes, receipt);
          results.push({ id: listed.id, bytes, state: 'complete', reason: 'Finished files removed; branch and reports kept' });
        } catch { this.db.prepare("UPDATE cc_job_cleanup SET state='needs-attention',reason=? WHERE id=?").run('Clean-up stopped; inspect remaining files', receipt); results.push({ id: listed.id, bytes, state: 'needs-attention', reason: 'Clean-up stopped; inspect remaining files' }); }
      }
      return { version: 1, observedAt: new Date(this.now()).toISOString(), partial: false, results };
    } finally { this.busy = false; }
  }
  async automatic() { if (this.busy || await this.settings.get() === 'never') return; const plan = await this.dryRun(); return this.apply({ planId: plan.planId, confirm: true }, { automatic: true }); }
}
