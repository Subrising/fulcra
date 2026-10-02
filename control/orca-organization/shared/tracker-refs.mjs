// J3 issue trackers: the identity rules shared by the controller (which records mappings and links) and the
// plugin server (which calls the tracker). One module, so the URL the journal stores and the URL the view
// opens can never be built two ways. Everything here is an id, a key, a public URL or plain text: no credential.
export const TRACKERS = Object.freeze(["github", "jira", "bitbucket"]);
// The existing gh login carries broad write scopes, so it is an explicit opt-in and GitHub-only.
export const AUTH = Object.freeze({
  github: Object.freeze(["keychain", "gh-cli"]),
  jira: Object.freeze(["keychain"]),
  bitbucket: Object.freeze(["keychain"]),
});
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const RULES = {
  github: {
    site: (s) => s === "github.com",
    remoteId: /^[1-9][0-9]{0,11}$/,
    remoteName: (n) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(n) &&
      ![".", ".."].includes(n.split("/")[1]),
    itemRef: (ref) => /^[1-9][0-9]{0,9}$/.test(ref),
  },
  jira: {
    site: (s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(s),
    remoteId: /^[1-9][0-9]{0,11}$/,
    remoteName: (n) => JIRA_KEY.test(n),
    // An issue key must belong to the mapped project key: ORCA-12 under ORCA, never OTHER-12.
    itemRef: (ref, name) =>
      typeof name === "string" &&
      ref.startsWith(name + "-") &&
      /^[1-9][0-9]{0,9}$/.test(ref.slice(name.length + 1)),
  },
  bitbucket: {
    site: (s) => s === "bitbucket.org",
    remoteId: /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/,
    remoteName: (n) =>
      /^[a-z0-9][a-z0-9_-]{0,61}\/[a-z0-9._-]{1,62}$/.test(n) &&
      ![".", ".."].includes(n.split("/")[1]),
    itemRef: (ref) => /^[1-9][0-9]{0,9}$/.test(ref),
  },
};
const str = (v) => typeof v === "string";
export function validMapping(m) {
  if (!m || typeof m !== "object" || !TRACKERS.includes(m.tracker)) return false;
  const r = RULES[m.tracker];
  return (
    AUTH[m.tracker].includes(m.auth) &&
    str(m.site) &&
    r.site(m.site) &&
    str(m.remoteId) &&
    r.remoteId.test(m.remoteId) &&
    str(m.remoteName) &&
    r.remoteName(m.remoteName)
  );
}
export function validRemoteName(tracker, name) {
  return TRACKERS.includes(tracker) && str(name) && RULES[tracker].remoteName(name);
}
export function validRemoteId(tracker, id) {
  return TRACKERS.includes(tracker) && str(id) && RULES[tracker].remoteId.test(id);
}
export function validItemRef(tracker, remoteName, ref) {
  return TRACKERS.includes(tracker) && str(ref) && RULES[tracker].itemRef(ref, remoteName);
}
// The only way a tracker URL is ever produced. It is built from the pinned mapping and a validated item
// reference; a URL supplied by a caller or returned by a tracker API is never stored or opened.
export function canonicalUrl(tracker, site, remoteName, itemRef) {
  if (
    !validItemRef(tracker, remoteName, itemRef) ||
    !validRemoteName(tracker, remoteName) ||
    !RULES[tracker].site(site)
  )
    throw new Error("Invalid tracker reference");
  if (tracker === "github") return `https://github.com/${remoteName}/issues/${itemRef}`;
  if (tracker === "jira") return `https://${site}/browse/${itemRef}`;
  return `https://bitbucket.org/${remoteName}/issues/${itemRef}`;
}
export function itemKey(tracker, remoteId, itemRef) {
  if (!validRemoteId(tracker, remoteId)) throw new Error("Invalid tracker reference");
  return `${tracker}:${remoteId.replace(/[{}]/g, "")}:${itemRef}`;
}
export function displayRef(tracker, itemRef) {
  return tracker === "jira" ? itemRef : `#${itemRef}`;
}
// The keychain account for the READ credential of a tracker. A constant per tracker/site: no caller chooses
// it, and no write account is ever derived here.
export function credentialAccount(tracker, site) {
  if (tracker === "github" && site === "github.com") return "github.com:read";
  if (tracker === "bitbucket" && site === "bitbucket.org") return "bitbucket.org:read";
  if (tracker === "jira" && RULES.jira.site(site)) return `jira:${site}:read`;
  throw new Error("Invalid tracker site");
}
// Tracker text is untrusted. It is shown only as plain text, after this: well-formed Unicode, NFC, no
// C0/C1 controls, no bidi overrides or isolates, no zero-width joiners used for spoofing, one line, capped.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
export function plainText(value, max) {
  if (typeof value !== "string") return null;
  const clean = value
    .toWellFormed()
    .normalize("NFC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(UNSAFE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const points = [...clean];
  return points.length > max ? points.slice(0, max - 1).join("") + "…" : clean;
}
