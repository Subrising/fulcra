// Fulcra J4b Jira connectors (CONTRACTS.md §7.1): "jira" (Jira Cloud, email + API token) and "jira-dc" (Jira Data
// Center, site + personal access token). Read-only by construction: every request is a GET through the `http` it is
// handed (http.mjs), the host's credential request for one account, which adds authentication itself and reaches
// only that account's site. This module never sees a token, an email or an Authorization header.
//
// A project is pinned by its numeric id after the one key-addressed resolve; every JQL is built here from that id,
// and every ticket must say it belongs to that project. Provider-reported links come from Jira's development panel
// (`/rest/dev-status/…`, CONTRACTS v1.10). A host that does not allow those paths yet, or a Jira without the panel,
// gives no reported links; ticket keys in commit messages, branches and pull-request titles still link (inferred).
import { TrackerFailure } from "../trackers/http.mjs";
import { plainText } from "../../shared/tracker-refs.mjs";
import { issueRef, HOSTNAME } from "../../shared/cc/connector-rules.mjs";
import { prRefFromUrl, commitRefFromUrl } from "./web-refs.mjs";
export const CLOSED_WINDOW_DAYS = 30;
const PAGE = 100,
  MAX_ITEMS = 200;
const FIELDS = "summary,status,labels,updated,project,assignee";
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/,
  PROJECT_ID = /^[1-9][0-9]{0,11}$/,
  TICKET = /^([A-Z][A-Z0-9_]{0,19})-([1-9][0-9]{0,9})$/;
// The development-panel sources Fulcra can turn into refs (web-refs.mjs): GitHub, Bitbucket Cloud and Data Center.
const DEV_TYPES = new Set(["GitHub", "bitbucket", "stash"]);
// The only paths this connector requests. Query strings travel separately, built below from validated values.
const PATH =
  /^\/rest\/(?:api\/[23]\/(?:myself|search|search\/jql|project\/(?:[A-Z][A-Z0-9_]{0,19}|[1-9][0-9]{0,11})|issue\/[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9})|dev-status\/latest\/issue\/(?:summary|detail))$/;
const iso = (v) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
const STATE = { new: "open", indeterminate: "in-progress", done: "closed" };
export function jql(projectId, states = ["open", "closed"]) {
  if (!PROJECT_ID.test(projectId)) throw new TrackerFailure("error");
  const recent = states.includes("closed") ? ` OR updated >= -${CLOSED_WINDOW_DAYS}d` : "";
  return `project = ${projectId} AND (statusCategory != Done${recent}) ORDER BY updated DESC`;
}
export function createJiraConnector({ id = "jira" } = {}) {
  if (id !== "jira" && id !== "jira-dc") throw new Error("Unknown Jira connector");
  const dc = id === "jira-dc",
    v = dc ? "2" : "3";
  async function call(http, path, query = {}) {
    if (!PATH.test(path)) throw new TrackerFailure("error");
    if (!http || typeof http.get !== "function") throw new TrackerFailure("auth-required");
    return http.get(path, query, { Accept: "application/json" });
  }
  const siteOf = (remote) => {
    const s = typeof remote?.site === "string" ? remote.site.toLowerCase() : "";
    if (!HOSTNAME.test(s)) throw new TrackerFailure("error");
    return s;
  };
  // One search or issue row as a §7.1 item, only if it is in the pinned project.
  function item(raw, remote) {
    const m = TICKET.exec(raw?.key ?? "");
    if (!m || String(raw.fields?.project?.id ?? "") !== remote.remoteId) return null;
    const updatedAt = iso(raw.fields?.updated);
    if (!updatedAt) return null;
    const site = siteOf(remote);
    return {
      key: issueRef(id, site, remote.remoteId, raw.key),
      connector: id,
      kind: "ticket",
      ref: raw.key,
      title: plainText(raw.fields?.summary, 256) ?? "",
      state: STATE[raw.fields?.status?.statusCategory?.key] ?? "unknown",
      url: `https://${site}/browse/${raw.key}`,
      updatedAt,
      assignee: plainText(raw.fields?.assignee?.displayName, 80) || null,
      labels: (Array.isArray(raw.fields?.labels) ? raw.fields.labels : [])
        .map((l) => plainText(l, 50))
        .filter(Boolean)
        .slice(0, 8),
    };
  }
  const ticketOf = (ref) => {
    if (!TICKET.test(ref ?? "")) throw new TrackerFailure("error");
    return ref;
  };
  return {
    id,
    label: dc ? "Jira Data Center" : "Jira",
    kinds: ["ticket"],
    selfHosted: dc,
    // §7.1 v1: Jira Cloud browser sign-in, then an API token; Data Center a personal access token. Browser sign-in
    // needs a broker (J5b), so the registry shows it only when the host reports it available.
    auth: dc ? ["token"] : ["browser", "token"],
    tokenHelp: dc
      ? {
          createUrl:
            "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html",
          scopes: ["Browse projects (for the projects you track)"],
          note: "In Jira open your profile, then Personal Access Tokens, and create one. It reads what your Jira user can read. Fulcra never writes to Jira.",
        }
      : {
          createUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
          scopes: ["read:jira-work", "read:jira-user"],
          note: "Create an API token (with scopes, choose Jira and these read scopes). Fulcra sends it with the email address of your Atlassian account and never writes to Jira.",
        },
    keyPatterns: ["[A-Z][A-Z0-9]+-\\d+"],
    sync: { pollSeconds: 120, webhook: false },
    reportedEvidence: "Jira's development panel lists this pull request for the ticket.",
    // Operator confirmation: what Jira says this project key is. The one key-addressed call.
    async resolveRemote(http, { remoteName, site }) {
      const key = typeof remoteName === "string" ? remoteName.trim().toUpperCase() : "";
      const host = typeof site === "string" ? site.trim().toLowerCase() : "";
      if (!PROJECT_KEY.test(key)) throw new TrackerFailure("not-found");
      if (!HOSTNAME.test(host)) throw new TrackerFailure("error");
      const r = await call(http, `/rest/api/${v}/project/${key}`);
      if (typeof r?.id !== "string" || !PROJECT_ID.test(r.id) || r.key !== key)
        throw new TrackerFailure("invalid-response");
      return { remoteId: r.id, remoteName: r.key, site: host };
    },
    // Open and in-progress tickets, plus tickets finished in the last 30 days, newest first, up to 200.
    async listItems(http, { remote, states = ["open", "closed"] }) {
      siteOf(remote);
      const pages = [],
        base = { jql: jql(remote.remoteId, states), maxResults: String(PAGE), fields: FIELDS };
      let more = false;
      if (dc) {
        for (let startAt = 0; startAt < MAX_ITEMS; startAt += PAGE) {
          const r = await call(http, "/rest/api/2/search", { ...base, startAt: String(startAt) });
          if (!Array.isArray(r?.issues)) throw new TrackerFailure("invalid-response");
          pages.push(r.issues);
          more = Number.isSafeInteger(r.total) && r.total > startAt + r.issues.length;
          if (!more || r.issues.length < PAGE) break;
        }
      } else {
        let token = null;
        do {
          const r = await call(
            http,
            "/rest/api/3/search/jql",
            token ? { ...base, nextPageToken: token } : base,
          );
          if (!Array.isArray(r?.issues)) throw new TrackerFailure("invalid-response");
          pages.push(r.issues);
          token =
            r.isLast === false &&
            typeof r.nextPageToken === "string" &&
            r.nextPageToken.length <= 512
              ? r.nextPageToken
              : null;
          more = !!token;
        } while (token && pages.flat().length < MAX_ITEMS);
      }
      let partial = more;
      const items = new Map();
      for (const raw of pages.flat()) {
        const it = item(raw, remote);
        if (!it) {
          partial = true;
          continue;
        }
        items.set(it.key, it);
      }
      return { items: [...items.values()].slice(0, MAX_ITEMS), cursor: null, partial };
    },
    async getItem(http, { remote, ref }) {
      const key = ticketOf(ref),
        it = item(await call(http, `/rest/api/${v}/issue/${key}`, { fields: FIELDS }), remote);
      if (!it || it.ref !== key) throw new TrackerFailure("invalid-response");
      return it;
    },
    // Jira's development panel: the pull requests and commits the linked repositories report for this ticket.
    // The panel needs the ticket's numeric id, so the ticket is read first (and must still be in this project).
    async listLinksForItem(http, { remote, ref }) {
      const key = ticketOf(ref),
        raw = await call(http, `/rest/api/${v}/issue/${key}`, { fields: "project" });
      if (
        String(raw?.fields?.project?.id ?? "") !== remote.remoteId ||
        !/^[1-9][0-9]{0,11}$/.test(String(raw?.id ?? ""))
      )
        throw new TrackerFailure("invalid-response");
      const issueId = String(raw.id),
        prs = new Set(),
        commits = new Set();
      let summary;
      try {
        summary = await call(http, "/rest/dev-status/latest/issue/summary", { issueId });
      } catch (error) {
        // Not allowed by this host yet (a `forbidden` path refusal), or no development panel on this Jira: no reported
        // links, not a failure.
        if (
          error instanceof TrackerFailure &&
          (error.failure === "not-found" || error.failure === "forbidden")
        )
          return { commits: [], prs: [], reported: false };
        throw error;
      }
      const types = (dataType) =>
        Object.keys(summary?.summary?.[dataType]?.byInstanceType ?? {}).filter((t) =>
          DEV_TYPES.has(t),
        );
      for (const applicationType of types("pullrequest")) {
        const r = await call(http, "/rest/dev-status/latest/issue/detail", {
          issueId,
          applicationType,
          dataType: "pullrequest",
        });
        for (const d of Array.isArray(r?.detail) ? r.detail : []) {
          for (const pr of Array.isArray(d?.pullRequests) ? d.pullRequests : []) {
            const p = prRefFromUrl(pr?.url);
            if (p) prs.add(p);
          }
        }
      }
      for (const applicationType of types("repository")) {
        const r = await call(http, "/rest/dev-status/latest/issue/detail", {
          issueId,
          applicationType,
          dataType: "repository",
        });
        for (const d of Array.isArray(r?.detail) ? r.detail : []) {
          for (const repo of Array.isArray(d?.repositories) ? d.repositories : []) {
            for (const c of Array.isArray(repo?.commits) ? repo.commits : []) {
              const ref = commitRefFromUrl(repo?.url, c?.id);
              if (ref) commits.add(ref);
            }
          }
        }
      }
      return { commits: [...commits].slice(0, 100), prs: [...prs].slice(0, 100), reported: true };
    },
    async health(http) {
      try {
        await call(http, `/rest/api/${v}/myself`);
        return { state: "ok", retryAt: null };
      } catch (error) {
        const f = error instanceof TrackerFailure ? error.failure : "error";
        const state =
          f === "auth-required" || f === "forbidden" || f === "rate-limited" || f === "offline"
            ? f
            : "offline";
        return {
          state,
          retryAt:
            f === "rate-limited" && error.retryAfterMs
              ? new Date(Date.now() + error.retryAfterMs).toISOString()
              : null,
        };
      }
    },
    // Ticket keys of THIS project in commit subjects, branch names and pull-request titles (§2.2 inferred, medium).
    // A Jira project has no repository, so these apply to every repository of the project (provenance.mjs).
    issueRefsIn(remote, text) {
      if (typeof text !== "string" || !PROJECT_KEY.test(remote?.remoteName ?? "")) return [];
      const site = siteOf(remote),
        out = new Set();
      for (const m of text.matchAll(
        /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{0,19})-([1-9][0-9]{0,9})(?![0-9])/g,
      )) {
        if (m[1] === remote.remoteName)
          out.add(issueRef(id, site, remote.remoteId, `${m[1]}-${m[2]}`));
        if (out.size >= 8) break;
      }
      return [...out];
    },
  };
}
