// J3 GitHub connector (J3-DESIGN.md §3.3). Read-only by construction: GET only, addressed by the numeric
// repository id pinned in the journal mapping. The one name-addressed call is resolve(), used once when the
// operator maps a project, to learn that id. The credential is read from the keychain for each request, put
// only into that request's Authorization header, and never kept. In gh-cli mode gh reads its own login and
// the token never enters this process; the argv is a fixed template asserted before every spawn.
import { getJson, TrackerFailure } from "./http.mjs";
import { credentialAccount, plainText, validItemRef } from "../../shared/tracker-refs.mjs";
const API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const LIST = "state=open&per_page=50&sort=updated";
const GH_PATH = new RegExp(
  `^(?:repositories/[1-9][0-9]{0,11}(?:/issues(?:/[1-9][0-9]{0,9}|\\?${LIST.replace(/[?&]/g, (m) => "\\" + m)})?)?|repos/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100})$`,
);
export function ghArgs(path) {
  return ["api", "--method", "GET", "-H", `Accept: ${ACCEPT}`, path];
}
// gh switches to POST as soon as a field (-f/-F/--field/--raw-field/--input) is added, so the argv is
// compared against the one template, element by element, rather than scanned for bad flags.
export function assertGhArgs(args) {
  const ok =
    Array.isArray(args) &&
    args.length === 6 &&
    args[0] === "api" &&
    args[1] === "--method" &&
    args[2] === "GET" &&
    args[3] === "-H" &&
    args[4] === `Accept: ${ACCEPT}` &&
    typeof args[5] === "string" &&
    GH_PATH.test(args[5]);
  if (!ok) throw new TrackerFailure("error");
  return args;
}
const state = (s) => (s === "open" ? "open" : s === "closed" ? "closed" : "unknown");
const iso = (v) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
function item(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Number.isSafeInteger(raw.number) ||
    !validItemRef("github", "x/y", String(raw.number))
  )
    return null;
  return {
    ref: String(raw.number),
    title: plainText(raw.title, 256) ?? "",
    state: state(raw.state),
    labels: (Array.isArray(raw.labels) ? raw.labels : [])
      .map((l) => plainText(typeof l === "string" ? l : l?.name, 50))
      .filter(Boolean)
      .slice(0, 8),
    updatedAt: iso(raw.updated_at),
  };
}
// An item must say it belongs to the pinned repository. Anything else is dropped and the read is partial.
function pinned(raw, mapping, observedName) {
  const url = typeof raw?.repository_url === "string" ? raw.repository_url.toLowerCase() : "";
  return (
    url === `${API}/repositories/${mapping.remoteId}` ||
    url === `${API}/repos/${(observedName ?? mapping.remoteName).toLowerCase()}`
  );
}
export function createGithubConnector({ fetcher, secrets, gh }) {
  async function call(mapping, path, etag = null) {
    if (mapping.auth === "gh-cli") {
      const stdout = await gh(assertGhArgs(ghArgs(path.slice(1))));
      if (typeof stdout !== "string" || stdout.length > 1048576)
        throw new TrackerFailure("invalid-response");
      try {
        return { status: 200, json: JSON.parse(stdout), etag: null };
      } catch {
        throw new TrackerFailure("invalid-response");
      }
    }
    if (mapping.auth !== "keychain") throw new TrackerFailure("error");
    let token;
    try {
      token = await secrets.read(credentialAccount("github", mapping.site));
    } catch {
      throw new TrackerFailure("auth-required");
    }
    if (typeof token !== "string" || !token) throw new TrackerFailure("auth-required");
    return getJson({
      fetcher,
      url: API + path,
      etag,
      headers: {
        Accept: ACCEPT,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fulcra-orca-trackers",
        Authorization: `Bearer ${token}`,
      },
    });
  }
  return {
    tracker: "github",
    async resolve({ auth, site, remoteName }) {
      const [owner, name] = remoteName.split("/");
      const r = await call(
        { auth, site },
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      );
      if (
        !Number.isSafeInteger(r.json?.id) ||
        r.json.id < 1 ||
        typeof r.json.full_name !== "string" ||
        r.json.full_name.toLowerCase() !== remoteName.toLowerCase()
      )
        throw new TrackerFailure("invalid-response");
      if (r.json.has_issues === false) throw new TrackerFailure("not-found");
      return { remoteId: String(r.json.id), remoteName: r.json.full_name };
    },
    async validate(mapping) {
      const r = await call(mapping, `/repositories/${mapping.remoteId}`);
      if (String(r.json?.id) !== mapping.remoteId || typeof r.json.full_name !== "string")
        throw new TrackerFailure("invalid-response");
      return { remoteName: r.json.full_name };
    },
    async listOpen(mapping, { etag = null, observedName = null } = {}) {
      const r = await call(mapping, `/repositories/${mapping.remoteId}/issues?${LIST}`, etag);
      if (r.status === 304) return { notModified: true };
      if (!Array.isArray(r.json)) throw new TrackerFailure("invalid-response");
      let partial = false;
      const items = [];
      for (const raw of r.json.slice(0, 50)) {
        if (raw && typeof raw === "object" && "pull_request" in raw) continue;
        const it = pinned(raw, mapping, observedName) ? item(raw) : null;
        if (!it) {
          partial = true;
          continue;
        }
        items.push(it);
      }
      return { items, partial, etag: r.etag ?? null };
    },
    async get(mapping, itemRef, { observedName = null } = {}) {
      if (!validItemRef("github", mapping.remoteName, itemRef)) throw new TrackerFailure("error");
      const r = await call(mapping, `/repositories/${mapping.remoteId}/issues/${itemRef}`);
      if (r.json && typeof r.json === "object" && "pull_request" in r.json)
        throw new TrackerFailure("not-found");
      const it = pinned(r.json, mapping, observedName) ? item(r.json) : null;
      if (!it || it.ref !== itemRef) throw new TrackerFailure("invalid-response");
      return it;
    },
  };
}
