// CONTRACTS.md §7.1 (connector descriptor, item) and §7.3 (mapping). Plain JavaScript shared by the
// controller (which stores mappings and observations) and the plugin server (which runs connectors).
import { parseRef, noPersonal } from './refs.mjs';
export const CONNECTOR_ID = /^[a-z][a-z0-9-]{1,31}$/;
export const AUTH_METHODS = Object.freeze(['browser', 'device', 'token', 'cli']);
export const ITEM_KINDS = Object.freeze(['issue', 'ticket', 'pr']);
export const ITEM_STATES = Object.freeze(['open', 'in-progress', 'closed', 'merged', 'unknown']);
export const HEALTH = Object.freeze(['ok', 'auth-required', 'expired', 'forbidden', 'rate-limited', 'offline']);
export const MAPPING_STATES = Object.freeze(['mapped', 'unmapped']);
export const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATIONS = ['resolveRemote', 'listItems', 'getItem', 'listLinksForItem', 'health'];
const str = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const https = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
// The first problem with a connector module, or null. §7.1: token sign-in is REQUIRED for every connector.
export function connectorProblem(c) {
  if (!c || typeof c !== 'object') return 'not an object';
  if (typeof c.id !== 'string' || !CONNECTOR_ID.test(c.id)) return 'id';
  if (!str(c.label, 40)) return 'label';
  if (!Array.isArray(c.kinds) || !c.kinds.length || !c.kinds.every(k => ITEM_KINDS.includes(k))) return 'kinds';
  if (typeof c.selfHosted !== 'boolean') return 'selfHosted';
  if (!Array.isArray(c.auth) || !c.auth.length || c.auth.length > 3 || new Set(c.auth).size !== c.auth.length || !c.auth.every(m => AUTH_METHODS.includes(m))) return 'auth';
  if (!c.auth.includes('token')) return 'auth: token sign-in is required';
  const h = c.tokenHelp;
  if (!h || typeof h !== 'object' || !https(h.createUrl) || !Array.isArray(h.scopes) || h.scopes.length > 12 || !h.scopes.every(s => str(s, 60)) || !str(h.note, 300) || !noPersonal(h.note)) return 'tokenHelp';
  if (!Array.isArray(c.keyPatterns) || c.keyPatterns.length > 4 || !c.keyPatterns.every(p => str(p, 120) && compiles(p))) return 'keyPatterns';
  if (!c.sync || typeof c.sync !== 'object' || !Number.isInteger(c.sync.pollSeconds) || c.sync.pollSeconds < 60 || c.sync.pollSeconds > 3600 || c.sync.webhook !== false) return 'sync';
  for (const op of OPERATIONS) if (typeof c[op] !== 'function') return op;
  return null;
}
function compiles(source) { try { new RegExp(source); return true; } catch { return false; } }
// Refs for tracker objects (§2.1). An issue ref keeps the connector's own item reference without "#".
export function issueRef(connector, site, remoteId, ref) {
  const value = `issue:${connector}${site ? '@' + site : ''}:${remoteId}:${ref}`;
  if (parseRef(value)?.kind !== 'issue') throw new Error('Invalid issue reference');
  return value;
}
export function repoKey(connector, site, path) {
  const value = `${connector}${site ? '@' + site : ''}:${path}`;
  if (parseRef(`repo:${value}`)?.kind !== 'repo') throw new Error('Invalid repository reference');
  return value;
}
export function prRef(key, number) {
  const value = `pr:${key}#${number}`;
  if (parseRef(value)?.kind !== 'pr') throw new Error('Invalid pull request reference');
  return value;
}
export function commitRef(key, sha) {
  const value = `commit:${key}@${sha}`;
  if (parseRef(value)?.kind !== 'commit') throw new Error('Invalid commit reference');
  return value;
}
// §7.1 item, validated before it is persisted or shown. Returns the problem or null.
export function itemProblem(it) {
  if (!it || typeof it !== 'object') return 'not an object';
  const k = parseRef(it.key)?.kind;
  if (k !== 'issue' && k !== 'pr') return 'key';
  if (typeof it.connector !== 'string' || !CONNECTOR_ID.test(it.connector)) return 'connector';
  if (!ITEM_KINDS.includes(it.kind) || (it.kind === 'pr') !== (k === 'pr')) return 'kind';
  if (!str(it.ref, 40) || !str(it.title, 256, 0) || !ITEM_STATES.includes(it.state) || !https(it.url)) return 'fields';
  if (typeof it.updatedAt !== 'string' || Number.isNaN(Date.parse(it.updatedAt))) return 'updatedAt';
  if (it.assignee !== null && !str(it.assignee, 80)) return 'assignee';
  if (!Array.isArray(it.labels) || it.labels.length > 8 || !it.labels.every(l => str(l, 50))) return 'labels';
  // R-E-2 (§1a): provider text is untrusted. No stored or shown field may carry personal or host-specific data.
  if (!noPersonal(it.title) || !noPersonal(it.url) || (it.assignee !== null && !noPersonal(it.assignee)) || !it.labels.every(l => noPersonal(l))) return 'personal data';
  const extra = Object.keys(it).filter(key => !['key', 'connector', 'kind', 'ref', 'title', 'state', 'url', 'updatedAt', 'assignee', 'labels'].includes(key));
  return extra.length ? 'unknown keys' : null;
}
// R-E-2: make a provider item safe to keep, or say it cannot be. A title with personal data is replaced by a plain
// sentence, unsafe labels are dropped and an unsafe assignee is cleared; an unsafe URL (built from the mapping, so
// only a bad remote name could do it) drops the item. `withheld` marks the observation partial.
export const WITHHELD_TITLE = 'Title withheld: it contains personal or host-specific data';
export function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || typeof it.url !== 'string' || !noPersonal(it.url)) return { item: null, withheld: true };
  const title = typeof it.title === 'string' && !noPersonal(it.title) ? WITHHELD_TITLE : it.title;
  const labels = Array.isArray(it.labels) ? it.labels.filter(l => typeof l === 'string' && noPersonal(l)) : it.labels;
  const assignee = typeof it.assignee === 'string' && !noPersonal(it.assignee) ? null : it.assignee;
  const withheld = title !== it.title || assignee !== it.assignee || (Array.isArray(labels) && labels.length !== it.labels.length);
  return { item: withheld ? { ...it, title, labels, assignee } : it, withheld };
}
// §7.3 mapping identity. accountId null means the `gh` command-line login (CONTRACT-CHANGE-J4-1): GitHub only.
export function mappingProblem(m) {
  if (!m || typeof m !== 'object') return 'Invalid tracker mapping';
  if (typeof m.connector !== 'string' || !CONNECTOR_ID.test(m.connector)) return 'Unknown tracker';
  if (m.accountId === null ? m.connector !== 'github' : !(typeof m.accountId === 'string' && UUID.test(m.accountId))) return 'Choose a connected account';
  if (!str(m.remoteId, 64) || !/^[A-Za-z0-9._{}\/-]+$/.test(m.remoteId)) return 'Invalid tracker project id';
  if (!str(m.remoteName, 200) || !noPersonal(m.remoteName)) return 'Invalid tracker project name';
  if (m.site !== null && !(typeof m.site === 'string' && HOSTNAME.test(m.site))) return 'Invalid site';
  if (typeof m.note !== 'string' || m.note.length > 500 || !noPersonal(m.note)) return 'The note must be short and contain no personal data';
  return null;
}
