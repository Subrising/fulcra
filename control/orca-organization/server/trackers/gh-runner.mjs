// J3: the opt-in gh-cli runner (Q2, "broad access"). gh reads its own login; this process never sees the
// token. The environment is rebuilt from scratch so no inherited GH_TOKEN/GITHUB_TOKEN or other secret
// reaches the child, and gh's stderr is classified here and never forwarded.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TrackerFailure } from './http.mjs';
import { assertGhArgs } from './github.mjs';
const CANDIDATES = (process.env.PATH ?? '').split(path.delimiter).filter(p => path.isAbsolute(p)).map(p => path.join(p, 'gh'));
export function classifyGhError(error) {
  if (error?.code === 'ENOENT') return new TrackerFailure('auth-required');
  if (error?.killed || error?.signal === 'SIGTERM') return new TrackerFailure('offline');
  const text = String(error?.stderr ?? '');
  if (/HTTP 401|gh auth login|not logged in/i.test(text)) return new TrackerFailure('auth-required');
  if (/HTTP 403/.test(text) && /rate limit/i.test(text)) return new TrackerFailure('rate-limited', 600000);
  if (/HTTP 429/.test(text)) return new TrackerFailure('rate-limited', 600000);
  if (/HTTP 403/.test(text)) return new TrackerFailure('forbidden');
  if (/HTTP 404/.test(text)) return new TrackerFailure('not-found');
  if (/error connecting|dial tcp|no such host|timeout/i.test(text)) return new TrackerFailure('offline');
  return new TrackerFailure('error');
}
export function ghEnvironment(env = process.env) {
  return { HOME: env.HOME ?? '', PATH: '/usr/bin:/bin', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', ...(env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: env.GH_CONFIG_DIR } : {}) };
}
// `assert` is the caller's fixed argv template; J3's issue reader keeps its own, and the J4 connector passes its.
export function createGhRunner({ binary = CANDIDATES.find(p => fs.existsSync(p)), run = execFile, assert = assertGhArgs } = {}) {
  return args => new Promise((resolve, reject) => {
    assert(args);
    if (!binary) { reject(new TrackerFailure('auth-required')); return; }
    run(binary, args, { env: ghEnvironment(), timeout: 15000, maxBuffer: 1048576, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(classifyGhError(error)); else resolve(stdout);
    });
  });
}
