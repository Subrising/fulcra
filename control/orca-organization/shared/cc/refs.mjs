// Command Centre shared contract: refs (CONTRACTS.md v1.9 §2.1), noPersonal (§1a) and the plain-language check
// for level-1 decision packets (§3.2 #9). THE one implementation (v1.9): plain JavaScript, because the controller
// (src/control, plain .mjs, no zod) runs the same checks as the plugin. refs.ts only re-exports this plus the zod
// `ref`; refs.d.mts carries the types. Every job imports it and never redefines a ref or a pattern.

// ---------------------------------------------------------------- refs (§2.1)
// Ids are canonical lowercase: refs are compared as strings (UNIQUE(fromRef, toRef, relation)), so one object
// must have exactly one spelling.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SLUG = "[a-z0-9][a-z0-9-]{0,63}";
const SHA40 = "[0-9a-f]{40}";
// "local" is reserved: a `local:` repo key is always a local project repo, never a connector named local.
const CONNECTOR = "(?!local(?:[@:]|$))[a-z][a-z0-9-]{1,31}";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SITE = `${LABEL}(?:\\.${LABEL})*`;
// A remote path segment: no "." or ".." segment, no ":" "@" "#" (they delimit the ref), no leading "/".
const SEGMENT = "(?!\\.\\.?(?:/|$|[:@#]))[A-Za-z0-9._-]{1,100}";
const REMOTE_PATH = `${SEGMENT}(?:/${SEGMENT}){0,7}`;
const REPO_KEY = `(?:local:${UUID}/${SLUG}|${CONNECTOR}(?:@${SITE})?:${REMOTE_PATH})`;
// A repo-relative file path: no leading "/", no "." or ".." segment, no backslash or control characters.
const REL_SEGMENT = "(?!\\.\\.?(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]{1,255}";
const REL_PATH = `${REL_SEGMENT}(?:/${REL_SEGMENT}){0,31}`;
// Issue body = an existing trackerItemKey (trackers.ts:8) as it is, or any connector with an optional site.
const ISSUE = `${CONNECTOR}(?:@${SITE})?:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9-]{1,32}`;
const BODIES = {
  project: UUID,
  task: UUID,
  session: UUID,
  seat: SLUG,
  turn: `${UUID}/[A-Za-z0-9._:-]{1,128}`,
  repo: REPO_KEY,
  commit: `${REPO_KEY}@${SHA40}`,
  pr: `${REPO_KEY}#[1-9][0-9]{0,9}`,
  issue: ISSUE,
  file: `${REPO_KEY}:${REL_PATH}`,
  decision: UUID,
  brief: `${UUID}@[1-9][0-9]{0,9}`,
  env: UUID,
  deploy: UUID,
  promotion: UUID,
  archmap: `${REPO_KEY}@${SHA40}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}`,
  outcome: UUID,
};
export const REF_KINDS = Object.freeze(Object.keys(BODIES));
export const REF_MAX = 300;
/** One anchored regex per kind; the kind prefix is part of the match. */
export const REF_PATTERNS = Object.freeze(
  Object.fromEntries(REF_KINDS.map((kind) => [kind, new RegExp(`^${kind}:${BODIES[kind]}$`)])),
);
const kindOf = (value) => {
  const kind = value.slice(0, value.indexOf(":"));
  return Object.hasOwn(REF_PATTERNS, kind) ? kind : null;
};

const split = (body, tail) => new RegExp(`^(?<repoKey>${REPO_KEY})${tail}$`).exec(body)?.groups;
/** The one ref parser. Returns null for anything that is not exactly one kind's grammar. */
export function parseRef(value) {
  if (typeof value !== "string" || value.length > REF_MAX) return null;
  const kind = kindOf(value);
  if (!kind || !REF_PATTERNS[kind].test(value)) return null;
  const body = value.slice(kind.length + 1);
  switch (kind) {
    case "seat":
      return { kind, seat: body };
    case "turn": {
      const slash = body.indexOf("/");
      return { kind, sessionId: body.slice(0, slash), turnId: body.slice(slash + 1) };
    }
    case "repo":
      return { kind, repoKey: body };
    case "commit": {
      const g = split(body, `@(?<sha>${SHA40})`);
      return { kind, repoKey: g.repoKey, sha: g.sha };
    }
    case "pr": {
      const g = split(body, "#(?<n>[1-9][0-9]{0,9})");
      return { kind, repoKey: g.repoKey, number: Number(g.n) };
    }
    case "file": {
      const g = split(body, `:(?<path>${REL_PATH})`);
      return { kind, repoKey: g.repoKey, path: g.path };
    }
    case "archmap": {
      const g = split(body, `@(?<sha>${SHA40}):(?<map>[A-Za-z0-9][A-Za-z0-9._-]{0,63})`);
      return { kind, repoKey: g.repoKey, sha: g.sha, mapName: g.map };
    }
    case "issue": {
      const g = new RegExp(
        `^(?<connector>${CONNECTOR})(?:@(?<site>${SITE}))?:(?<remoteId>[A-Za-z0-9._-]{1,64}):(?<ref>[A-Za-z0-9-]{1,32})$`,
      ).exec(body).groups;
      return {
        kind,
        connector: g.connector,
        site: g.site ?? null,
        remoteId: g.remoteId,
        ref: g.ref,
      };
    }
    case "brief": {
      const at = body.indexOf("@");
      return { kind, projectId: body.slice(0, at), revision: Number(body.slice(at + 1)) };
    }
    default:
      return { kind, id: body };
  }
}
export const isRef = (value) => parseRef(value) !== null;

// ---------------------------------------------------------------- noPersonal (§1a)
// Boundaries keep ordinary words out: "config.local.json" is not a ".local" host. The token pattern is the
// contract's own (v1.5, anchored and followed by a token body), so "low-risk-first" and "task-list" pass.
const PERSONAL = Object.freeze(
  [
    ["a home or volume path", /\/Users\/|\/Volumes\/|\/home\/|~\//],
    // v1.9: a whole hostname only. "config.local.json" and "notes.example.md" are file names, not hosts.
    [
      "a private host name",
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|local)(?![a-z0-9-]|\.[a-z0-9])/i,
    ],
    ["an email address", /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i],
    ["a secret token", /(?<![A-Za-z0-9])(ghp_|gho_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_-]{8,}/],
  ].map(([what, re]) => Object.freeze([what, re])),
);
/** The same §1a patterns as a list, for a scrubber that removes matches instead of refusing (J6 step-through). */
export const PERSONAL_PATTERNS = Object.freeze(
  PERSONAL.map(([name, re]) => Object.freeze({ name, re })),
);
/** Why a value is refused, or null when it may be stored or published. */
export function personalMatch(text) {
  if (typeof text !== "string") return null;
  for (const [what, re] of PERSONAL) if (re.test(text)) return what;
  return null;
}
/** True when the text holds no path, host, email or token from §1a. Apply to every written or published free text. */
export const noPersonal = (text) => personalMatch(text) === null;

// ---------------------------------------------------------------- plain language (§3.2 #9)
/** Terms a busy reader should never have to decode. Seeded by §3.2 #9; extend here, never in a job. */
export const JARGON = Object.freeze([
  "IR",
  "RPC",
  "journal",
  "seat generation",
  "digest",
  "webhook",
  "OAuth",
  "PKCE",
  "Kubernetes",
  "recipe",
  "schema",
  "worktree",
  "idempotent",
  "blast radius",
]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An all-capitals acronym matches only in capitals ("IR", not "ir"); words match in any case, singular or plural.
const JARGON_RE = JARGON.map((term) => [
  term,
  term === term.toUpperCase()
    ? new RegExp(`(?<![A-Za-z0-9])${escape(term)}s?(?![A-Za-z0-9])`)
    : new RegExp(`(?<![A-Za-z0-9])${escape(term).replace(/ /g, "\\s+")}s?(?![A-Za-z0-9])`, "i"),
]);
const CODE_EXT = "(?:m?js|cjs|jsx?|tsx?|json|py|sh|ya?ml|toml|sql|md)";
const TECHNICAL = [
  ["an id", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  // A commit or content hash: 7-64 hex characters with at least one digit and one letter, so words and plain
  // numbers are not mistaken for one. Never a block of a hyphenated uuid, which is reported as an id.
  [
    "a hash",
    /(?<![A-Za-z0-9-])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![A-Za-z0-9-])/i,
  ],
  // A path: rooted, relative or home-relative, or segments with a file at the end. "and/or" and "24/7" are fine.
  [
    "a file path",
    new RegExp(
      `(?:^|(?<=[\\s("']))(?:~|\\.{1,2})?/[\\w.-]+(?:/[\\w.-]*)*|[\\w.-]+(?:/[\\w.-]+)+\\.${CODE_EXT}\\b|(?<![\\w.-])[a-z0-9][\\w-]*\\.${CODE_EXT}(?![\\w-])`,
    ),
  ],
  [
    "code formatting",
    /`[^`]+`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/,
  ],
];
/**
 * §3.2 #9. Everything in `text` a busy reader should not have to decode: a ref, id, hash, file path or code
 * token, or a JARGON term. Empty means it reads as plain language. The caller refuses on any entry for level-1
 * packets and warns for level 2-3; sentence limits use sentenceCount().
 */
export function plainLanguageCheck(text) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  const tokens = text
    .split(/\s+/)
    .map((t) => t.replace(/^[("'`]+|[)"'`.,;:!?]+$/g, ""))
    .filter(Boolean);
  const refs = tokens.filter(isRef);
  if (refs.length) found.push("a reference id");
  // What a ref already explains (its uuid or sha) is not reported again.
  const rest = refs.reduce((t, r) => t.split(r).join(" "), text);
  for (const [what, re] of TECHNICAL) if (re.test(rest)) found.push(what);
  for (const [term, re] of JARGON_RE) if (re.test(text)) found.push(`the technical term "${term}"`);
  return found;
}
/** Sentences, as a reader counts them: a stop followed by a capital, digit or quote, or the end. "e.g. the" is one. */
export function sentenceCount(text) {
  if (typeof text !== "string" || !text.trim()) return 0;
  return (text.trim().match(/[.!?]+(?=\s+["\u201c'A-Z0-9]|\s*$)/g) ?? []).length || 1;
}
