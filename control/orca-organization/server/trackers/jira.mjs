// J3 Jira Cloud connector (J3-DESIGN.md §7 phase J). Read-only: GET only against the mapped
// <site>.atlassian.net, with the project addressed by its numeric id after the one key-addressed resolve().
// The JQL is built here from that id alone; no caller supplies JQL. The keychain value is either
// "email:api-token" (sent as Basic) or a bearer token; it is read per request and never kept.
import { getJson, TrackerFailure } from './http.mjs';
import { credentialAccount, plainText, validItemRef } from '../../shared/tracker-refs.mjs';
const FIELDS = 'summary,status,labels,updated,project';
export function authorization(value) { return value.includes(':') ? `Basic ${Buffer.from(value, 'utf8').toString('base64')}` : `Bearer ${value}`; }
export function openJql(projectId) {
  if (!/^[1-9][0-9]{0,11}$/.test(projectId)) throw new TrackerFailure('error');
  return `project = ${projectId} AND statusCategory != Done ORDER BY updated DESC`;
}
const state = raw => { const k = raw?.fields?.status?.statusCategory?.key; return k === 'done' ? 'closed' : k === 'new' || k === 'indeterminate' ? 'open' : 'unknown'; };
const iso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
function item(raw, mapping) {
  if (!raw || typeof raw !== 'object' || String(raw.fields?.project?.id ?? '') !== mapping.remoteId || !validItemRef('jira', mapping.remoteName, raw.key)) return null;
  return { ref: raw.key, title: plainText(raw.fields?.summary, 256) ?? '', state: state(raw),
    labels: (Array.isArray(raw.fields?.labels) ? raw.fields.labels : []).map(l => plainText(l, 50)).filter(Boolean).slice(0, 8), updatedAt: iso(raw.fields?.updated) };
}
export function createJiraConnector({ fetcher, secrets }) {
  async function call(site, path, etag = null) {
    let value;
    try { value = await secrets.read(credentialAccount('jira', site)); } catch { throw new TrackerFailure('auth-required'); }
    if (typeof value !== 'string' || !value) throw new TrackerFailure('auth-required');
    return getJson({ fetcher, url: `https://${site}${path}`, etag, headers: { Accept: 'application/json', 'User-Agent': 'fulcra-orca-trackers', Authorization: authorization(value) } });
  }
  return {
    tracker: 'jira',
    async resolve({ site, remoteName }) {
      const r = await call(site, `/rest/api/3/project/${encodeURIComponent(remoteName)}`);
      if (typeof r.json?.id !== 'string' || !/^[1-9][0-9]{0,11}$/.test(r.json.id) || r.json.key !== remoteName) throw new TrackerFailure('invalid-response');
      return { remoteId: r.json.id, remoteName: r.json.key };
    },
    async validate(mapping) {
      const r = await call(mapping.site, `/rest/api/3/project/${mapping.remoteId}`);
      if (String(r.json?.id) !== mapping.remoteId || typeof r.json.key !== 'string') throw new TrackerFailure('invalid-response');
      return { remoteName: r.json.key };
    },
    async listOpen(mapping, { etag = null } = {}) {
      const query = new URLSearchParams({ jql: openJql(mapping.remoteId), maxResults: '50', fields: FIELDS });
      const r = await call(mapping.site, `/rest/api/3/search/jql?${query}`, etag);
      if (r.status === 304) return { notModified: true };
      if (!Array.isArray(r.json?.issues)) throw new TrackerFailure('invalid-response');
      let partial = false; const items = [];
      for (const raw of r.json.issues.slice(0, 50)) { const it = item(raw, mapping); if (it) items.push(it); else partial = true; }
      return { items, partial, etag: r.etag ?? null };
    },
    async get(mapping, itemRef) {
      if (!validItemRef('jira', mapping.remoteName, itemRef)) throw new TrackerFailure('error');
      const r = await call(mapping.site, `/rest/api/3/issue/${itemRef}?fields=${FIELDS}`);
      const it = item(r.json, mapping);
      if (!it || it.ref !== itemRef) throw new TrackerFailure('invalid-response');
      return it;
    },
  };
}
