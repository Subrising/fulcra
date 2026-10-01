// Fulcra J4b Bitbucket connectors (CONTRACTS.md §7.1): "bitbucket" (Bitbucket Cloud, email + API token; pull
// requests and, where the repository has them, issues) and "bitbucket-dc" (Bitbucket Data Center, site + HTTP
// access token with an optional username; pull requests only, Data Center has no issue tracker). Read-only by
// construction: every request is a GET through the `http` it is handed (http.mjs), the host's credential request
// for one account, which adds authentication itself and reaches only api.bitbucket.org/2.0/ or the site's /rest/.
// This module never sees a token, an email, a username or an Authorization header.
//
// Bitbucket Cloud pins a repository by its UUID (braces stripped, so it fits the `issue:` ref), Data Center by its
// numeric id; every item must say it belongs to that repository. Ticket keys (`[A-Z][A-Z0-9]+-\d+`) in pull-request
// titles and source branches are handed to the service, which links them to a mapped Jira project (inferred).
import { TrackerFailure } from '../trackers/http.mjs';
import { plainText } from '../../shared/tracker-refs.mjs';
import { issueRef, prRef, repoKey, commitRef, HOSTNAME } from '../../shared/cc/connector-rules.mjs';
export const CLOSED_WINDOW_DAYS = 30;
const SEG = '[A-Za-z0-9._-]{1,100}', UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', N = '[1-9][0-9]{0,9}';
const UUID = new RegExp(`^${UUID_RE}$`), SHA = /^[0-9a-f]{40}$/, NUMBER = new RegExp(`^${N}$`);
const PATHS = {
  bitbucket: new RegExp(`^/2\\.0/(?:user|repositories/${SEG}/(?:${SEG}|%7B${UUID_RE}%7D(?:/(?:issues|pullrequests)(?:/${N}(?:/commits)?)?)?))$`),
  'bitbucket-dc': new RegExp(`^/rest/api/1\\.0/(?:profile/recent/repos|projects/${SEG}/repos/${SEG}(?:/pull-requests(?:/${N}(?:/commits)?)?)?)$`),
};
const iso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : Number.isSafeInteger(v) && v > 0 ? new Date(v).toISOString() : null;
const PR_STATE = { OPEN: 'open', MERGED: 'merged', DECLINED: 'closed', SUPERSEDED: 'closed' };
const ISSUE_OPEN = new Set(['new', 'open', 'on hold']), ISSUE_CLOSED = new Set(['resolved', 'closed', 'invalid', 'duplicate', 'wontfix']);
const text = (...parts) => parts.filter(p => typeof p === 'string').join('\n').slice(0, 600);
// `#12` is an issue, `PR #12` a pull request: Bitbucket numbers them separately, so the ref says which.
const refNumber = (ref, pr) => { const m = (pr ? /^PR #([1-9][0-9]{0,9})$/ : /^#([1-9][0-9]{0,9})$/).exec(ref ?? ''); if (!m) throw new TrackerFailure('error'); return m[1]; };
export function createBitbucketConnector({ id = 'bitbucket', now = Date.now } = {}) {
  if (id !== 'bitbucket' && id !== 'bitbucket-dc') throw new Error('Unknown Bitbucket connector');
  const dc = id === 'bitbucket-dc';
  async function call(http, path, query = {}) {
    if (!PATHS[id].test(path)) throw new TrackerFailure('error');
    if (!http || typeof http.get !== 'function') throw new TrackerFailure('auth-required');
    return http.get(path, query, { Accept: 'application/json' });
  }
  const since = () => now() - CLOSED_WINDOW_DAYS * 86400000;
  const recent = it => it.state === 'open' || it.state === 'in-progress' || Date.parse(it.updatedAt) >= since();
  const keyFor = remote => dc ? repoKey(id, siteOf(remote), remote.remoteName) : repoKey(id, null, remote.remoteName);
  const siteOf = remote => { const s = typeof remote?.site === 'string' ? remote.site.toLowerCase() : ''; if (!HOSTNAME.test(s)) throw new TrackerFailure('error'); return s; };
  const split = remote => { const [owner, slug, extra] = String(remote?.remoteName ?? '').split('/'); if (!owner || !slug || extra !== undefined) throw new TrackerFailure('error'); return [owner, slug]; };
  // Cloud: addressed by UUID after resolve. Data Center has no id-addressed repository path, so it is addressed by
  // key and slug and every answer is checked against the pinned numeric id.
  const repoPath = remote => {
    const [owner, slug] = split(remote);
    if (dc) return `/rest/api/1.0/projects/${owner}/repos/${slug}`;
    if (!UUID.test(remote.remoteId)) throw new TrackerFailure('error');
    return `/2.0/repositories/${owner}/%7B${remote.remoteId}%7D`;
  };
  const cloudBelongs = (repo, remote) => typeof repo?.uuid === 'string' && repo.uuid.toLowerCase() === `{${remote.remoteId}}`;
  function pr(raw, remote) {
    if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 1) return null;
    if (dc ? String(raw.toRef?.repository?.id ?? '') !== remote.remoteId : !cloudBelongs(raw.destination?.repository, remote)) return null;
    const updatedAt = iso(dc ? raw.updatedDate : raw.updated_on);
    if (!updatedAt) return null;
    const [owner, slug] = split(remote);
    const item = {
      key: prRef(keyFor(remote), raw.id), connector: id, kind: 'pr', ref: `PR #${raw.id}`, title: plainText(raw.title, 256) ?? '',
      state: PR_STATE[raw.state] ?? 'unknown',
      url: dc ? `https://${siteOf(remote)}/projects/${owner}/repos/${slug}/pull-requests/${raw.id}` : `https://bitbucket.org/${remote.remoteName}/pull-requests/${raw.id}`,
      updatedAt, assignee: null, labels: [],
    };
    return { item, text: text(raw.title, dc ? raw.fromRef?.displayId : raw.source?.branch?.name) };
  }
  function issue(raw, remote) {
    if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 1 || !cloudBelongs(raw.repository, remote)) return null;
    const updatedAt = iso(raw.updated_on);
    if (!updatedAt) return null;
    return {
      key: issueRef(id, null, remote.remoteId, String(raw.id)), connector: id, kind: 'issue', ref: `#${raw.id}`, title: plainText(raw.title, 256) ?? '',
      state: ISSUE_OPEN.has(raw.state) ? 'open' : ISSUE_CLOSED.has(raw.state) ? 'closed' : 'unknown',
      url: `https://bitbucket.org/${remote.remoteName}/issues/${raw.id}`, updatedAt,
      assignee: plainText(raw.assignee?.display_name, 80) || null,
      labels: [raw.kind, raw.priority].map(l => plainText(l, 50)).filter(Boolean),
    };
  }
  // Up to `pages` pages of a paged list. Cloud pages are numbered; Data Center pages start at `start`.
  async function paged(http, path, query, pages) {
    const out = [];
    let more = false;
    for (let i = 0; i < pages; i += 1) {
      const r = await call(http, path, dc ? { ...query, start: String(i * 100) } : { ...query, page: String(i + 1) });
      if (!Array.isArray(r?.values)) throw new TrackerFailure('invalid-response');
      out.push(...r.values);
      more = dc ? r.isLastPage === false : typeof r.next === 'string';
      if (!more) break;
    }
    return { values: out, more };
  }
  const cutoff = () => new Date(since()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id, label: dc ? 'Bitbucket Data Center' : 'Bitbucket', kinds: dc ? ['pr'] : ['issue', 'pr'], selfHosted: dc,
    // §7.1 v1: Bitbucket Cloud browser sign-in, then an API token; Data Center an HTTP access token. Browser sign-in
    // needs a broker (J5b), so the registry shows it only when the host reports it available.
    auth: dc ? ['token'] : ['browser', 'token'],
    tokenHelp: dc
      ? { createUrl: 'https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html', scopes: ['Repository read (REPO_READ)'],
        note: 'In Bitbucket open Manage account, then HTTP access tokens, and create a read-only one. For a personal token also enter your username. Fulcra never writes to Bitbucket.' }
      : { createUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens', scopes: ['read:repository:bitbucket', 'read:pullrequest:bitbucket', 'read:issue:bitbucket', 'read:user:bitbucket'],
        note: 'Create an API token with scopes, choose Bitbucket and these read scopes. Fulcra sends it with the email address of your Atlassian account and never writes to Bitbucket.' },
    // Issues are `#n` in this repository (Cloud only); ticket keys in pull requests are resolved by a mapped Jira.
    keyPatterns: dc ? ['[A-Z][A-Z0-9]+-\\d+'] : ['#[1-9][0-9]{0,9}', '[A-Z][A-Z0-9]+-\\d+'],
    sync: { pollSeconds: 120, webhook: false },
    // Operator confirmation: what Bitbucket says "workspace/repository" (Cloud) or "PROJECT/repository" (Data
    // Center) is. The one name-addressed call for Cloud.
    async resolveRemote(http, { remoteName, site }) {
      const m = new RegExp(`^(${SEG})/(${SEG})$`).exec(typeof remoteName === 'string' ? remoteName.trim() : '');
      if (!m || ['.', '..'].includes(m[1]) || ['.', '..'].includes(m[2])) throw new TrackerFailure('not-found');
      if (dc) {
        const host = typeof site === 'string' ? site.trim().toLowerCase() : '';
        if (!HOSTNAME.test(host)) throw new TrackerFailure('error');
        const r = await call(http, `/rest/api/1.0/projects/${m[1]}/repos/${m[2]}`);
        if (!Number.isSafeInteger(r?.id) || r.id < 1 || typeof r.slug !== 'string' || typeof r.project?.key !== 'string'
          || r.slug.toLowerCase() !== m[2].toLowerCase() || r.project.key.toLowerCase() !== m[1].toLowerCase()) throw new TrackerFailure('invalid-response');
        return { remoteId: String(r.id), remoteName: `${r.project.key}/${r.slug}`, site: host };
      }
      const r = await call(http, `/2.0/repositories/${m[1]}/${m[2]}`);
      const uuid = typeof r?.uuid === 'string' ? r.uuid.toLowerCase().replace(/^\{|\}$/g, '') : '';
      if (!UUID.test(uuid) || typeof r.full_name !== 'string' || r.full_name.toLowerCase() !== `${m[1]}/${m[2]}`.toLowerCase()) throw new TrackerFailure('invalid-response');
      return { remoteId: uuid, remoteName: r.full_name, site: null };
    },
    // Open pull requests (and Cloud issues), plus ones finished in the last 30 days, newest first, up to 200.
    // `texts` carries each pull request's title and source branch, for ticket keys (never persisted).
    async listItems(http, { remote, states = ['open', 'closed'] }) {
      const base = repoPath(remote), items = new Map(), texts = {};
      let partial = false;
      const prs = dc
        ? await paged(http, `${base}/pull-requests`, { state: states.includes('closed') ? 'ALL' : 'OPEN', order: 'NEWEST', limit: '100' }, 2)
        : await paged(http, `${base}/pullrequests`, { state: states.includes('closed') ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] : ['OPEN'], sort: '-updated_on', pagelen: '50',
          ...(states.includes('closed') ? { q: `state = "OPEN" OR updated_on > ${cutoff()}` } : {}) }, 2);
      // R-E-6: the pager stops at its bound; more behind it means the read is partial.
      partial ||= prs.more;
      for (const raw of prs.values) {
        const p = pr(raw, remote);
        if (!p) { partial = true; continue; }
        if (recent(p.item)) { items.set(p.item.key, p.item); texts[p.item.key] = p.text; }
      }
      if (!dc) {
        try {
          const found = await paged(http, `${base}/issues`, { sort: '-updated_on', pagelen: '50',
            q: `(state = "new" OR state = "open" OR state = "on hold")${states.includes('closed') ? ` OR updated_on > ${cutoff()}` : ''}` }, 2);
          partial ||= found.more;
          for (const raw of found.values) { const it = issue(raw, remote); if (!it) { partial = true; continue; } if (recent(it)) items.set(it.key, it); }
        } catch (error) {
          // A repository without an issue tracker answers 404: it simply has no issues.
          if (!(error instanceof TrackerFailure && error.failure === 'not-found')) throw error;
        }
      }
      return { items: [...items.values()].slice(0, 200), cursor: null, partial: partial || items.size > 200, texts };
    },
    async getItem(http, { remote, ref }) {
      const isPr = typeof ref === 'string' && ref.startsWith('PR ');
      if (dc && !isPr) throw new TrackerFailure('not-found');
      const n = refNumber(ref, isPr), base = repoPath(remote);
      const raw = await call(http, dc ? `${base}/pull-requests/${n}` : `${base}/${isPr ? 'pullrequests' : 'issues'}/${n}`);
      const it = isPr ? pr(raw, remote)?.item : issue(raw, remote);
      if (!it || it.ref !== ref) throw new TrackerFailure('invalid-response');
      return it;
    },
    // A pull request's commits. Bitbucket reports no pull requests or commits for an issue.
    async listLinksForItem(http, { remote, ref, kind }) {
      if (kind !== 'pr') return { commits: [], prs: [] };
      const n = refNumber(ref, true), base = repoPath(remote), key = keyFor(remote);
      const r = await paged(http, dc ? `${base}/pull-requests/${n}/commits` : `${base}/pullrequests/${n}/commits`, dc ? { limit: '100' } : { pagelen: '100' }, 1);
      const commits = new Set();
      for (const c of r.values) { const sha = dc ? c?.id : c?.hash; if (SHA.test(sha ?? '')) commits.add(commitRef(key, sha)); }
      return { commits: [...commits].slice(0, 100), prs: [] };
    },
    async health(http) {
      try { await call(http, dc ? '/rest/api/1.0/profile/recent/repos' : '/2.0/user', dc ? { limit: '1' } : {}); return { state: 'ok', retryAt: null }; }
      catch (error) {
        const f = error instanceof TrackerFailure ? error.failure : 'error';
        const state = f === 'auth-required' || f === 'forbidden' || f === 'rate-limited' || f === 'offline' ? f : 'offline';
        return { state, retryAt: f === 'rate-limited' && error.retryAfterMs ? new Date(now() + error.retryAfterMs).toISOString() : null };
      }
    },
    // `#n` names an issue in the same repository (Cloud). Ticket keys are Jira's (jira.mjs).
    issueRefsIn(remote, value) {
      if (dc || typeof value !== 'string' || !UUID.test(remote?.remoteId ?? '')) return [];
      return [...new Set([...value.matchAll(/(?<![A-Za-z0-9&/])#([1-9][0-9]{0,9})\b/g)].map(m => issueRef(id, null, remote.remoteId, m[1])))].slice(0, 8);
    },
    repoKeyFor: remote => keyFor(remote),
    // The local clone's origin, if it is this repository (https, with or without a user, or ssh).
    matchesOrigin(remote, origin) {
      const o = typeof origin === 'string' ? origin.trim() : '';
      let m;
      if (dc) {
        const site = siteOf(remote).replace(/\./g, '\\.');
        m = new RegExp(`^(?:https://(?:[^@/]+@)?${site}(?::\\d+)?(?:/[A-Za-z0-9._-]+)?/scm|ssh://git@${site}(?::\\d+)?)/(${SEG})/(${SEG}?)(?:\\.git)?/?$`, 'i').exec(o);
      } else {
        m = new RegExp(`^(?:https://(?:[^@/]+@)?bitbucket\\.org/|git@bitbucket\\.org:|ssh://git@bitbucket\\.org/)(${SEG})/(${SEG}?)(?:\\.git)?/?$`, 'i').exec(o);
      }
      return !!m && `${m[1]}/${m[2]}`.toLowerCase() === String(remote?.remoteName ?? '').toLowerCase();
    },
  };
}
