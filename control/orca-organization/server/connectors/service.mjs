// Fulcra J4 tracker service (CONTRACTS.md §2.2, §7). Between the plugin RPCs, the connectors and the controller:
//  - which remote is called is always a controller mapping; no RPC input names a repository to read;
//  - refreshes coalesce per mapping (the connector's poll interval, 60 s for GitHub) and back off per ACCOUNT,
//    so one rate-limited or signed-out account pauses every mapping that uses it and nothing else;
//  - observations are persisted in the controller (cc_tracker_items), so a restart shows the last known state,
//    marked stale until the next good read;
//  - provider-reported links and commit provenance are proposed to the controller, which applies precedence;
//  - read-only: no connector operation writes to a tracker.
import { randomUUID } from "node:crypto";
import { TrackerFailure } from "../trackers/http.mjs";
import { credentialAccount, plainText } from "../../shared/tracker-refs.mjs";
import { parseRef } from "../../shared/cc/refs.mjs";
import { chainLinks } from "./provenance.mjs";
import { sanitizeItem, issueRef } from "../../shared/cc/connector-rules.mjs";
export const SCAN_EVERY_MS = 5 * 60000,
  LINK_FETCHES_PER_REFRESH = 10;
const failureOf = (e) => (e instanceof TrackerFailure ? e.failure : "error");
const SIGN_IN = new Set(["auth-required", "rate-limited"]);
const MESSAGE = {
  "auth-required":
    "The account is signed out or its token no longer works. Reconnect it in Settings › Integrations.",
  forbidden: "The account cannot read this repository. Give its token access to it.",
  "not-found": "Not found with this account. Check the name, or give the token access to it.",
  "rate-limited": "The tracker asked Fulcra to slow down. Try again in a few minutes.",
  offline: "The tracker could not be reached. Try again shortly.",
  "invalid-response": "The tracker answered with something unexpected, so nothing was recorded.",
  "needs-host-update": "This needs Fulcra host update P1 (the shared sign-in store).",
  error: "That did not work, and nothing was recorded.",
};
export const messageFor = (failure) => MESSAGE[failure] ?? MESSAGE.error;
// `http(mapping)` gives the connector an account-bound request function (http.mjs), or null when the host cannot.
export function createConnectorService({
  controller,
  registry,
  http,
  hostAccounts = async () => ({ hostApi: false, accounts: [], providers: [] }),
  importLegacy = null,
  scan = null,
  names = async () => ({ sessions: new Map(), tasks: new Map() }),
  now = Date.now,
}) {
  const states = new Map(),
    accounts = new Map(),
    provider = new Map(),
    scans = new Map();
  const iso = (t) => new Date(t).toISOString();
  const accountKey = (m) => m.accountId ?? `cli:${m.connector}`;
  const stateFor = (m) => {
    let s = states.get(m.id);
    if (!s || s.revision !== m.revision) {
      s = {
        revision: m.revision,
        status: "ok",
        retryAt: 0,
        failures: 0,
        lastOk: 0,
        observedAt: null,
        inflight: null,
      };
      states.set(m.id, s);
    }
    return s;
  };
  function fail(s, m, error) {
    const failure = failureOf(error),
      t = now();
    s.failures += 1;
    const retryAt =
      failure === "auth-required"
        ? t + 600000
        : failure === "rate-limited"
          ? t + Math.min(Math.max(Number(error.retryAfterMs) || 60000, 1000), 3600000)
          : failure === "offline"
            ? t + Math.min(600000, 30000 * 2 ** Math.min(s.failures - 1, 5))
            : t + 60000;
    // `detail` carries a host condition the enum cannot say (the sign-in store is not available to this plugin).
    s.retryAt = retryAt;
    s.status = error?.detail === "needs-host-update" ? "needs-host-update" : failure;
    // Sign-in and rate limits belong to the account: every mapping on it waits.
    if (SIGN_IN.has(failure)) accounts.set(accountKey(m), { failure, retryAt });
  }
  // A ticket tracker (Jira) has no repository of its own: its keys are looked for in every repository's text.
  const ticketTracker = (m) => {
    const c = registry.get(m.connector);
    return !!c && typeof c.matchesOrigin !== "function" && typeof c.issueRefsIn === "function";
  };
  async function refresh(m, persisted, siblings = []) {
    const s = stateFor(m),
      t = now(),
      connector = registry.get(m.connector);
    if (!connector) {
      s.status = "error";
      return s;
    }
    const port = http(m);
    if (!port) {
      s.status = "needs-host-update";
      return s;
    }
    if (s.inflight) {
      await s.inflight;
      return s;
    }
    const held = accounts.get(accountKey(m));
    if (held && t < held.retryAt) {
      s.status = held.failure;
      s.retryAt = held.retryAt;
      return s;
    }
    if (t < s.retryAt) return s;
    if (s.status === "ok" && s.lastOk && t - s.lastOk < connector.sync.pollSeconds * 1000) return s;
    s.inflight = (async () => {
      const remote = { remoteId: m.remoteId, remoteName: m.remoteName, site: m.site };
      const r = await connector.listItems(port, {
        remote,
        since: null,
        states: ["open", "closed"],
      });
      const observedAt = iso(now());
      // R-E-2: provider text is made safe (or the item withheld) before it is kept; anything withheld makes the
      // observation partial. R-E-5: one observation per refresh, written in chunks; the controller reconciles only
      // after a complete one, so a partial read never removes (or freshens) items it did not see.
      let withheld = false;
      const items = r.items.flatMap((it) => {
        const x = sanitizeItem(it);
        withheld ||= x.withheld;
        return x.item ? [x.item] : [];
      });
      const observation = { id: randomUUID(), partial: !!r.partial || withheld };
      let partialStored = false;
      for (let i = 0; i === 0 || i < items.length; i += 200) {
        const put = await controller("cc-tracker-items-put", {
          mappingId: m.id,
          observedAt,
          items: items.slice(i, i + 200),
          observation: { ...observation, final: i + 200 >= items.length },
        });
        partialStored ||= !!put?.partial;
      }
      accounts.delete(accountKey(m));
      s.status = "ok";
      s.failures = 0;
      s.retryAt = 0;
      s.lastOk = now();
      s.observedAt = observedAt;
      s.partial = observation.partial || partialStored;
      // Provider links only for items that changed since they were last seen, a few per refresh.
      const before = new Map(
        persisted.filter((p) => p.mappingId === m.id).map((p) => [p.item.key, p.item.updatedAt]),
      );
      const changed = items
        .filter((it) => before.get(it.key) !== it.updatedAt || !provider.has(it.key))
        .slice(0, LINK_FETCHES_PER_REFRESH);
      const proposed = [];
      // Ticket keys in a changed pull request's title or source branch (§2.2 inferred, medium): it fixes that ticket
      // of a Jira project mapped to the same project, or (R-E-8) an issue of its OWN repository named by that
      // connector's own pattern (`#n`). Reported closing references stay separate (reported, high).
      const tickets = [
        m,
        ...siblings.filter((o) => o.id !== m.id && o.state === "mapped" && ticketTracker(o)),
      ];
      for (const it of items.filter((i) => i.kind === "pr" && before.get(i.key) !== i.updatedAt)) {
        const words = typeof r.texts?.[it.key] === "string" ? r.texts[it.key] : it.title;
        for (const o of tickets)
          for (const ticket of registry.get(o.connector)?.issueRefsIn?.(o, words) ?? []) {
            proposed.push({
              from: it.key,
              relation: "fixes",
              to: ticket,
              provenance: "inferred",
              confidence: "medium",
              evidence:
                o === m
                  ? "The pull request title or branch names this issue."
                  : "The pull request title or branch names this ticket.",
            });
          }
      }
      for (const it of changed) {
        try {
          const found = await connector.listLinksForItem(port, {
            remote,
            ref: it.ref,
            kind: it.kind,
          });
          provider.set(it.key, found);
          for (const pr of found.prs)
            proposed.push({
              from: pr,
              relation: "fixes",
              to: it.key,
              provenance: "reported",
              confidence: "high",
              evidence: connector.reportedEvidence ?? "The pull request says it fixes this issue.",
            });
        } catch {
          /* the item still shows; its links wait for the next change */
        }
      }
      if (proposed.length)
        await controller("cc-links-observe", {
          messageId: randomUUID(),
          links: proposed.slice(0, 500),
        });
    })()
      .catch((error) => fail(s, m, error))
      .finally(() => {
        s.inflight = null;
      });
    await s.inflight;
    return s;
  }
  // Commit provenance for one project, at most every few minutes, joined with the provider's commit lists.
  function scanProject(projectId) {
    const prior = scans.get(projectId);
    if (!scan || (prior && (prior.running || now() - prior.at < SCAN_EVERY_MS)))
      return prior?.running ?? Promise.resolve(null);
    const entry = { at: now(), running: null };
    entry.running = (async () => {
      const mappings = (await controller("cc-tracker-mappings", { projectId })).mappings.filter(
        (m) => m.state === "mapped",
      );
      const r = await scan(projectId, mappings);
      if (!r) return null;
      const chained = [...provider.entries()].flatMap(([key, found]) =>
        chainLinks(key, found.commits, r.producersByCommit),
      );
      const all = [...r.links, ...chained];
      for (let i = 0; i < all.length; i += 500)
        await controller("cc-links-observe", {
          messageId: randomUUID(),
          links: all.slice(i, i + 500),
        });
      return { proposed: all.length, repositories: r.repositories };
    })()
      .catch(() => null)
      .finally(() => {
        entry.running = null;
      });
    scans.set(projectId, entry);
    return entry.running;
  }
  // One-time copy of J3's single mapping per project. A keychain token moves into a host account through
  // J5b's importLegacy; without that host update the J3 mapping keeps working and the copy waits.
  let migrating = null;
  function migrate() {
    migrating ??= (async () => {
      const { pending } = await controller("cc-tracker-legacy-pending");
      for (const p of pending) {
        try {
          let accountId = null;
          if (p.auth !== "gh-cli") {
            if (!importLegacy) continue;
            accountId = (
              await importLegacy({
                secretName: credentialAccount(p.tracker, p.site),
                connector: p.tracker,
                site: p.tracker === "jira" ? p.site : null,
              })
            ).accountId;
          }
          await controller("cc-tracker-import-legacy", {
            messageId: randomUUID(),
            projectId: p.projectId,
            accountId,
          });
        } catch {
          /* stays pending; the J3 mapping keeps working */
        }
      }
    })().finally(() => {
      setTimeout(() => {
        migrating = null;
      }, 60000).unref?.();
    });
    return migrating;
  }
  const trackerLabel = (c) => registry.get(c)?.label ?? c;
  // R-E-1: the site a mapping reads is the selected account's own (host account metadata), for every connector. The
  // host sends that account's requests only to that site, so a different site typed by the caller is refused rather
  // than stored as a label on the account's data. The command-line login is GitHub's, with no site.
  const norm = (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);
  async function siteFor(connector, accountId, supplied) {
    if (accountId === null) {
      if (norm(supplied) !== null)
        throw new Error("The command-line login reads github.com only; it has no site");
      return null;
    }
    const host = await hostAccounts().catch(() => ({ hostApi: false, accounts: [] }));
    if (!host.hostApi)
      throw Object.assign(new TrackerFailure("error"), { detail: "needs-host-update" });
    const account = (host.accounts ?? []).find(
      (x) => x.id === accountId && x.connector === connector.id,
    );
    if (!account) throw new Error(`Choose a connected ${connector.label} account`);
    if (account.state !== "connected")
      throw new Error("That account needs reconnecting in Settings › Integrations");
    const site = norm(account.site);
    if (norm(supplied) !== null && norm(supplied) !== site)
      throw new Error(
        site
          ? `That account reads ${site}, not the site given; nothing was checked`
          : `That account has no site; nothing was checked`,
      );
    return site;
  }
  // R-E-4: J3's active hand-made links (tracker_links), adapted to the §2.2 shape on the issue's new ref. The old rows
  // are not changed. Precedence: any cc_links row for the same (from, relation, to), including a removal, wins;
  // otherwise the earlier link shows as manual. Removing one goes through J3's own unlink (linkRemove below).
  async function legacyLinks(projectId, current) {
    let project;
    try {
      project = await controller("trackers-project", projectId);
    } catch {
      return [];
    }
    const seen = new Set(current.map((l) => `${l.from}|${l.relation}|${l.to}`)),
      out = [];
    for (const l of project?.links ?? []) {
      let from;
      try {
        const remoteId =
          l.tracker === "bitbucket"
            ? String(l.remoteId)
                .replace(/^\{|\}$/g, "")
                .toLowerCase()
            : l.remoteId;
        const site = l.tracker === "jira" ? l.site : null;
        from = issueRef(l.tracker, site, remoteId, String(l.itemRef).replace(/^#/, ""));
      } catch {
        continue;
      }
      const to = `${l.subject.kind}:${l.subject.id}`;
      if (seen.has(`${from}|worked-by|${to}`)) continue;
      out.push({
        id: l.id,
        from,
        to,
        relation: "worked-by",
        provenance: "manual",
        confidence: "high",
        evidence: "Linked by hand in the earlier set-up.",
        state: "active",
        revision: l.revision,
        createdAt: l.createdAt,
        at: l.at,
        by: "operator",
      });
    }
    return out;
  }
  async function view({ projectId }, { persist = true } = {}) {
    if (persist) await migrate().catch(() => {});
    const mappings = (await controller("cc-tracker-mappings", { projectId })).mappings.filter(
      (m) => m.state === "mapped",
    );
    let persisted = (await controller("cc-tracker-items", { projectId })).items;
    const trackers = [];
    let partial = false;
    for (const m of mappings) {
      // L36: a read reports what the last refresh in this process found for this mapping (same revision), not a blanket
      // 'stale'; only a mapping never refreshed here is 'stale'. Reads never fetch.
      const known = states.get(m.id),
        seen =
          known &&
          known.revision === m.revision &&
          (known.lastOk || known.failures) &&
          !known.inflight;
      const s = persist
        ? await refresh(m, persisted, mappings)
        : seen
          ? known
          : { status: "stale", retryAt: 0, observedAt: null, partial: true };
      const bad = s.status !== "ok";
      partial ||= bad || !!s.partial;
      trackers.push({
        mappingId: m.id,
        connector: m.connector,
        label: trackerLabel(m.connector),
        remoteName: m.remoteName,
        commandLine: m.accountId === null,
        status:
          bad &&
          persisted.some((p) => p.mappingId === m.id) &&
          (s.status === "offline" || s.status === "error")
            ? "stale"
            : s.status,
        retryAt: s.retryAt > now() ? iso(s.retryAt) : null,
        observedAt: s.observedAt ?? persisted.find((p) => p.mappingId === m.id)?.observedAt ?? null,
      });
    }
    if (persist) await scanProject(projectId);
    persisted = (await controller("cc-tracker-items", { projectId })).items.slice(0, 200);
    const fresh = new Map(trackers.map((t) => [t.mappingId, t.status === "ok"]));
    const byKey = new Map(persisted.map((p) => [p.item.key, p.item]));
    const keys = persisted.map((p) => p.item.key);
    const links = [];
    // R-E-9: removed links come too (their revision is what re-adding one by hand must name); trails use active only.
    for (let i = 0; i < keys.length; i += 64)
      links.push(
        ...(await controller("cc-links-for", { refs: keys.slice(i, i + 64), includeRemoved: true }))
          .links,
      );
    // R-E-4 (§2.2 backward compatibility): links made by hand in the earlier set-up are shown alongside, never migrated.
    links.push(...(await legacyLinks(projectId, links)));
    const prRefs = [
      ...new Set(
        links.filter((l) => l.relation === "fixes" && !byKey.has(l.from)).map((l) => l.from),
      ),
    ].slice(0, 64);
    if (prRefs.length)
      links.push(
        ...(await controller("cc-links-for", { refs: prRefs })).links.filter(
          (l) => l.relation === "worked-by",
        ),
      );
    const who = await names().catch(() => ({ sessions: new Map(), tasks: new Map() }));
    // R-E-5: an item is current only if its tracker answered AND the latest refresh actually saw it.
    const items = persisted.map((p) => ({
      item: p.item,
      stale: !fresh.get(p.mappingId) || p.current === false,
      observedAt: p.observedAt,
      links: dedupe(links.filter((l) => l.from === p.item.key || l.to === p.item.key)).slice(0, 16),
      trail: trail(p.item, links, byKey, who),
    }));
    return { version: 1, observedAt: iso(now()), partial, trackers, items };
  }
  return {
    view,
    refresh,
    scanProject,
    migrate,
    async integrations() {
      const host = await hostAccounts().catch(() => ({
        hostApi: false,
        accounts: [],
        providers: [],
      }));
      const methods = new Map((host.providers ?? []).map((p) => [p.connector, p.methods ?? []]));
      return {
        version: 1,
        observedAt: iso(now()),
        partial: !host.hostApi,
        hostApi: !!host.hostApi,
        connectors: registry.describe(methods).filter((c) => !c.selfHosted || c.auth.length),
        accounts: (host.accounts ?? []).slice(0, 64),
      };
    },
    async mappings({ projectId }, { persist = true } = {}) {
      if (persist) await migrate().catch(() => {});
      const [list, legacy, pending] = await Promise.all([
        controller("cc-tracker-mappings", { projectId }),
        controller("trackers-project", projectId).catch(() => null),
        controller("cc-tracker-legacy-pending"),
      ]);
      const old = legacy?.mapping?.state === "mapped" ? legacy.mapping : null;
      return {
        version: 1,
        observedAt: iso(now()),
        partial: false,
        mappings: list.mappings.slice(0, 32),
        legacy: old
          ? {
              connector: old.tracker,
              remoteName: old.remoteName,
              commandLine: old.auth === "gh-cli",
              copied: !pending.pending.some((p) => p.projectId === projectId),
            }
          : null,
      };
    },
    async resolve({ connector: id, accountId, remoteName, site }) {
      try {
        const connector = registry.get(id);
        if (!connector) throw new Error("Unknown tracker");
        if (accountId === null && !connector.auth.includes("cli"))
          throw new Error(`${connector.label} needs a connected account`);
        const accountSite = await siteFor(connector, accountId, site);
        const port = http({ connector: id, accountId });
        if (!port)
          throw Object.assign(new TrackerFailure("error"), { detail: "needs-host-update" });
        const remote = await connector.resolveRemote(port, { remoteName, site: accountSite });
        // The identity checked, confirmed and stored is the account's: never a site the caller typed.
        return { ok: true, message: null, remote: { ...remote, site: accountSite } };
      } catch (error) {
        return { ok: false, message: refusal(error), remote: null };
      }
    },
    async map({
      messageId,
      projectId,
      connector,
      accountId,
      remoteName,
      site,
      confirmRemoteId,
      expectedRevision,
      note,
    }) {
      const checked = await this.resolve({ connector, accountId, remoteName, site });
      if (!checked.ok) return { ok: false, message: checked.message, mapping: null };
      if (checked.remote.remoteId !== confirmRemoteId)
        return {
          ok: false,
          message: "The tracker changed since you checked it; check it again.",
          mapping: null,
        };
      try {
        const r = await controller("cc-tracker-map", {
          messageId,
          projectId,
          connector,
          accountId,
          remoteId: checked.remote.remoteId,
          remoteName: checked.remote.remoteName,
          site: checked.remote.site,
          note,
          expectedRevision,
        });
        return { ok: true, message: null, mapping: r.mapping };
      } catch (error) {
        return { ok: false, message: refusal(error), mapping: null };
      }
    },
    async unmap(input) {
      try {
        const r = await controller("cc-tracker-unmap", input);
        states.delete(input.id);
        return { ok: true, message: null, mapping: r.mapping };
      } catch (error) {
        return { ok: false, message: refusal(error), mapping: null };
      }
    },
    async linkSet(input) {
      try {
        return { ok: true, message: null, link: (await controller("cc-links-set", input)).link };
      } catch (error) {
        return { ok: false, message: refusal(error), link: null };
      }
    },
    async linkRemove(input) {
      try {
        return { ok: true, message: null, link: (await controller("cc-links-remove", input)).link };
      } catch (error) {
        // R-E-4: not a §2.2 link, so a link from the earlier set-up: corrected with J3's own unlink, which keeps its row
        // and history. Its revision is the one the view showed.
        if (!/does not exist/.test(String(error?.message)))
          return { ok: false, message: refusal(error), link: null };
        try {
          await controller("trackers-unlink", {
            link: input.id,
            expectedRevision: input.expectedRevision,
          });
          return { ok: true, message: null, link: null };
        } catch (legacyError) {
          return { ok: false, message: refusal(legacyError), link: null };
        }
      }
    },
    async links({ refs }) {
      const r = await controller("cc-links-for", { refs });
      return { version: 1, observedAt: iso(now()), partial: false, links: r.links };
    },
  };
}
// Controller refusals are its own fixed sentences; tracker failures are the enum, said plainly.
function refusal(error) {
  if (error instanceof TrackerFailure) return messageFor(error.detail ?? error.failure);
  const text = String(error?.message ?? "");
  return text && text.length <= 300 && !/[/\\]|at .*:\d+/.test(text) ? text : messageFor("error");
}
function dedupe(links) {
  const seen = new Set();
  return links.filter((l) => !seen.has(l.id) && seen.add(l.id));
}
const PR_STATE = { merged: "merged", closed: "closed without merging", open: "still open" };
// "#42 → fixed in PR #17 → by session 'J4 Tracking' → merged 13:10". Refs travel with each step; labels are
// plain words. A pull request's own trail starts at its workers.
export function trail(item, links, byKey, who) {
  const steps = [],
    active = links.filter((l) => l.state === "active");
  const workers = (key) =>
    active
      .filter((l) => l.from === key && l.relation === "worked-by")
      .slice(0, 2)
      .map((l) => {
        const r = parseRef(l.to),
          kind = r?.kind === "task" ? "task" : "session";
        const name = kind === "task" ? who.tasks.get(r?.id) : who.sessions.get(r?.id);
        const shown = plainText(name ?? "", 60);
        return {
          kind,
          ref: l.to,
          label: shown ? `by ${kind} '${shown}'` : `by a ${kind}`,
          at: null,
          provenance: l.provenance,
          confidence: l.confidence,
        };
      });
  if (item.kind === "pr") {
    steps.push(...workers(item.key));
    // A pull request with nobody linked has no trail yet; its state is already on the row.
    if (steps.length && item.state !== "unknown")
      steps.push({
        kind: "state",
        ref: null,
        label: PR_STATE[item.state] ?? item.state,
        at: item.state === "merged" ? item.updatedAt : null,
        provenance: null,
        confidence: null,
      });
    return steps.slice(0, 8);
  }
  const fixes = active.filter((l) => l.to === item.key && l.relation === "fixes").slice(0, 2);
  for (const l of fixes) {
    const pr = byKey.get(l.from),
      number = /#(\d+)$/.exec(l.from)?.[1];
    steps.push({
      kind: "pr",
      ref: l.from,
      label: `fixed in PR #${number}`,
      at: null,
      provenance: l.provenance,
      confidence: l.confidence,
    });
    steps.push(...workers(l.from));
    if (pr && pr.state !== "unknown")
      steps.push({
        kind: "state",
        ref: null,
        label: PR_STATE[pr.state] ?? pr.state,
        at: pr.state === "merged" ? pr.updatedAt : null,
        provenance: null,
        confidence: null,
      });
  }
  if (!fixes.length)
    steps.push(
      ...workers(item.key).map((s) => ({ ...s, label: s.label.replace(/^by /, "worked on by ") })),
    );
  return steps.slice(0, 8);
}
