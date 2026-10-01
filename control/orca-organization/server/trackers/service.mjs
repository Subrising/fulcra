// J3 tracker service (J3-DESIGN.md §2, §3.7, §6). It sits between the plugin RPCs and the connectors:
//  - the repository/project it calls is always the one the controller journal maps to the Orca project;
//    no RPC input names a repository, so an unmapped repository is not callable;
//  - tracker observations live only in this process's memory, with observedAt; nothing is persisted, so
//    this never becomes a second board (links, the only records, are in the journal);
//  - failures are an enum with backoff; the last good observation is retained and marked stale.
import { TrackerFailure } from './http.mjs';
import { AUTH, TRACKERS, canonicalUrl, displayRef, itemKey, validItemRef, validRemoteName } from '../../shared/tracker-refs.mjs';
export const COALESCE_MS = 60000;
export const LIMITS = Object.freeze({ projects: 64, items: 128, links: 256, singleFetches: 64 });
const SITE = { github: 'github.com', bitbucket: 'bitbucket.org' };
const failureOf = e => e instanceof TrackerFailure ? e.failure : 'error';
export function createTrackerService({ controller, connectors, now = Date.now }) {
  const states = new Map(), singles = new Map();
  const iso = t => new Date(t).toISOString();
  function stateFor(m) {
    const key = `${m.tracker}:${m.remoteId}:${m.auth}:${m.revision}`;
    let s = states.get(m.projectId);
    if (!s || s.key !== key) { s = { key, items: null, partial: false, observedAt: null, observedName: null, etag: null, status: 'ok', retryAt: 0, failures: 0, lastAttempt: 0, inflight: null }; states.set(m.projectId, s); }
    return s;
  }
  function fail(s, error) {
    const failure = failureOf(error), t = now();
    s.failures += 1;
    if (failure === 'auth-required') s.retryAt = t + 600000;
    else if (failure === 'rate-limited') s.retryAt = t + Math.min(Math.max(Number(error.retryAfterMs) || 60000, 1000), 3600000);
    else if (failure === 'offline') s.retryAt = t + Math.min(600000, 30000 * 2 ** Math.min(s.failures - 1, 5));
    else s.retryAt = t + 60000;
    s.status = s.items && (failure === 'offline' || failure === 'error') ? 'stale' : failure;
  }
  async function refresh(m) {
    const s = stateFor(m), t = now();
    if (s.inflight) { await s.inflight; return s; }
    if (t < s.retryAt) return s;
    if (s.items && s.status === 'ok' && t - s.lastAttempt < COALESCE_MS) return s;
    s.lastAttempt = t;
    s.inflight = (async () => {
      const connector = connectors[m.tracker];
      if (!connector) throw new TrackerFailure('error');
      s.observedName = (await connector.validate(m)).remoteName;
      const r = await connector.listOpen(m, { etag: s.etag, observedName: s.observedName });
      if (!r.notModified) { s.items = new Map(r.items.map(i => [i.ref, i])); s.partial = r.partial; s.etag = r.etag ?? null; }
      s.observedAt = iso(now()); s.status = 'ok'; s.failures = 0; s.retryAt = 0;
    })().catch(error => fail(s, error)).finally(() => { s.inflight = null; });
    await s.inflight;
    return s;
  }
  function out(m, it, stale, previous) {
    return { key: itemKey(m.tracker, m.remoteId, it.ref), projectId: m.projectId, ref: displayRef(m.tracker, it.ref), title: it.title ?? null, state: it.state ?? 'unknown',
      labels: it.labels ?? [], url: canonicalUrl(m.tracker, m.site, m.remoteName, it.ref), updatedAt: it.updatedAt ?? null, stale, fromPreviousMapping: previous };
  }
  async function single(m, ref, s) {
    const key = itemKey(m.tracker, m.remoteId, ref), cached = singles.get(key), t = now();
    if (cached && (t - cached.at < COALESCE_MS || t < cached.retryAt)) return cached.item;
    const entry = { at: t, retryAt: 0, item: cached?.item ?? null };
    try { entry.item = await connectors[m.tracker].get(m, ref, { observedName: s.observedName }); }
    catch (error) { entry.retryAt = t + (failureOf(error) === 'rate-limited' ? 600000 : 60000); }
    singles.set(key, entry);
    return entry.item;
  }
  async function read({ projectId, subjects } = {}) {
    const mapped = (await controller('trackers-status')).mappings.filter(m => m.state === 'mapped').slice(0, LIMITS.projects);
    let links = [], unmapped = null;
    if (projectId) { const view = await controller('trackers-project', projectId); links = view.links; if (view.mapping?.state !== 'mapped') unmapped = view.mapping; }
    else if (subjects?.length) links = (await controller('trackers-links-for', { subjects })).links;
    const wanted = projectId ? mapped.filter(m => m.projectId === projectId) : mapped.filter(m => links.some(l => l.projectId === m.projectId));
    const projects = [], items = new Map(); let partial = false;
    for (const m of wanted) {
      const s = await refresh(m), stale = s.status !== 'ok';
      partial ||= s.partial || stale;
      projects.push({ projectId: m.projectId, tracker: m.tracker, remoteName: m.remoteName, mappingRevision: m.revision, status: s.status,
        retryAt: s.retryAt > now() ? iso(s.retryAt) : null, observedAt: s.observedAt });
      if (projectId && s.items) for (const it of [...s.items.values()].slice(0, 50)) { const o = out(m, it, stale, false); items.set(o.key, o); }
    }
    if (projectId && !wanted.length) projects.push({ projectId, tracker: null, remoteName: null, mappingRevision: unmapped?.revision ?? 0, status: 'unmapped', retryAt: null, observedAt: null });
    let fetched = 0;
    const outLinks = [];
    for (const l of links.slice(0, LIMITS.links)) {
      const key = itemKey(l.tracker, l.remoteId, l.itemRef), m = mapped.find(x => x.projectId === l.projectId);
      outLinks.push({ id: l.id, itemKey: key, subject: l.subject, revision: l.revision });
      if (items.has(key)) continue;
      // A link from an earlier mapping is shown from its own record; it is never fetched through the new one.
      if (l.fromPreviousMapping || !m) { items.set(key, out(l, { ref: l.itemRef, title: null, state: 'unknown' }, true, true)); continue; }
      const s = states.get(m.projectId) ?? await refresh(m);
      let it = s.items?.get(l.itemRef) ?? null;
      if (!it && s.status === 'ok' && fetched < LIMITS.singleFetches) { fetched += 1; it = await single(m, l.itemRef, s); }
      items.set(key, out(m, it ?? { ref: l.itemRef, title: null, state: 'unknown' }, s.status !== 'ok' || !it, false));
    }
    return { version: 1, observedAt: iso(now()), partial, projects, items: [...items.values()].slice(0, LIMITS.items), links: outLinks };
  }
  // Tracker failures are the enum only. A controller refusal is one of the controller's own fixed sentences.
  const refused = (error, empty) => ({ ok: false, failure: error instanceof TrackerFailure ? error.failure : 'refused', message: error instanceof TrackerFailure ? null : String(error?.message ?? 'Refused').slice(0, 300), ...empty });
  const NO_MAPPING = { mapping: null }, NO_LINK = { linkId: null, revision: null };
  return {
    read,
    directory: () => controller('trackers-directory'),
    // Operator confirmation step: what the tracker says this name is, before anything is recorded. Only
    // project/repository metadata is read here, never items.
    async resolve({ tracker, auth, site, remoteName }) {
      try {
        if (!TRACKERS.includes(tracker) || !AUTH[tracker].includes(auth) || !validRemoteName(tracker, remoteName)) throw new Error('Invalid tracker mapping');
        const resolved = await connectors[tracker].resolve({ auth, site: SITE[tracker] ?? site, remoteName });
        return { ok: true, failure: null, message: null, remoteId: resolved.remoteId, remoteName: resolved.remoteName };
      } catch (error) { return refused(error, { remoteId: null, remoteName: null }); }
    },
    async map({ projectId, tracker, auth, site, remoteName, confirmRemoteId, expectedRevision, note }) {
      try {
        if (!TRACKERS.includes(tracker) || !AUTH[tracker].includes(auth) || !validRemoteName(tracker, remoteName)) throw new Error('Invalid tracker mapping');
        const pinnedSite = SITE[tracker] ?? site;
        const resolved = await connectors[tracker].resolve({ auth, site: pinnedSite, remoteName });
        if (resolved.remoteId !== confirmRemoteId) throw new Error('The tracker identity changed since it was confirmed; confirm again');
        const r = await controller('trackers-map', { project: projectId, tracker, auth, site: pinnedSite, remoteId: resolved.remoteId, remoteName: resolved.remoteName, expectedRevision, note, validatedAt: iso(now()) });
        states.delete(projectId);
        return { ok: true, failure: null, message: null, mapping: r.mapping };
      } catch (error) { return refused(error, NO_MAPPING); }
    },
    async unmap({ projectId, expectedRevision, note }) {
      try { const r = await controller('trackers-unmap', { project: projectId, expectedRevision, note }); states.delete(projectId); return { ok: true, failure: null, message: null, mapping: r.mapping }; }
      catch (error) { return refused(error, NO_MAPPING); }
    },
    // A link is recorded only after the item was observed in the mapped repository with the configured
    // credential; the controller then re-checks membership and the mapping revision.
    async link({ projectId, subject, itemRef, expectedMappingRevision }) {
      try {
        const view = await controller('trackers-project', projectId), m = view.mapping;
        if (!m || m.state !== 'mapped' || m.revision !== expectedMappingRevision) throw new Error('Tracker mapping changed; refresh before linking');
        if (!validItemRef(m.tracker, m.remoteName, itemRef)) throw new Error('Invalid tracker item for this mapping');
        await connectors[m.tracker].get(m, itemRef, { observedName: states.get(projectId)?.observedName ?? null });
        const r = await controller('trackers-link', { project: projectId, subject, itemRef, expectedMappingRevision });
        return { ok: true, failure: null, message: null, linkId: r.link.id, revision: r.link.revision };
      } catch (error) { return refused(error, NO_LINK); }
    },
    async unlink({ linkId, expectedRevision }) {
      try { const r = await controller('trackers-unlink', { link: linkId, expectedRevision }); return { ok: true, failure: null, message: null, linkId: r.linkId, revision: r.revision }; }
      catch (error) { return refused(error, NO_LINK); }
    },
  };
}
