import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
// What a reviewer needs before approving a change, computed from this repository alone.
//
// Not an Archify or Radius integration: those are external tools and this is the question they were
// wanted for -- what will this change do, and what is the blast radius. Everything here comes from git
// and the import graph, so it is exact about what it can see and says what it cannot.
//
// The fenced surfaces below are not a taste list. Each is a place where "looks fine" has actually not been
// fine in this repository, and the reason is recorded so a reviewer knows why the line matters.
export const FENCES = [
  {
    id: "admission",
    label: "Native admission guard",
    why: "Runs inside the daemon and decides whether delegated input is admitted. A field rename elsewhere once made a whole branch unreachable while every test stayed green.",
    files: [
      "src/control/admission-guard.mjs",
      "src/control/admission-guard-precondition.mjs",
      "src/control/native-release-hooks.mjs",
      "src/control/activation.mjs",
    ],
  },
  {
    id: "role-authority",
    label: "Role and channel authority",
    why: "Decides which seat may speak to which, and re-derives that at dispatch. Its checks are cross-task, so a recipient-side check proves nothing about the sender.",
    files: [
      "src/control/role-channels.mjs",
      "src/control/bindings.mjs",
      "src/control/role-sessions.mjs",
      "src/control/host-native.mjs",
    ],
  },
  {
    id: "queued-source",
    label: "Queued-source classification",
    why: "Decides whether parked work is cancelled or retried. Getting definite and unknown the wrong way round either loses approved work or retries it forever.",
    files: [
      "src/control/quota-runtime.mjs",
      "src/control/quota-wait.mjs",
      "src/control/authority.mjs",
    ],
  },
  {
    id: "session-creation",
    label: "Session creation and defaults",
    why: "Every session gets its mode, thinking level and approval options here. A path that goes round it silently inherits the host default.",
    files: [
      "src/control/native.mjs",
      "src/control/provider-mode.mjs",
      "src/control/installation-settings.mjs",
      "src/session-config.mjs",
      "src/session.mjs",
      "src/book/native.mjs",
    ],
  },
];
const SOURCE = /\.(mjs|js|ts|tsx|cjs|mts|cts|jsx)$/;
const isTest = (f) => /\.test\.|\.spec\.|\.integration\.|(^|\/)__tests__\//.test(f);
export function sourceFiles(root, read = fs) {
  const walk = (dir) =>
    read.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return ["node_modules", ".git"].includes(e.name) ? [] : walk(full);
      return e.isFile() && SOURCE.test(e.name) ? [path.relative(root, full)] : [];
    });
  return walk(root).sort();
}
// How a specifier finds a file, the way Node and TypeScript do for relative paths: as written, with an
// extension added, as a directory index, or a ".js" written for a ".ts" source. `aliases` are tsconfig
// `paths` entries ("@/*" -> "src/*"), each applying only to files under its tsconfig's directory.
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const candidates = (base) => [
  base,
  ...EXTENSIONS.map((e) => base + e),
  ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ...(/\.(m|c)?jsx?$/.test(base)
    ? [".ts", ".tsx", ".mts", ".cts"].map((e) => base.replace(/\.(m|c)?jsx?$/, e))
    : []),
];
export function resolveSpecifier(known, from, spec, aliases = []) {
  let bases = [];
  if (spec.startsWith("."))
    bases = [path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))];
  else {
    // The deepest tsconfig that contains `from` and maps this prefix wins, as it would for the compiler.
    const alias = aliases
      .filter((a) => from.startsWith(a.scope) && spec.startsWith(a.prefix))
      .sort((a, b) => b.scope.length - a.scope.length)[0];
    if (alias)
      bases = alias.targets.map((t) => path.posix.normalize(t + spec.slice(alias.prefix.length)));
  }
  for (const base of bases) for (const c of candidates(base)) if (known.has(c)) return c;
  return null;
}
// Static, re-exported, literal-dynamic and require()d specifiers. A bare package name, or a computed path,
// is invisible here, which is stated in the report rather than assumed away.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"\n]+)['"]/g;
export function importGraph(files, readFile, { aliases = [] } = {}) {
  const known = new Set(files),
    graph = new Map();
  for (const file of files) {
    const out = new Set();
    for (const [, spec] of (readFile(file) ?? "").matchAll(SPECIFIER)) {
      const target = resolveSpecifier(known, file, spec, aliases);
      if (target && target !== file) out.add(target);
    }
    graph.set(file, out);
  }
  return graph;
}
// Everything that can reach the changed modules, transitively. This is the blast radius: not what the
// change touches, but what the change can be felt by.
export function dependents(graph, changed) {
  const reverse = new Map();
  for (const [file, outs] of graph)
    for (const out of outs) reverse.set(out, (reverse.get(out) ?? new Set()).add(file));
  const seen = new Set(),
    queue = changed.filter((f) => graph.has(f));
  while (queue.length) {
    for (const dep of reverse.get(queue.shift()) ?? [])
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
  }
  for (const f of changed) seen.delete(f);
  return [...seen].sort();
}
export const fencesTouched = (changed) =>
  FENCES.filter((fence) => fence.files.some((f) => changed.includes(f))).map((fence) => ({
    ...fence,
    hit: fence.files.filter((f) => changed.includes(f)),
  }));
// A changed module is covered when some test file reaches it. Reaching is transitive: a test that imports
// a module which imports the changed one still exercises it.
export function coverage(graph, changed) {
  const reachable = (file) => {
    const seen = new Set();
    const q = [file];
    while (q.length)
      for (const out of graph.get(q.shift()) ?? [])
        if (!seen.has(out)) {
          seen.add(out);
          q.push(out);
        }
    return seen;
  };
  const tests = [...graph.keys()].filter(isTest).map((t) => [t, reachable(t)]);
  return changed
    .filter((f) => !isTest(f))
    .map((f) => ({
      file: f,
      tests: tests
        .filter(([, r]) => r.has(f))
        .map(([t]) => t)
        .sort(),
    }));
}
// Twenty-eight test files on one line is accurate and unreadable. A reviewer wants the test they would
// open first: the one named after the module, then its neighbours in the same directory. The count keeps
// the fact that the others exist without printing them.
export function nearest(file, tests, limit = 3) {
  const base = path.basename(file).replace(/\.[^.]+$/, ""),
    dir = path.dirname(file);
  const rank = (t) =>
    path.basename(t).startsWith(`${base}.`) ? 0 : path.dirname(t) === dir ? 1 : 2;
  return [...tests].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, limit);
}
const covered = (c) => {
  const shown = nearest(c.file, c.tests),
    rest = c.tests.length - shown.length;
  return `${c.file}\n      ${c.tests.length} test file(s), nearest: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
};
const bullet = (lines, empty) =>
  lines.length ? lines.map((l) => `  - ${l}`).join("\n") : `  ${empty}`;
export function report({ range, changed, graph }) {
  const source = changed.filter((f) => SOURCE.test(f)),
    fences = fencesTouched(changed);
  // Tests that reach the change are reported under coverage, not here: a reviewer asking "what else is
  // affected" means production modules, and mixing the two buries the answer.
  const blast = dependents(graph, source).filter((f) => !isTest(f)),
    cover = coverage(graph, source);
  const uncovered = cover.filter((c) => !c.tests.length).map((c) => c.file);
  return (
    [
      `CHANGE IMPACT  ${range}`,
      `${changed.length} file(s) changed, ${source.length} of them source.`,
      "",
      fences.length
        ? "FENCED SURFACES TOUCHED -- read these first"
        : "FENCED SURFACES: none touched",
      ...fences.map((f) =>
        [`  ${f.label}`, `    changed: ${f.hit.join(", ")}`, `    why it matters: ${f.why}`].join(
          "\n",
        ),
      ),
      "",
      `BLAST RADIUS -- ${blast.length} module(s) can reach the changed code`,
      bullet(blast, "(nothing else imports the changed modules)"),
      "",
      "TEST COVERAGE OF THE CHANGE",
      bullet(cover.filter((c) => c.tests.length).map(covered), "(no changed source)"),
      uncovered.length
        ? `\n  NO TEST REACHES -- these changed with nothing exercising them:\n${bullet(uncovered, "")}`
        : null,
      "",
      "WHAT THIS CANNOT SEE",
      "  - Dynamic dispatch and computed module paths. Only relative, literal specifiers are followed.",
      "  - Anything outside this repository: the provider adapter, the daemon, the app.",
      "  - Runtime configuration. A settings file changes behaviour without changing a line here.",
      "  - Whether a test that reaches a module actually asserts anything about it.",
    ]
      .filter((l) => l !== null)
      .join("\n") + "\n"
  );
}
export function changedFiles(range, root) {
  return execFileSync("git", ["diff", "--name-only", range], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}
// ---- Any repository: a given root and diff range --------------------------------------------------------
// The same questions for a product repository: which files changed, what production code can feel them,
// and which tests reach them. Everything is read AT THE HEAD COMMIT through git (one `cat-file --batch`),
// never the working tree, so the answer describes the change under review. Paths are repo-relative.
// JavaScript and TypeScript are measured; other languages are listed as not measured, never guessed.
const OTHER_LANGUAGES = Object.freeze({
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  cs: "C#",
  fs: "F#",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  m: "Objective-C",
  mm: "Objective-C",
  php: "PHP",
  scala: "Scala",
  sh: "Shell",
  bash: "Shell",
  ps1: "PowerShell",
  dart: "Dart",
  lua: "Lua",
  ex: "Elixir",
  exs: "Elixir",
  vue: "Vue",
  svelte: "Svelte",
  bicep: "Bicep",
  tf: "Terraform",
  sql: "SQL",
});
const MAX_SOURCE_BYTES = 1_048_576;
// A revision or a range of two; never an option, never whitespace, never "." at either end (git refuses
// those too), so "a....b" cannot be read as "a" ... ".b".
const REV = "(?![-.])(?:(?!\\.\\.)[A-Za-z0-9._/@^~-]){1,200}(?<!\\.)";
const RANGE = new RegExp(`^${REV}(?:\\.\\.\\.?${REV})?$`);
export const IMPACT_LIMITS = Object.freeze([
  "Only JavaScript and TypeScript imports are followed; other languages are listed as not measured.",
  "Dynamic imports with computed paths, and packages from outside the repository, are not followed.",
  'Path aliases come from each tsconfig.json "paths"; an alias set in an extended config is not read.',
  "A test that reaches a file may still not check what changed in it.",
]);
export function classify(file, status = "M") {
  if (status === "D") return { kind: "deleted", language: null };
  if (SOURCE.test(file))
    return {
      kind: isTest(file) ? "test" : "code",
      language: /\.tsx?$|\.[mc]ts$/.test(file) ? "TypeScript" : "JavaScript",
    };
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
  if (Object.hasOwn(OTHER_LANGUAGES, ext))
    return { kind: "not-measured", language: OTHER_LANGUAGES[ext] };
  return { kind: "other", language: null };
}
// tsconfig.json allows comments and trailing commas; strip both outside strings, then parse.
export function parseJsonc(text) {
  let out = "",
    inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
// "@/*": ["./src/*"] in packages/app/tsconfig.json -> { scope: 'packages/app/', prefix: '@/', targets: ['packages/app/src/'] }.
export function aliasesFrom(tsconfigs) {
  const aliases = [];
  for (const { path: file, text } of tsconfigs) {
    let options;
    try {
      options = parseJsonc(text)?.compilerOptions;
    } catch {
      continue;
    }
    if (!options || typeof options.paths !== "object" || options.paths === null) continue;
    const dir = path.posix.dirname(file) === "." ? "" : `${path.posix.dirname(file)}/`;
    const baseUrl =
      typeof options.baseUrl === "string"
        ? path.posix.join(dir || ".", options.baseUrl)
        : dir || ".";
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!pattern.endsWith("*") || !Array.isArray(targets)) continue;
      const mapped = targets
        .filter((t) => typeof t === "string" && t.endsWith("*"))
        .map((t) => {
          const joined = path.posix.join(baseUrl, t.slice(0, -1));
          return joined === "." ? "" : `${joined.replace(/\/$/, "")}/`;
        });
      if (mapped.length)
        aliases.push({ scope: dir, prefix: pattern.slice(0, -1), targets: mapped });
    }
  }
  return aliases;
}
function gitRunner(root) {
  return (args, input) =>
    execFileSync("git", args, {
      cwd: root,
      input,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
}
// `git cat-file --batch` answers "<oid> <type> <size>\n<bytes>\n" per request, or "<name> missing\n".
export function readBatch(output, names) {
  const texts = new Map();
  let at = 0;
  for (const name of names) {
    const nl = output.indexOf(10, at);
    if (nl < 0) break;
    const header = output.subarray(at, nl).toString("utf8");
    at = nl + 1;
    if (/ (missing|ambiguous)$/.test(header)) continue;
    const size = Number(header.slice(header.lastIndexOf(" ") + 1));
    texts.set(name, output.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return texts;
}
/** Files changed, production code that can feel them, and tests that reach them, for any repository. */
export function measureImpact({ root, range = "HEAD~1..HEAD", git = gitRunner(root) }) {
  if (typeof range !== "string" || !RANGE.test(range))
    throw new Error(`Not a range this tool will read: ${JSON.stringify(range)}`);
  const fullRange = range.includes("..") ? range : `${range}..HEAD`;
  const headRev = fullRange.split(/\.\.\.?/)[1];
  let head = "";
  try {
    head = git(["rev-parse", "--verify", "--quiet", `${headRev}^{commit}`])
      .toString("utf8")
      .trim();
  } catch {
    /* reported below */
  }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`No such commit: ${headRev}`);
  const status = git(["diff", "--name-status", "-z", "--no-renames", fullRange])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const changed = [];
  for (let i = 0; i + 1 < status.length; i += 2)
    changed.push({
      path: status[i + 1],
      status: status[i][0],
      ...classify(status[i + 1], status[i][0]),
    });
  // Every tracked JS/TS file at head, with its size so a generated bundle does not swamp the walk.
  const tree = git(["ls-tree", "-r", "-l", "-z", head])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t"),
        meta = line.slice(0, tab).split(/\s+/);
      return { path: line.slice(tab + 1), type: meta[1], size: Number(meta[3]) };
    })
    .filter((e) => e.type === "blob" && !e.path.includes("\n"));
  const skipped = tree
    .filter((e) => SOURCE.test(e.path) && e.size > MAX_SOURCE_BYTES)
    .map((e) => e.path);
  const files = tree
    .filter(
      (e) =>
        SOURCE.test(e.path) &&
        e.size <= MAX_SOURCE_BYTES &&
        !e.path.split("/").includes("node_modules"),
    )
    .map((e) => e.path)
    .sort();
  const configs = tree
    .filter(
      (e) =>
        path.posix.basename(e.path) === "tsconfig.json" &&
        !e.path.split("/").includes("node_modules"),
    )
    .map((e) => e.path);
  const wanted = [...files, ...configs];
  const texts = wanted.length
    ? readBatch(
        git(["cat-file", "--batch"], wanted.map((f) => `${head}:${f}`).join("\n") + "\n"),
        wanted,
      )
    : new Map();
  const aliases = aliasesFrom(configs.map((c) => ({ path: c, text: texts.get(c) ?? "" })));
  const graph = importGraph(files, (f) => texts.get(f) ?? "", { aliases });
  const source = changed.filter((c) => c.kind === "code" || c.kind === "test").map((c) => c.path);
  const code = changed.filter((c) => c.kind === "code").map((c) => c.path);
  const cover = coverage(graph, code);
  const byFile = new Map(cover.map((c) => [c.file, c.tests]));
  return {
    version: 1,
    range: fullRange,
    head,
    files: changed.map((c) => ({
      path: c.path,
      kind: c.kind,
      language: c.language,
      ...(c.kind === "code"
        ? {
            tests: byFile.get(c.path)?.length ?? 0,
            nearestTests: nearest(c.path, byFile.get(c.path) ?? []),
          }
        : {}),
    })),
    counts: {
      changed: changed.length,
      code: code.length,
      covered: cover.filter((c) => c.tests.length).length,
      tests: changed.filter((c) => c.kind === "test").length,
      notMeasured: changed.filter((c) => c.kind === "not-measured").length,
      deleted: changed.filter((c) => c.kind === "deleted").length,
      other: changed.filter((c) => c.kind === "other").length,
    },
    dependents: dependents(graph, source).filter((f) => !isTest(f)),
    notMeasured: changed
      .filter((c) => c.kind === "not-measured")
      .map((c) => ({ path: c.path, language: c.language })),
    skippedLargeFiles: skipped.length,
    limits: IMPACT_LIMITS,
  };
}
/** One sentence for a busy reader: "Touches 3 parts of the system and 14 files; 9 of the 14 are covered by tests." */
export function describeImpact(impact, parts = null) {
  const n = impact.counts.changed,
    { code, covered, notMeasured } = impact.counts;
  const files = `${n} file${n === 1 ? "" : "s"}`;
  let sentence =
    parts === null
      ? `Touches ${files}`
      : parts === 0
        ? `Touches ${files} and no part of the system`
        : `Touches ${parts} part${parts === 1 ? "" : "s"} of the system and ${files}`;
  // Small numbers read as words ("it is not covered"), not as arithmetic ("0 of the 1 are covered").
  if (code === 0)
    sentence +=
      n === 1
        ? "; it is not code that tests could cover"
        : "; none of them is code that tests could cover";
  else if (code === 1)
    sentence += `; ${n === 1 ? "it" : "the 1 code file"} is ${covered ? "" : "not "}covered by tests`;
  else {
    const of = code === n ? `${n}` : `${code} code files`;
    sentence +=
      covered === 0
        ? `; none of the ${of} are covered by tests`
        : `; ${covered} of the ${of} are covered by tests`;
  }
  sentence += ".";
  if (notMeasured)
    sentence += ` ${notMeasured} file${notMeasured === 1 ? " is" : "s are"} in another language and ${notMeasured === 1 ? "was" : "were"} not checked for tests.`;
  return sentence;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    flag = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? null : (args.splice(i, 2)[1] ?? "");
    };
  const json = args.includes("--json") ? (args.splice(args.indexOf("--json"), 1), true) : false;
  const repo = flag("--root");
  if (repo !== null) {
    // Any repository: `--root <repo> [--json] [range]`. Paths in the output are relative to <repo>.
    const impact = measureImpact({ root: path.resolve(repo), range: args[0] ?? "HEAD~1..HEAD" });
    process.stdout.write(
      json
        ? `${JSON.stringify(impact, null, 2)}\n`
        : [
            describeImpact(impact),
            "",
            "CAN FEEL THE CHANGE",
            bullet(impact.dependents, "(nothing else imports the changed code)"),
            "",
            "NOT MEASURED",
            bullet(
              impact.notMeasured.map((f) => `${f.path} (${f.language})`),
              "(none)",
            ),
            "",
            "WHAT THIS CANNOT SEE",
            bullet([...impact.limits], ""),
          ].join("\n") + "\n",
    );
  } else {
    const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url))),
      range = args[0] ?? "HEAD~1..HEAD";
    const files = sourceFiles(root);
    process.stdout.write(
      report({
        range,
        changed: changedFiles(range, root),
        graph: importGraph(files, (f) => {
          try {
            return fs.readFileSync(path.join(root, f), "utf8");
          } catch {
            return "";
          }
        }),
      }),
    );
  }
}
