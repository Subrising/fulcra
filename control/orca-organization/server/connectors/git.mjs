// Fulcra J4: read-only git for commit provenance. Five fixed argv templates, checked element by element
// before every spawn, so nothing here can fetch, write, check out or run a hook. The environment is rebuilt
// from scratch (no inherited credentials, no system config, no prompts) and stderr is never forwarded.
import { execFile } from 'node:child_process';
export const SCAN_DAYS = 30, MAX_COMMITS = 200;
const US = '%x1f', RS = '%x1e';
// sha, author time, subject, body (R-E-8: ticket keys in the body count too), then the Fulcra trailers (values only,
// comma separated).
export const LOG_FORMAT = `--format=%H${US}%aI${US}%s${US}%b${US}%(trailers:key=Fulcra-Session,valueonly,separator=%x2c)${US}%(trailers:key=Fulcra-Task,valueonly,separator=%x2c)${RS}`;
export const MAX_BODY = 4000;
const PREFIX = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'log.showSignature=false'];
const BRANCH = /^[A-Za-z0-9._\/-]{1,120}$/;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const gitCommands = {
  toplevel: () => ['rev-parse', '--show-toplevel'],
  branch: () => ['rev-parse', '--abbrev-ref', 'HEAD'],
  origin: () => ['remote', 'get-url', 'origin'],
  log: () => ['log', '--no-color', `--max-count=${MAX_COMMITS}`, `--since=${SCAN_DAYS}.days`, LOG_FORMAT, 'HEAD'],
  // Commits on this branch and on no other local or remote branch (its own remote copy aside).
  unique: branch => ['log', '--no-color', `--max-count=${MAX_COMMITS}`, `--since=${SCAN_DAYS}.days`, '--format=%H', 'HEAD', '--not', `--exclude=${branch}`, '--branches', `--exclude=*/${branch}`, '--remotes'],
};
export function assertGitArgs(dir, args) {
  const ok = typeof dir === 'string' && dir.startsWith('/') && !/[\0\n\r]/.test(dir) && Array.isArray(args)
    && (same(args, gitCommands.toplevel()) || same(args, gitCommands.branch()) || same(args, gitCommands.origin()) || same(args, gitCommands.log())
      || (args.length === 11 && BRANCH.test(args[7]?.slice('--exclude='.length) ?? '') && same(args, gitCommands.unique(args[7].slice('--exclude='.length)))));
  if (!ok) throw new Error('Refused git command');
  return ['-C', dir, ...PREFIX, ...args];
}
export function gitEnvironment(env = process.env) {
  return { HOME: env.HOME ?? '', PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}
// Resolves stdout, or null when git fails (not a repository, no origin, no commits). Never the error text.
export function createGitRunner({ binary = '/usr/bin/git', run = execFile } = {}) {
  return (dir, args) => new Promise(resolve => {
    const argv = assertGitArgs(dir, args);
    run(binary, argv, { env: gitEnvironment(), timeout: 10000, maxBuffer: 8388608, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}
export function parseLog(stdout) {
  if (typeof stdout !== 'string') return [];
  return stdout.split('\x1e').map(r => r.replace(/^\n+/, '')).filter(Boolean).map(r => {
    const [sha, at, subject, body, sessions, tasks] = r.split('\x1f');
    const list = v => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return { sha: (sha ?? '').trim(), at: at ?? '', subject: subject ?? '', body: (body ?? '').slice(0, MAX_BODY), sessions: list(sessions), tasks: list(tasks) };
  }).filter(c => /^[0-9a-f]{40}$/.test(c.sha) && !Number.isNaN(Date.parse(c.at)));
}
