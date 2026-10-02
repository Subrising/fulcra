// J3 Bitbucket Cloud connector (J3-DESIGN.md §7 phase B). Read-only: GET only against api.bitbucket.org,
// with the repository addressed by its UUID after the one name-addressed resolve(). A repository whose
// issue tracker is disabled is refused at mapping time (map it to Jira instead). The keychain value is
// "email:api-token" (Basic) or a repository access token (Bearer); it is read per request and never kept.
import { getJson, TrackerFailure } from "./http.mjs";
import {
  credentialAccount,
  plainText,
  validItemRef,
  validRemoteName,
} from "../../shared/tracker-refs.mjs";
import { authorization } from "./jira.mjs";
const API = "https://api.bitbucket.org/2.0";
const OPEN = new Set(["new", "open", "on hold"]),
  CLOSED = new Set(["resolved", "closed", "invalid", "duplicate", "wontfix"]);
const iso = (v) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
const nameOf = (json) => `${json?.workspace?.slug}/${json?.slug}`;
function item(raw, mapping) {
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.repository?.uuid !== mapping.remoteId ||
    !Number.isSafeInteger(raw.id) ||
    !validItemRef("bitbucket", mapping.remoteName, String(raw.id))
  )
    return null;
  return {
    ref: String(raw.id),
    title: plainText(raw.title, 256) ?? "",
    state: OPEN.has(raw.state) ? "open" : CLOSED.has(raw.state) ? "closed" : "unknown",
    labels: [raw.kind, raw.priority].map((l) => plainText(l, 50)).filter(Boolean),
    updatedAt: iso(raw.updated_on),
  };
}
export function createBitbucketConnector({ fetcher, secrets }) {
  async function call(path, etag = null) {
    let value;
    try {
      value = await secrets.read(credentialAccount("bitbucket", "bitbucket.org"));
    } catch {
      throw new TrackerFailure("auth-required");
    }
    if (typeof value !== "string" || !value) throw new TrackerFailure("auth-required");
    return getJson({
      fetcher,
      url: API + path,
      etag,
      headers: {
        Accept: "application/json",
        "User-Agent": "fulcra-orca-trackers",
        Authorization: authorization(value),
      },
    });
  }
  const base = (mapping) =>
    `/repositories/${encodeURIComponent(mapping.remoteName.split("/")[0])}/${encodeURIComponent(mapping.remoteId)}`;
  return {
    tracker: "bitbucket",
    async resolve({ remoteName }) {
      const [workspace, slug] = remoteName.split("/");
      const r = await call(
        `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`,
      );
      if (
        typeof r.json?.uuid !== "string" ||
        nameOf(r.json) !== remoteName ||
        !validRemoteName("bitbucket", nameOf(r.json))
      )
        throw new TrackerFailure("invalid-response");
      if (r.json.has_issues !== true) throw new TrackerFailure("not-found");
      return { remoteId: r.json.uuid, remoteName: nameOf(r.json) };
    },
    async validate(mapping) {
      const r = await call(base(mapping));
      if (r.json?.uuid !== mapping.remoteId) throw new TrackerFailure("invalid-response");
      return { remoteName: nameOf(r.json) };
    },
    async listOpen(mapping, { etag = null } = {}) {
      const query = new URLSearchParams({
        q: 'state="new" OR state="open" OR state="on hold"',
        sort: "-updated_on",
        pagelen: "50",
      });
      const r = await call(`${base(mapping)}/issues?${query}`, etag);
      if (r.status === 304) return { notModified: true };
      if (!Array.isArray(r.json?.values)) throw new TrackerFailure("invalid-response");
      let partial = false;
      const items = [];
      for (const raw of r.json.values.slice(0, 50)) {
        const it = item(raw, mapping);
        if (it) items.push(it);
        else partial = true;
      }
      return { items, partial, etag: r.etag ?? null };
    },
    async get(mapping, itemRef) {
      if (!validItemRef("bitbucket", mapping.remoteName, itemRef))
        throw new TrackerFailure("error");
      const r = await call(`${base(mapping)}/issues/${itemRef}`);
      const it = item(r.json, mapping);
      if (!it || it.ref !== itemRef) throw new TrackerFailure("invalid-response");
      return it;
    },
  };
}
