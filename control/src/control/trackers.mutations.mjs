// J3-DESIGN.md §9 mutation run. Not a test file (no .test. in the name), so the ordinary sweep never runs it.
//
//   node src/control/trackers.mutations.mjs [ids…]
//   ORCA_UI_TOOLING=/abs/ui-tooling node src/control/trackers.mutations.mjs   # also runs the UI mutation (M18)
//
// For each mutation: apply exact-anchor edits to the working copy, run the named suite, require that the
// named test FAILS, then restore the original bytes -- always, in a finally. An anchor that does not occur
// exactly once aborts the run rather than silently mutating nothing. Same harness shape as
// seat-inbox.mutations.mjs.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  plugin = path.resolve(here, "../../orca-organization");
const K = (f) => path.join(here, f),
  O = (f) => path.join(plugin, f);
const TR = K("trackers.mjs"),
  RPC = K("rpc.mjs"),
  CRED = K("trackers-credential.mjs"),
  CH = K("role-channels.mjs");
const HTTP = O("server/trackers/http.mjs"),
  GHM = O("server/trackers/github.mjs"),
  RUN = O("server/trackers/gh-runner.mjs");
const SVC = O("server/trackers/service.mjs"),
  REFS = O("shared/tracker-refs.mjs"),
  CONTRACT = O("shared/trackers.ts"),
  PANEL = O("client/trackers.tsx");
const S = {
  C: K("trackers.test.mjs"),
  K: K("trackers-credential.test.mjs"),
  R: O("shared/tracker-refs.test.mjs"),
  T: O("shared/trackers.contract.test.mjs"),
  G: O("server/trackers/github.test.mjs"),
  SV: O("server/trackers/service.test.mjs"),
  X: O("server/trackers/security.test.mjs"),
  U: "ui",
};

const M = [
  {
    id: "M1",
    why: "request headers logged in the HTTP port",
    expect: "X1",
    suite: S.X,
    edits: [
      [
        HTTP,
        "  let response;\n",
        "  let response;\n  console.error('tracker request', target.href, JSON.stringify(sent));\n",
      ],
    ],
  },
  {
    id: "M2",
    why: "raw fetch error text forwarded instead of the enum",
    expect: "G4",
    suite: S.G,
    edits: [
      [
        HTTP,
        "  catch { throw new TrackerFailure('offline'); }",
        "  catch (error) { throw new Error(String(error?.message)); }",
      ],
    ],
  },
  {
    id: "M3",
    why: "keychain credential cached across requests",
    expect: "G6",
    suite: S.G,
    edits: [
      [
        GHM,
        "const API = 'https://api.github.com';",
        "const API = 'https://api.github.com';\nlet cachedToken;",
      ],
      [
        GHM,
        "    try { token = await secrets.read(credentialAccount('github', mapping.site)); }",
        "    try { token = cachedToken ??= await secrets.read(credentialAccount('github', mapping.site)); }",
      ],
    ],
  },
  {
    id: "M4",
    why: "inherited environment (GH_TOKEN) passed to the gh child",
    expect: "G8",
    suite: S.G,
    edits: [
      [
        RUN,
        "  return { HOME: env.HOME ?? '', PATH: '/usr/bin:/bin',",
        "  return { ...env, HOME: env.HOME ?? '', PATH: '/usr/bin:/bin',",
      ],
    ],
  },
  {
    id: "M5",
    why: "a credential column added to the mapping table",
    expect: "C5",
    suite: S.C,
    edits: [
      [
        TR,
        "validatedAt TEXT,note TEXT NOT NULL,at TEXT NOT NULL)",
        "validatedAt TEXT,note TEXT NOT NULL,at TEXT NOT NULL,credential TEXT)",
      ],
      [
        TR,
        "const MAPPING_COLUMNS = 'project,tracker,auth,site,remoteId,remoteName,state,revision,validatedAt,note,at';",
        "const MAPPING_COLUMNS = 'project,tracker,auth,site,remoteId,remoteName,state,revision,validatedAt,note,at,credential';",
      ],
    ],
  },
  {
    id: "M6",
    why: "credential status reads the secret value",
    expect: "K2",
    suite: S.K,
    edits: [
      [
        CRED,
        "  if (action === 'status') return ['find-generic-password', '-s', service, '-a', account];",
        "  if (action === 'status') return ['find-generic-password', '-s', service, '-a', account, '-w'];",
      ],
    ],
  },
  {
    id: "M7",
    why: "the read RPC accepts a caller-named repository",
    expect: "T1",
    suite: S.T,
    edits: [
      [
        CONTRACT,
        "  input: z.object({ projectId: id.optional(), subjects: z.array(id).max(64).optional() }).strict(),",
        "  input: z.object({ projectId: id.optional(), subjects: z.array(id).max(64).optional(), repo: z.string().optional() }),",
      ],
    ],
  },
  {
    id: "M8",
    why: "a connector gains a working-directory path",
    expect: "G9",
    suite: S.G,
    edits: [
      [
        RUN,
        "    run(binary, args, { env: ghEnvironment(), timeout",
        "    run(binary, args, { cwd: process.cwd(), env: ghEnvironment(), timeout",
      ],
    ],
  },
  {
    id: "M9",
    why: "issues addressed by owner/name instead of the pinned id",
    expect: "G1",
    suite: S.G,
    edits: [
      [
        GHM,
        "      const r = await call(mapping, `/repositories/${mapping.remoteId}/issues?${LIST}`, etag);",
        "      const r = await call(mapping, `/repos/${mapping.remoteName}/issues?${LIST}`, etag);",
      ],
    ],
  },
  {
    id: "M10",
    why: "repository pin check dropped from listed items",
    expect: "G2",
    suite: S.G,
    edits: [
      [
        GHM,
        "        const it = pinned(raw, mapping, observedName) ? item(raw) : null;",
        "        const it = item(raw);",
      ],
    ],
  },
  {
    id: "M11a",
    why: "HTTP method other than GET",
    expect: "G3",
    suite: S.G,
    edits: [
      [HTTP, "fetcher(target.href, { method: 'GET',", "fetcher(target.href, { method: 'POST',"],
    ],
  },
  {
    id: "M11b",
    why: "gh argv template loosened to accept extra arguments",
    expect: "G5",
    suite: S.G,
    edits: [
      [
        GHM,
        "  const ok = Array.isArray(args) && args.length === 6 &&",
        "  const ok = Array.isArray(args) && args.length >= 6 &&",
      ],
    ],
  },
  {
    id: "M12",
    why: "redirects followed",
    expect: "G3",
    suite: S.G,
    edits: [[HTTP, "redirect: 'error', signal", "redirect: 'follow', signal"]],
  },
  {
    id: "M13",
    why: "trackers-map reachable before the operator gate",
    expect: "C1",
    suite: S.C,
    edits: [
      [
        RPC,
        "    if (request.method === 'inspect') {",
        "    if (request.method === 'trackers-map') return trackers(control).map(a);\n    if (request.method === 'inspect') {",
      ],
    ],
  },
  {
    id: "M14",
    why: "expectedRevision not enforced on map",
    expect: "C3",
    suite: S.C,
    edits: [
      [
        TR,
        "      if (revision !== a.expectedRevision) throw Error('Tracker mapping revision changed; refresh before mapping');\n",
        "",
      ],
    ],
  },
  {
    id: "M15",
    why: "mapping history overwritten on remap",
    expect: "C4",
    suite: S.C,
    edits: [
      [
        TR,
        "      this.db.prepare('INSERT OR REPLACE INTO tracker_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?)')",
        "      this.db.prepare('DELETE FROM tracker_mapping_history WHERE project=?').run(a.project);\n      this.db.prepare('INSERT OR REPLACE INTO tracker_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?)')",
      ],
    ],
  },
  {
    id: "M16",
    why: "link subject membership not checked",
    expect: "C6",
    suite: S.C,
    edits: [
      [
        TR,
        "    if (!d.membership.some(m => m.taskId === task && m.projectId === a.project)) throw Error('That subject is not an explicitly recorded member of the project');\n",
        "",
      ],
    ],
  },
  {
    id: "M17",
    why: "item URL taken from the tracker response",
    expect: "S1",
    suite: S.SV,
    edits: [
      [
        GHM,
        "  return { ref: String(raw.number), title:",
        "  return { url: raw.html_url, ref: String(raw.number), title:",
      ],
      [
        SVC,
        "url: canonicalUrl(m.tracker, m.site, m.remoteName, it.ref),",
        "url: it.url ?? canonicalUrl(m.tracker, m.site, m.remoteName, it.ref),",
      ],
    ],
  },
  {
    id: "M18",
    why: "tracker title interpreted as markdown in the panel",
    expect: "U1",
    suite: S.U,
    edits: [
      [
        PANEL,
        '{item.ref} · {item.title ?? "not yet observed"}',
        '{item.ref} · {(item.title ?? "not yet observed").replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, "$1").replace(/<[^>]+>/g, "")}',
      ],
    ],
  },
  {
    id: "M19",
    why: "bidi overrides no longer stripped",
    expect: "R4",
    suite: S.R,
    edits: [[REFS, "\\u202a-\\u202e\\u2066-\\u2069", ""]],
  },
  {
    id: "M20",
    why: "a link sends a delivery to the subject session",
    expect: "C8",
    suite: S.C,
    edits: [
      [
        TR,
        "      this.db.prepare('INSERT INTO tracker_link_history VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, existing ? 'relink' : 'link', previous, next, 'operator', at);",
        "      this.db.prepare('INSERT INTO tracker_link_history VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, existing ? 'relink' : 'link', previous, next, 'operator', at);\n      this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?)').run(randomUUID(), a.subject.id, 'send', JSON.stringify({ text: url }), 'intent', null);",
      ],
    ],
  },
  {
    id: "M21",
    why: "channel handling reaches the tracker records",
    expect: "C14",
    suite: S.C,
    edits: [
      [
        CH,
        "export class RoleChannels {",
        "const linkFromChannel = (control, a) => control.trackers?.link(a);\nexport class RoleChannels {",
      ],
    ],
  },
  {
    id: "M22",
    why: "retry ignores the backoff",
    expect: "S5",
    suite: S.SV,
    edits: [[SVC, "    if (t < s.retryAt) return s;\n", ""]],
  },
  {
    id: "M23",
    why: "observations kept across service instances (persisted)",
    expect: "S8",
    suite: S.SV,
    edits: [
      [
        SVC,
        "export function createTrackerService({ controller, connectors, now = Date.now }) {\n  const states = new Map(), singles = new Map();",
        "const states = new Map(), singles = new Map();\nexport function createTrackerService({ controller, connectors, now = Date.now }) {",
      ],
    ],
  },
  {
    id: "M24",
    why: "the read path uses a write-capable account",
    expect: "R3",
    suite: S.R,
    edits: [
      [
        REFS,
        "  if (tracker === 'github' && site === 'github.com') return 'github.com:read';",
        "  if (tracker === 'github' && site === 'github.com') return 'github.com:write';",
      ],
    ],
  },
];

function failing(suite) {
  let out;
  try {
    if (suite === "ui") {
      const tooling = process.env.ORCA_UI_TOOLING;
      out = execFileSync(
        process.execPath,
        [path.join(plugin, "verify-ui.mjs"), tooling, "trackers.ui.test.mjs"],
        { cwd: plugin, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } else
      out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", suite], {
        cwd: path.dirname(suite),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1]);
}
const only = process.argv.slice(2);
let bad = 0,
  skipped = 0;
for (const m of M.filter((x) => !only.length || only.includes(x.id))) {
  if (m.suite === "ui" && !process.env.ORCA_UI_TOOLING) {
    skipped++;
    console.log(`SKIPPED  ${m.id.padEnd(5)} ${m.why} -> needs ORCA_UI_TOOLING`);
    continue;
  }
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      const text = originals.get(file) ?? fs.readFileSync(file, "utf8");
      originals.set(file, text);
      const current = fs.readFileSync(file, "utf8");
      if (current.split(from).length !== 2)
        throw Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(
        file,
        current.replace(from, () => to),
      );
    }
    const failed = failing(m.suite),
      killed = failed.some((name) => name.startsWith(m.expect + ":"));
    if (!killed) bad++;
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"} ${m.id.padEnd(5)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.length ? failed.map((n) => n.slice(0, 32)).join(" | ") : "none"}`,
    );
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(
  bad
    ? `${bad} mutation(s) SURVIVED`
    : `all ${M.length - skipped} run mutation(s) killed${skipped ? `; ${skipped} skipped` : ""}`,
);
process.exitCode = bad ? 1 : 0;
