// Fulcra J4b: a provider web URL as the §2.1 ref the owning connector would give the same object, so a pull request
// or commit reported by one tracker (the Jira development panel) joins the one listed by another (GitHub, Bitbucket).
// Only the three repository hosts Fulcra has connectors for are recognised; anything else gives null.
import { HOSTNAME } from '../../shared/cc/connector-rules.mjs';
import { prRef, commitRef, repoKey } from '../../shared/cc/connector-rules.mjs';
const SEG = '[A-Za-z0-9._-]{1,100}', NUMBER = '([1-9][0-9]{0,9})';
const GITHUB = new RegExp(`^https://github\\.com/([A-Za-z0-9-]{1,39}/${SEG})(?:\\.git)?(?:/pull/${NUMBER})?/?$`);
const BITBUCKET = new RegExp(`^https://bitbucket\\.org/(${SEG}/${SEG})(?:/pull-requests/${NUMBER}(?:/.*)?)?/?$`);
// Bitbucket Data Center: https://<site>[/<context>]/projects/<KEY>/repos/<slug>[/pull-requests/<n>[/overview]]
const BITBUCKET_DC = new RegExp(`^https://([^/]+)(?:/[A-Za-z0-9._-]{1,40})?/projects/(${SEG})/repos/(${SEG})(?:/pull-requests/${NUMBER}(?:/.*)?|/browse)?/?$`);
// The repository key and, when the URL is a pull request, its number.
export function repositoryOf(url) {
  if (typeof url !== 'string' || url.length > 512) return null;
  let m = GITHUB.exec(url);
  if (m) return { key: repoKey('github', null, m[1]), number: m[2] ? Number(m[2]) : null };
  m = BITBUCKET.exec(url);
  if (m) return { key: repoKey('bitbucket', null, m[1]), number: m[2] ? Number(m[2]) : null };
  m = BITBUCKET_DC.exec(url);
  if (m && HOSTNAME.test(m[1].toLowerCase()) && m[1].toLowerCase() !== 'bitbucket.org') {
    return { key: repoKey('bitbucket-dc', m[1].toLowerCase(), `${m[2]}/${m[3]}`), number: m[4] ? Number(m[4]) : null };
  }
  return null;
}
export function prRefFromUrl(url) { const r = repositoryOf(url); return r?.number ? prRef(r.key, r.number) : null; }
export function commitRefFromUrl(repositoryUrl, sha) {
  const r = repositoryOf(repositoryUrl);
  return r && !r.number && /^[0-9a-f]{40}$/.test(sha ?? '') ? commitRef(r.key, sha) : null;
}
