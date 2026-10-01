import { localJson } from '../src/local-machine.mjs';
import { execFile } from 'node:child_process';

// This function also runs on Book over fixed SSH stdin. Credentials remain there.
export async function nativeSnapshot(client, roots) {
  // Keep this projector inside the function serialized to the fixed remote host.
  const usage = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const numbers = { inputTokens: count(value.inputTokens), cachedInputTokens: count(value.cachedInputTokens),
      outputTokens: count(value.outputTokens), totalCostUsd: typeof value.totalCostUsd === 'number' && Number.isFinite(value.totalCostUsd) && value.totalCostUsd >= 0 ? value.totalCostUsd : null,
      contextWindowMaxTokens: count(value.contextWindowMaxTokens), contextWindowUsedTokens: count(value.contextWindowUsedTokens) };
    if (Object.values(numbers).every(n => n === null)) return null;
    const max = numbers.contextWindowMaxTokens, used = numbers.contextWindowUsedTokens;
    const consistent = max !== null && max > 0 && used !== null && used <= max;
    return { ...numbers, contextWindowUsedPercent: consistent ? 100 * used / max : null,
      contextWindowRemainingTokens: consistent ? max - used : null };
  };
  const sessions = [], seen = new Set(), ids = new Set(); let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await client.agents.list({ filter: { includeArchived: true }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
    if (!Array.isArray(result?.entries) || result.entries.length > 100 || typeof result.pageInfo?.hasMore !== 'boolean') throw Error('Malformed native page');
    for (const entry of result.entries) {
      const a = entry?.agent;
      if (!a || typeof a.cwd !== 'string') throw Error('Malformed native entry');
      if (!roots.some(root => a.cwd.startsWith(root + '/'))) continue;
      if (typeof a.id !== 'string' || ids.has(a.id) || !['initializing', 'idle', 'running', 'error', 'closed'].includes(a.status) || !Array.isArray(a.pendingPermissions)) throw Error('Malformed or duplicate native session');
      ids.add(a.id);
      sessions.push({ nativeId: a.id, title: typeof a.title === 'string' ? a.title.slice(0, 120) : null, cwd: a.cwd,
        provider: a.provider, model: a.model ?? null, status: a.status, activeTurn: a.activeTurn != null || a.status === 'running',
        pendingPermissions: a.pendingPermissions.length, lastUserMessageAt: a.lastUserMessageAt ?? null,
        updatedAt: a.updatedAt ?? null, archivedAt: a.archivedAt ?? null, lastUsage: usage(a.lastUsage) });
    }
    if (!result.pageInfo.hasMore) return sessions;
    const next = result.pageInfo.nextCursor;
    if (typeof next !== 'string' || !next || seen.has(next)) throw Error('Unusable native cursor');
    seen.add(next); cursor = next;
  }
  throw Error('Native snapshot exceeded 1000 entries');
}
async function probe(host, snapshot, extraRoots = [], activationModule, settings) {
  const fs = await import('node:fs'), os = await import('node:os');
  let client, roots;
  if (host === 'mini') {
    const { verifyMiniActivation } = await import(activationModule);
    await verifyMiniActivation();
    const base = settings.miniBase;
    const file = base + '/home/controller.secret', stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Invalid native credential');
    const password = fs.readFileSync(file, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw Error('Invalid native credential');
    const { createPaseoClient } = await import(base + '/node_modules/@getpaseo/client/dist/index.js');
    client = createPaseoClient({ url: 'ws://127.0.0.1:6791/ws', password, connectTimeoutMs: 10000 });
    await client.connect();
    roots = [...new Set([...settings.miniTaskRoots, base + '/home/command-centre/tasks'])]; // + the owned child's task root (A3)
  } else {
    const base = settings.bookBase;
    const { verifyPins, connect } = await import(base + '/source/src/runtime.mjs');
    verifyPins(); client = await connect(); roots = [base + '/tasks', ...extraRoots];
  }
  try {
    const sessions = await snapshot(client, roots), disk = fs.statfsSync(roots[0]);
    return { observedAt: new Date().toISOString(), sessions, capacity: { logicalCpuCount: os.cpus().length,
      loadAverage: os.loadavg(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
      taskVolumeAvailableBytes: disk.bavail * disk.bsize },
      note: 'Instantaneous OS counters and last provider-reported session usage, not account quotas or guaranteed worker slots. Usage may be stale; updatedAt is a session timestamp, not a usage measurement timestamp. Null is unknown, including cost; no billing totals are inferred. Closed is retained history, not accepted completion.' };
  } finally { await client.close(); }
}
export async function probeHost(host, extraRoots = []) {
  if (!['mini', 'macbook'].includes(host)) throw Error('Unknown fixed host');
  const settings = localJson('host-probes.json');
  const node = settings.node;
  if (![settings.miniBase, settings.bookBase, settings.bookRootPrefix, node].every(p => typeof p === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(p) && !p.split('/').includes('..')) || !Array.isArray(settings.miniTaskRoots) || settings.miniTaskRoots.some(p => typeof p !== 'string' || !p.startsWith('/') || p.split('/').includes('..')) || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(settings.bookSshTarget)) throw Error('Invalid local host probe configuration');
  if (!Array.isArray(extraRoots) || extraRoots.length>1000 || extraRoots.some(p=>typeof p!=='string'||!p.startsWith(settings.bookRootPrefix)||p.split('/').includes('..'))) throw Error('Invalid enrolled Book roots');
  const source = `setTimeout(() => process.exit(1), 35000).unref(); const snapshot = ${nativeSnapshot.toString()}; const probe = ${probe.toString()};
try { console.log(JSON.stringify(await probe(${JSON.stringify(host)}, snapshot, ${JSON.stringify(extraRoots)}, ${JSON.stringify(new URL('./mini-activation.mjs', import.meta.url).href)}, ${JSON.stringify(settings)}))); } catch { console.error('Native host probe failed'); process.exitCode = 1; }`;
  const command = host === 'mini' ? node : '/usr/bin/ssh';
  const args = host === 'mini' ? ['--input-type=module'] : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', settings.bookSshTarget, '/usr/bin/env ORCA_HOST=macbook ' + node + ' --input-type=module'];
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 45000, maxBuffer: 1048576, killSignal: 'SIGKILL' }, (error, stdout) => {
      try { if (error) throw error; resolve(JSON.parse(stdout)); } catch { reject(Error('Host unavailable')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(source);
  });
}
export async function hostOverview({ probe = probeHost, ownership = async () => [] } = {}) {
  const saved = await ownership().catch(() => null);
  const hosts = await Promise.all(['mini', 'macbook'].map(async host => {
    try {
      const extraRoots=host==='macbook'?[...new Set((saved??[]).filter(r=>r.host==='macbook'&&r.remote?.agentId).map(r=>r.cwd.slice(0,r.cwd.lastIndexOf('/'))))]:[];
      const state = await probe(host,extraRoots);
      const sessions = state.sessions.map(s => {
        const row=saved?.find(r=>(r.host??'mini')===host && (host==='macbook'?r.remote?.agentId:r.id)===s.nativeId && r.cwd===s.cwd);
        return {...s,control:row?.mode??(host==='macbook'?'observation-only':saved===null?'unknown':'not-enrolled'),...(row?{sessionId:row.id,remote:row.remote??null}:{})};
      });
      return { host, available: true, ...state, sessions, counts: { saved: sessions.length,
        activeTurns: sessions.filter(s => s.activeTurn).length, closed: sessions.filter(s => s.status === 'closed').length,
        pendingPermissions: sessions.reduce((n, s) => n + s.pendingPermissions, 0) } };
    } catch { return { host, available: false, observedAt: null, sessions: null, counts: null, capacity: null, reason: 'Native host observation unavailable; activity is unknown.' }; }
  }));
  return { hosts, note: 'Orca-owned task directories only; not a machine-wide agent census. Read-only discovery grants no delegation or cross-host scheduling authority.' };
}
