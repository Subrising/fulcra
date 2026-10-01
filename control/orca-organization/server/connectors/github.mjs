// Fulcra J4 GitHub connector (CONTRACTS.md §7.1). Read-only by construction: every request is a GET through the
// `http` it is handed (http.mjs): the host's credential request for a connected account (the host adds
// authentication and only reaches api.github.com), or the `gh` login via `createGhHttp` with a fixed argv template.
// This module never sees a token or an Authorization header. Every call after resolveRemote is addressed by the
// numeric repository id the mapping pinned, and every item must say it belongs to that repository.
import { TrackerFailure } from '../trackers/http.mjs';
import { plainText } from '../../shared/tracker-refs.mjs';
import { issueRef, prRef, repoKey, commitRef } from '../../shared/cc/connector-rules.mjs';
const API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const PAGE = 100;
export const CLOSED_WINDOW_DAYS = 30;
const NUMBER = '[1-9][0-9]{0,9}', REPO_ID = '[1-9][0-9]{0,11}', ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';
// The only paths this connector ever requests, with their exact query strings.
const PATH = new RegExp(`^/(?:rate_limit|repos/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}|repositories/${REPO_ID}(?:/issues(?:\\?state=open&per_page=${PAGE}&sort=updated|\\?state=closed&per_page=${PAGE}&sort=updated&since=${ISO}|/${NUMBER}(?:/timeline\\?per_page=${PAGE})?)|/pulls/${NUMBER}/commits\\?per_page=${PAGE})?)$`);
export function assertPath(path) { if (typeof path !== 'string' || !PATH.test(path)) throw new TrackerFailure('error'); return path; }
export const ghArgs = path => ['api', '--method', 'GET', '-H', `Accept: ${ACCEPT}`, assertPath(path).slice(1)];
// gh switches to POST as soon as a field is added, so the argv is compared element by element.
export function assertGhArgs(args) {
  const ok = Array.isArray(args) && args.length === 6 && args[0] === 'api' && args[1] === '--method' && args[2] === 'GET'
    && args[3] === '-H' && args[4] === `Accept: ${ACCEPT}` && typeof args[5] === 'string' && PATH.test('/' + args[5]);
  if (!ok) throw new TrackerFailure('error');
  return args;
}
const iso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
const SHA = /^[0-9a-f]{40}$/;
// GitHub closing keywords (docs: "Linking a pull request to an issue").
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#([1-9][0-9]{0,9})\b/gi;
export function closingNumbers(text) { return typeof text === 'string' ? [...new Set([...text.matchAll(CLOSING)].map(m => m[1]))] : []; }
// The `gh` login as an `http`: the same GET-only request shapes, run as `gh api --method GET` with the fixed argv.
export function createGhHttp(gh) {
  return {
    kind: 'cli',
    async get(path, query = {}) {
      if (typeof gh !== 'function') throw new TrackerFailure('auth-required');
      // The query is joined as written: every value is checked by the path allow-list, which also refuses any encoding.
      const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&'), stdout = await gh(assertGhArgs(ghArgs(qs ? `${path}?${qs}` : path)));
      if (typeof stdout !== 'string' || stdout.length > 1048576) throw new TrackerFailure('invalid-response');
      try { return JSON.parse(stdout); } catch { throw new TrackerFailure('invalid-response'); }
    },
  };
}
export function createGithubConnector({ now = Date.now } = {}) {
  // Every request is checked against the exact allow-list, then split into the host's {path, query}.
  async function call(http, target) {
    assertPath(target);
    if (!http || typeof http.get !== 'function') throw new TrackerFailure('auth-required');
    const [path, qs] = target.split('?');
    return http.get(path, Object.fromEntries(new URLSearchParams(qs ?? '')), { Accept: ACCEPT, 'X-GitHub-Api-Version': '2022-11-28' });
  }
  const belongs = (raw, remote) => {
    const url = typeof raw?.repository_url === 'string' ? raw.repository_url.toLowerCase() : '';
    return url === `${API}/repositories/${remote.remoteId}` || url === `${API}/repos/${remote.remoteName.toLowerCase()}`;
  };
  // One issues-API row as a §7.1 item. Pull requests arrive through the same API, marked by `pull_request`.
  function item(raw, remote) {
    if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.number) || raw.number < 1 || !belongs(raw, remote)) return null;
    const n = raw.number, isPr = raw.pull_request && typeof raw.pull_request === 'object';
    const updatedAt = iso(raw.updated_at);
    if (!updatedAt) return null;
    const state = raw.state === 'open' ? 'open' : raw.state !== 'closed' ? 'unknown' : isPr && raw.pull_request.merged_at ? 'merged' : 'closed';
    return {
      key: isPr ? prRef(repoKey('github', null, remote.remoteName), n) : issueRef('github', null, remote.remoteId, String(n)),
      connector: 'github', kind: isPr ? 'pr' : 'issue', ref: `#${n}`, title: plainText(raw.title, 256) ?? '', state,
      url: `https://github.com/${remote.remoteName}/${isPr ? 'pull' : 'issues'}/${n}`, updatedAt,
      assignee: plainText(raw.assignee?.login, 80) || null,
      labels: (Array.isArray(raw.labels) ? raw.labels : []).map(l => plainText(typeof l === 'string' ? l : l?.name, 50)).filter(Boolean).slice(0, 8),
    };
  }
  const numberOf = ref => { const m = /^(?:#|.*[#:])([1-9][0-9]{0,9})$/.exec(ref ?? ''); if (!m) throw new TrackerFailure('error'); return m[1]; };
  return {
    id: 'github', label: 'GitHub', kinds: ['issue', 'pr'], selfHosted: false,
    // §7.1 v1: device sign-in, then token, then the gh login. Browser sign-in needs a broker (J5b), so it is not listed.
    auth: ['device', 'token', 'cli'],
    tokenHelp: {
      createUrl: 'https://github.com/settings/personal-access-tokens/new',
      scopes: ['Repository access: only the repositories you track', 'Metadata: Read-only', 'Issues: Read-only', 'Pull requests: Read-only'],
      note: 'Create a fine-grained token that can only read. Fulcra never writes to GitHub.',
    },
    keyPatterns: ['#[1-9][0-9]{0,9}'],
    sync: { pollSeconds: 60, webhook: false },
    // Operator confirmation: what GitHub says this name is. The one name-addressed call.
    async resolveRemote(http, { remoteName }) {
      const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(typeof remoteName === 'string' ? remoteName.trim() : '');
      if (!m || m[2] === '.' || m[2] === '..') throw new TrackerFailure('not-found');
      const r = await call(http, `/repos/${m[1]}/${m[2]}`);
      if (!Number.isSafeInteger(r?.id) || r.id < 1 || typeof r.full_name !== 'string' || r.full_name.toLowerCase() !== `${m[1]}/${m[2]}`.toLowerCase()) throw new TrackerFailure('invalid-response');
      return { remoteId: String(r.id), remoteName: r.full_name, site: null };
    },
    // Open items, plus items closed or merged within the last 30 days, so worked items do not vanish.
    async listItems(http, { remote, states = ['open', 'closed'] }) {
      const since = new Date(now() - CLOSED_WINDOW_DAYS * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pages = [];
      if (states.includes('open')) pages.push(await call(http, `/repositories/${remote.remoteId}/issues?state=open&per_page=${PAGE}&sort=updated`));
      if (states.includes('closed')) pages.push(await call(http, `/repositories/${remote.remoteId}/issues?state=closed&per_page=${PAGE}&sort=updated&since=${since}`));
      if (!pages.every(Array.isArray)) throw new TrackerFailure('invalid-response');
      // R-E-6: one bounded page per state. A full page may have more behind it, so the read says it is partial.
      let partial = pages.some(p => p.length >= PAGE); const items = new Map();
      for (const raw of pages.flat()) { const it = item(raw, remote); if (!it) { partial = true; continue; } items.set(it.key, it); }
      return { items: [...items.values()].slice(0, 200), cursor: null, partial: partial || items.size > 200 };
    },
    async getItem(http, { remote, ref }) {
      const n = numberOf(ref), raw = await call(http, `/repositories/${remote.remoteId}/issues/${n}`);
      const it = item(raw, remote);
      if (!it || it.ref !== `#${n}`) throw new TrackerFailure('invalid-response');
      return it;
    },
    // Provider-reported links. An issue: the pull requests in this repository that say they close it, and the
    // commits GitHub recorded as closing or referencing it. A pull request: its commits.
    async listLinksForItem(http, { remote, ref, kind }) {
      const n = numberOf(ref), key = repoKey('github', null, remote.remoteName), commits = new Set(), prs = new Set();
      if (kind === 'pr') {
        const rows = await call(http, `/repositories/${remote.remoteId}/pulls/${n}/commits?per_page=${PAGE}`);
        if (!Array.isArray(rows)) throw new TrackerFailure('invalid-response');
        for (const c of rows) if (SHA.test(c?.sha ?? '')) commits.add(commitRef(key, c.sha));
        return { commits: [...commits], prs: [] };
      }
      const events = await call(http, `/repositories/${remote.remoteId}/issues/${n}/timeline?per_page=${PAGE}`);
      if (!Array.isArray(events)) throw new TrackerFailure('invalid-response');
      for (const e of events) {
        if (e?.event === 'cross-referenced') {
          const source = e.source?.issue;
          if (!source?.pull_request || !Number.isSafeInteger(source.number) || !belongs(source, remote)) continue;
          if (closingNumbers(`${source.title ?? ''}\n${source.body ?? ''}`).includes(n)) prs.add(prRef(key, source.number));
        } else if ((e?.event === 'closed' || e?.event === 'referenced') && SHA.test(e.commit_id ?? '')) {
          const url = typeof e.commit_url === 'string' ? e.commit_url.toLowerCase() : '';
          if (url.startsWith(`${API}/repos/${remote.remoteName.toLowerCase()}/commits/`) || url.startsWith(`${API}/repositories/${remote.remoteId}/commits/`)) commits.add(commitRef(key, e.commit_id));
        }
      }
      return { commits: [...commits].slice(0, 100), prs: [...prs].slice(0, 100) };
    },
    async health(http) {
      try { await call(http, '/rate_limit'); return { state: 'ok', retryAt: null }; }
      catch (error) {
        const f = error instanceof TrackerFailure ? error.failure : 'error';
        const state = f === 'auth-required' || f === 'forbidden' || f === 'rate-limited' || f === 'offline' ? f : 'offline';
        return { state, retryAt: f === 'rate-limited' && error.retryAfterMs ? new Date(now() + error.retryAfterMs).toISOString() : null };
      }
    },
    // Ticket keys in commit and branch text (§2.2 inferred, medium): `#n` names an issue in the same repository.
    issueRefsIn(remote, text) {
      if (typeof text !== 'string') return [];
      return [...new Set([...text.matchAll(/(?<![A-Za-z0-9&/])#([1-9][0-9]{0,9})\b/g)].map(m => issueRef('github', null, remote.remoteId, m[1])))].slice(0, 8);
    },
    repoKeyFor: remote => repoKey('github', null, remote.remoteName),
    // The local clone's origin, if it is this repository (https or ssh form).
    matchesOrigin(remote, origin) {
      const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(typeof origin === 'string' ? origin.trim() : '');
      return !!m && m[1].toLowerCase() === remote.remoteName.toLowerCase();
    },
  };
}
