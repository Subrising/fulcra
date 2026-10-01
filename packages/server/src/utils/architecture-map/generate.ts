import { createHash } from "node:crypto";
import path from "node:path";

// Generate a project's architecture map from its code at one commit (CHANGES, automatic maps). This is the
// TypeScript twin of the control repo's orca-architecture-map/generate.mjs (the agents' CLI and the validator's
// re-check); the two keep the same rules and the same test cases.
//
// The rules are deliberately simple so a reader can predict them (GENERATOR_RULES):
// - Parts are folders. Every package (a folder with a package.json and 3+ code files) starts as one part; the
//   part with the most non-test code is split into its sub-folders, largest first, until the map has about
//   `budget` parts. Test, tooling and sample folders are never parts of their own.
// - For a change, folders holding changed code are split first, so the picture is detailed where the change is.
// - Connections are import statements between parts, resolved relative to the file, by workspace package name or
//   by tsconfig paths. Tests never draw a connection. A connection is drawn when it carries MIN_CONNECTION_IMPORTS
//   imports or more, or when one of its imports starts or ends at a file the change edited.
// - Ownership: a file belongs to the part whose folder is the longest prefix of its path; everything else belongs
//   to "Other project files".
// - Identity is the folder path, so a part keeps its id across commits; both ends of a change are drawn with one
//   plan and one layout, so a part only appears or disappears when its code did.

export const GENERATOR_RULES = 1;
export const DEFAULT_BUDGET = 36;
export const MIN_CONNECTION_IMPORTS = 5;
export const OTHER_PART = "other-files";
const MIN_PART_CODE_FILES = 3;
const CODE = /\.(mjs|js|ts|tsx|cjs|mts|cts|jsx)$/;
const TEST = /\.test\.|\.spec\.|(^|\/)__tests__\//;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SUPPORT = new Set([
  "e2e",
  "test",
  "tests",
  "__tests__",
  "test-utils",
  "test-stubs",
  "testing",
  "fixtures",
  "__fixtures__",
  "mocks",
  "__mocks__",
  "scripts",
  "examples",
  "example",
  "plugin-examples",
  "stories",
  "docs",
  "benchmarks",
  "bench",
  "assets",
]);

export const isCode = (file: string) => CODE.test(file) && !file.endsWith(".d.ts");
export const isTest = (file: string) => TEST.test(file);
const dirOf = (file: string) => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
};
const under = (file: string, dir: string) =>
  dir === "" || file === dir || file.startsWith(`${dir}/`);
const isSupportPath = (dir: string) => dir.split("/").some((segment) => SUPPORT.has(segment));

export interface Snapshot {
  commit: string;
  files: { path: string; blob: string }[];
  /** Text of the files the generator parses (code, package.json, tsconfig.json). */
  texts: ReadonlyMap<string, string>;
}

interface PackageInfo {
  dir: string;
  name: string | null;
  aliases: { prefix: string; target: string }[];
}

export interface IrComponent {
  id: string;
  type: string;
  label: string;
  sublabel: string;
  tag: string;
  pos: [number, number];
  size: [number, number];
}

export interface GeneratedIr {
  schema_version: 1;
  diagram_type: "architecture";
  meta: { title: string; subtitle: string };
  components: IrComponent[];
  connections: { id: string; from: string; to: string }[];
  cards: { dot: string; title: string; items: string[] }[];
  generated: { by: string; rules: number; commit: string; planFrom: string[] };
  ownership: { part: string; folder: string }[];
}

export interface BuiltMap {
  ir: GeneratedIr;
  /** Every file -> the part that owns it. */
  owner: ReadonlyMap<string, string>;
  /** Code file -> repository files it imports ("<dir>/" for a workspace package without a pinned entry). */
  graph: ReadonlyMap<string, readonly string[]>;
  labels: ReadonlyMap<string, string>;
}

// ---- Packages and imports ----------------------------------------------------------------------------------------

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // tsconfig allows comments and trailing commas
  }
  try {
    return JSON.parse(
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1"),
    );
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function findPackages(snapshot: Snapshot): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  for (const [file, text] of snapshot.texts) {
    if (path.posix.basename(file) !== "package.json") continue;
    const name = asRecord(parseJson(text))?.name;
    packages.set(dirOf(file), {
      dir: dirOf(file),
      name: typeof name === "string" ? name : null,
      aliases: [],
    });
  }
  if (!packages.has("")) packages.set("", { dir: "", name: null, aliases: [] });
  for (const [file, text] of snapshot.texts) {
    if (path.posix.basename(file) !== "tsconfig.json") continue;
    const owner = packages.get(dirOf(file));
    const options = asRecord(asRecord(parseJson(text))?.compilerOptions);
    const paths = asRecord(options?.paths);
    if (!owner || !options || !paths) continue;
    const baseUrl = path.posix.join(
      dirOf(file),
      typeof options.baseUrl === "string" ? options.baseUrl : ".",
    );
    for (const [pattern, targets] of Object.entries(paths)) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== "string") continue;
      owner.aliases.push({
        prefix: pattern.replace(/\*$/, ""),
        target: path.posix.normalize(path.posix.join(baseUrl, target.replace(/\*$/, ""))),
      });
    }
  }
  return packages;
}

function packageOf(file: string, packages: ReadonlyMap<string, PackageInfo>): string {
  let best = "";
  for (const dir of packages.keys()) if (under(file, dir) && dir.length > best.length) best = dir;
  return best;
}

const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"'\n]+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+["']([^"'\n]+)["']/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** Module specifiers a file imports (comments removed first, so commented-out imports don't count). */
export function importSpecifiers(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Set<string>();
  for (const pattern of SPECIFIERS) for (const match of code.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function resolveFile(candidate: string, fileSet: ReadonlySet<string>): string | null {
  const clean = path.posix.normalize(candidate).replace(/^\.\//, "");
  if (clean.startsWith("..")) return null;
  if (fileSet.has(clean) && isCode(clean)) return clean;
  const stem = clean.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const ext of RESOLVE_EXTENSIONS) if (fileSet.has(stem + ext)) return stem + ext;
  for (const ext of RESOLVE_EXTENSIONS)
    if (fileSet.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
  return null;
}

/** The repository file an import points at, "<dir>/" for an unpinned workspace package, or null. */
export function resolveImport(
  from: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  packages: ReadonlyMap<string, PackageInfo>,
  byName: ReadonlyMap<string, string>,
): string | null {
  if (specifier.startsWith(".")) {
    return resolveFile(path.posix.join(dirOf(from), specifier), fileSet);
  }
  const own = packages.get(packageOf(from, packages));
  for (const alias of own?.aliases ?? []) {
    if (alias.prefix && specifier.startsWith(alias.prefix)) {
      const hit = resolveFile(
        path.posix.join(alias.target, specifier.slice(alias.prefix.length)),
        fileSet,
      );
      if (hit) return hit;
    }
  }
  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const name = scoped ? segments.slice(0, 2).join("/") : segments[0];
  const dir = byName.get(name);
  if (dir === undefined) return null;
  const rest = segments.slice(scoped ? 2 : 1).join("/");
  const join = (...parts: string[]) => path.posix.join(...parts.filter(Boolean));
  const tries = rest
    ? [join(dir, "src", rest), join(dir, rest)]
    : [join(dir, "src/index"), join(dir, "index"), join(dir, "src/main"), join(dir, "src")];
  for (const attempt of tries) {
    const hit = resolveFile(attempt, fileSet);
    if (hit) return hit;
  }
  return `${dir}/`;
}

export function importGraph(
  snapshot: Snapshot,
  packages: ReadonlyMap<string, PackageInfo> = findPackages(snapshot),
): Map<string, string[]> {
  const fileSet = new Set(snapshot.files.map((f) => f.path));
  const byName = new Map<string, string>();
  for (const p of packages.values()) if (p.name) byName.set(p.name, p.dir);
  const edges = new Map<string, string[]>();
  for (const { path: file } of snapshot.files) {
    if (!isCode(file)) continue;
    const targets = new Set<string>();
    for (const specifier of importSpecifiers(snapshot.texts.get(file) ?? "")) {
      const hit = resolveImport(file, specifier, fileSet, packages, byName);
      if (hit && hit !== file) targets.add(hit);
    }
    edges.set(file, [...targets].sort());
  }
  return edges;
}

// ---- The plan: which folders are parts ----------------------------------------------------------------------------

export function partId(dir: string): string {
  if (dir === "") return "root";
  const id = dir
    .replace(/\//g, ".")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  if (id.length <= 64) return id || "part";
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${id.slice(0, 55)}-${hash}`;
}

/** Which part folder owns a file: the longest one that contains it, or null. */
export function ownerOf(file: string, partDirs: Iterable<string>): string | null {
  let best: string | null = null;
  for (const dir of partDirs) {
    if (under(file, dir) && (best === null || dir.length > best.length)) best = dir;
  }
  return best;
}

const joinDir = (base: string, name: string) => (base ? `${base}/${name}` : name);
const firstSegment = (file: string, base: string) =>
  (base ? file.slice(base.length + 1) : file).split("/")[0];

/** Descend through a lone wrapper folder ("src") so the split is by meaningful folders. */
function splitBase(dir: string, mine: readonly string[]): string {
  let base = dir;
  for (;;) {
    const subs = new Set(mine.filter((f) => dirOf(f) !== base).map((f) => firstSegment(f, base)));
    if (subs.size !== 1 || mine.some((f) => dirOf(f) === base)) return base;
    base = joinDir(base, [...subs][0]);
  }
}

/** Sub-folders of `base` with how many of `mine` (and of the changed files) each holds. */
function childFolders(
  mine: readonly string[],
  base: string,
  hot: ReadonlySet<string>,
): Map<string, { n: number; hot: number }> {
  const children = new Map<string, { n: number; hot: number }>();
  for (const f of mine) {
    if (dirOf(f) === base) continue;
    const seg = firstSegment(f, base);
    if (SUPPORT.has(seg)) continue;
    const child = joinDir(base, seg);
    const c = children.get(child) ?? { n: 0, hot: 0 };
    c.n += 1;
    if (hot.has(f)) c.hot += 1;
    children.set(child, c);
  }
  return children;
}

export function planParts(
  codeFiles: Iterable<string>,
  packageDirs: Iterable<string>,
  budget = DEFAULT_BUDGET,
  focus: Iterable<string> = [],
): string[] {
  const files = [...new Set(codeFiles)].filter((f) => !isTest(f)).sort();
  const hot = new Set(focus);
  const dirs = new Set<string>([
    "",
    ...[...packageDirs].filter(
      (dir) =>
        dir !== "" &&
        !isSupportPath(dir) &&
        files.filter((f) => under(f, dir)).length >= MIN_PART_CODE_FILES,
    ),
  ]);
  const ownFiles = (dir: string) => files.filter((f) => ownerOf(f, dirs) === dir);
  if (ownFiles("").length === 0 && dirs.size > 1) dirs.delete("");
  const perSplit = Math.max(3, Math.floor(budget / 4));
  const done = new Set<string>();
  const heat = (list: string[]) => Math.sign(list.filter((f) => hot.has(f)).length);
  while (dirs.size < budget) {
    const next = [...dirs]
      .filter((d) => !done.has(d))
      .map((d) => [d, ownFiles(d)] as const)
      .filter(([, mine]) => mine.length >= MIN_PART_CODE_FILES * 2)
      .sort(
        (a, b) => heat(b[1]) - heat(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]),
      )[0];
    if (!next) break;
    const [dir, mine] = next;
    done.add(dir);
    const children = childFolders(mine, splitBase(dir, mine), hot);
    // Changed folders first (one file is enough), then the largest others.
    const ranked = [...children]
      .filter(([, c]) => c.hot > 0 || c.n >= MIN_PART_CODE_FILES)
      .sort(
        (x, y) =>
          Math.sign(y[1].hot) - Math.sign(x[1].hot) || y[1].n - x[1].n || x[0].localeCompare(y[0]),
      );
    const room = budget - dirs.size;
    const hotCount = ranked.filter(([, c]) => c.hot > 0).length;
    const take = ranked.slice(0, Math.max(0, Math.min(room, Math.max(perSplit, hotCount))));
    const left = mine.length - take.reduce((n, [, c]) => n + c.n, 0);
    if (take.length === 0 || (take.length === 1 && left < MIN_PART_CODE_FILES)) continue;
    for (const [child] of take) dirs.add(child);
    if (left === 0) dirs.delete(dir);
  }
  return [...dirs].sort();
}

// ---- Drawing ------------------------------------------------------------------------------------------------------

const TYPE_RULES: [RegExp, string][] = [
  [
    /(^|[/-])(app|apps|ui|web|client|frontend|components|screens|desktop|mobile|ios|android|panels|views?|pages)([/-]|$)/i,
    "frontend",
  ],
  [
    /(^|[/-])(db|database|store|stores|storage|migrations?|schema|sql|persistence)([/-]|$)/i,
    "database",
  ],
  [
    /(^|[/-])(relay|protocol|messages?|events?|queue|bus|transport|rpc|ws|socket)([/-]|$)/i,
    "messagebus",
  ],
  [/(^|[/-])(auth|security|crypto|permissions?|grants?|keys?|pairing)([/-]|$)/i, "security"],
  [
    /(^|[/-])(server|daemon|api|cli|service|services|control|runtime|backend|worker)([/-]|$)/i,
    "backend",
  ],
];
export const partType = (dir: string) => TYPE_RULES.find(([re]) => re.test(dir))?.[1] ?? "service";

function partLabel(dir: string, packages: ReadonlyMap<string, PackageInfo>): string {
  if (dir === "") return "Repository root";
  const pkg = packages.get(packageOf(dir, packages));
  const pkgName =
    pkg && pkg.dir !== ""
      ? (pkg.name ?? path.posix.basename(pkg.dir)).replace(/^@[^/]+\//, "")
      : null;
  const inside =
    pkg && pkg.dir !== "" ? dir.slice(pkg.dir.length).replace(/^\/?(src\/)?/, "") : dir;
  let label = inside;
  if (pkgName) label = inside ? `${pkgName} › ${inside}` : pkgName;
  return label.length > 120 ? `…${label.slice(-119)}` : label;
}

const NODE_W = 230;
const NODE_H = 66;
const GAP_X = 70;
const GAP_Y = 26;
const ORIGIN = 40;

/**
 * One column per package (wrapping when tall; small packages share a column), packages ordered by dependency
 * depth: what uses others on the left, what is used on the right. Pure geometry.
 */
export function layoutParts(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  groupOf: (id: string) => string,
): Map<string, [number, number]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(groupOf(id), [...(groups.get(groupOf(id)) ?? []), id]);
  const out = new Map([...groups.keys()].map((g) => [g, new Set<string>()]));
  for (const { from, to } of edges) {
    const a = groupOf(from);
    const b = groupOf(to);
    if (a !== b) out.get(a)?.add(b);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (g: string): number => {
    const known = depth.get(g);
    if (known !== undefined) return known;
    if (visiting.has(g)) return 0;
    visiting.add(g);
    let d = 0;
    for (const next of out.get(g) ?? []) d = Math.max(d, visit(next) + 1);
    visiting.delete(g);
    depth.set(g, d);
    return d;
  };
  [...groups.keys()].sort().forEach(visit);
  const order = [...groups.keys()].sort(
    (a, b) =>
      (depth.get(b) ?? 0) - (depth.get(a) ?? 0) ||
      (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0) ||
      a.localeCompare(b),
  );
  const maxRows = Math.max(5, Math.ceil(Math.sqrt(ids.length) * 1.4));
  const positions = new Map<string, [number, number]>();
  let x = ORIGIN;
  let y = ORIGIN;
  let rows = 0;
  for (const g of order) {
    const members = [...(groups.get(g) ?? [])].sort((a, b) => a.localeCompare(b));
    if (rows > 0 && rows + members.length > maxRows) {
      x += NODE_W + GAP_X;
      y = ORIGIN;
      rows = 0;
    }
    for (const id of members) {
      if (rows >= maxRows) {
        x += NODE_W + GAP_X;
        y = ORIGIN;
        rows = 0;
      }
      positions.set(id, [x, y]);
      y += NODE_H + GAP_Y;
      rows += 1;
    }
    y += GAP_Y;
  }
  return positions;
}

const connectionId = (from: string, to: string) => {
  const id = `${from}--${to}`;
  return id.length <= 64 ? id : `c-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
};

export interface BuildOptions {
  plan: readonly string[];
  title?: string;
  planFrom?: readonly string[];
  packages?: ReadonlyMap<string, PackageInfo>;
  focus?: readonly string[];
}

interface PartCounts {
  files: number;
  code: number;
  tests: number;
}

/** Which part owns every file, and how many files, code files and tests each part has. */
function ownership(
  snapshot: Snapshot,
  partDirs: readonly string[],
): { owner: Map<string, string>; counts: Map<string, PartCounts> } {
  const owner = new Map<string, string>();
  const counts = new Map<string, PartCounts>();
  for (const { path: file } of snapshot.files) {
    const dir = ownerOf(file, partDirs);
    // Non-code files at the root belong to "Other project files"; inside a part folder they are the part's.
    const id = dir === null || (dir === "" && !isCode(file)) ? OTHER_PART : partId(dir);
    owner.set(file, id);
    const c = counts.get(id) ?? { files: 0, code: 0, tests: 0 };
    c.files += 1;
    if (isCode(file) && isTest(file)) c.tests += 1;
    else if (isCode(file)) c.code += 1;
    counts.set(id, c);
  }
  return { owner, counts };
}

/** Import connections between parts: 5+ imports, or any import from or to an edited file. */
function partConnections(input: {
  graph: ReadonlyMap<string, readonly string[]>;
  owner: ReadonlyMap<string, string>;
  partDirs: readonly string[];
  hot: ReadonlySet<string>;
}): { id: string; from: string; to: string }[] {
  const { graph, owner, partDirs, hot } = input;
  const partFor = (target: string): string | null => {
    if (!target.endsWith("/")) return owner.get(target) ?? null;
    const dir = ownerOf(`${target}index.ts`, partDirs);
    return dir === null ? null : partId(dir);
  };
  const weights = new Map<string, number>();
  const hotEdges = new Set<string>();
  for (const [file, targets] of graph) {
    // Tests are coverage, not structure: they never draw a connection.
    if (isTest(file)) continue;
    const from = owner.get(file);
    for (const target of targets) {
      const to = partFor(target);
      if (!from || !to || from === to || from === OTHER_PART || to === OTHER_PART) continue;
      const key = `${from}\0${to}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
      if (hot.has(file) || hot.has(target)) hotEdges.add(key);
    }
  }
  return [...weights.keys()]
    .filter((key) => (weights.get(key) ?? 0) >= MIN_CONNECTION_IMPORTS || hotEdges.has(key))
    .sort()
    .map((key) => {
      const [from, to] = key.split("\0");
      return { id: connectionId(from, to), from, to };
    });
}

/** The map for one snapshot with a given plan, plus the file-level facts the blast radius uses. */
export function buildMap(snapshot: Snapshot, options: BuildOptions): BuiltMap {
  const packages = options.packages ?? findPackages(snapshot);
  const graph = importGraph(snapshot, packages);
  const partDirs = options.plan;
  const { owner, counts } = ownership(snapshot, partDirs);
  const ids = [...counts.keys()].filter((id) => id !== OTHER_PART).sort();
  const connections = partConnections({
    graph,
    owner,
    partDirs,
    hot: new Set(options.focus ?? []),
  });
  const dirById = new Map(partDirs.map((dir) => [partId(dir), dir]));
  const positions = layoutParts(ids, connections, (id) =>
    packageOf(dirById.get(id) ?? "", packages),
  );
  const labels = new Map<string, string>();
  const components: IrComponent[] = ids.map((id) => {
    const dir = dirById.get(id) ?? "";
    const c = counts.get(id) ?? { files: 0, code: 0, tests: 0 };
    const label = partLabel(dir, packages);
    labels.set(id, label);
    return {
      id,
      type: partType(dir),
      label,
      sublabel: (dir || ".").slice(-200),
      tag: `${c.code} code · ${c.tests} tests`,
      pos: positions.get(id) ?? [ORIGIN, ORIGIN],
      size: [NODE_W, NODE_H],
    };
  });
  const other = counts.get(OTHER_PART);
  if (other) {
    labels.set(OTHER_PART, "Other project files");
    const lastX = Math.max(ORIGIN, ...components.map((c) => c.pos[0]));
    const bottom = Math.max(
      ORIGIN - NODE_H - GAP_Y,
      ...components.filter((c) => c.pos[0] === lastX).map((c) => c.pos[1]),
    );
    components.push({
      id: OTHER_PART,
      type: "external",
      label: "Other project files",
      sublabel: "docs, config and scripts outside the parts",
      tag: `${other.files} files`,
      pos: [lastX, bottom + NODE_H + GAP_Y * 2],
      size: [NODE_W, NODE_H],
    });
  }
  const ir: GeneratedIr = {
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: (options.title ?? "Architecture").slice(0, 200),
      subtitle: `Automatically generated from the code at ${snapshot.commit.slice(0, 9)}: parts are folders, connections are imports; not deployed, no runtime observation`,
    },
    components,
    connections,
    cards: [
      {
        dot: "cyan",
        title: "Source",
        items: [
          `commit ${snapshot.commit}`,
          `generator rules v${GENERATOR_RULES}: folders as parts, imports as connections`,
          "automatically generated — read from git objects at that commit only",
        ],
      },
      {
        dot: "amber",
        title: "Bindings & limits",
        items: [
          "Connections are import statements as written, not observed traffic; no runtime acceptance, no live state.",
          "Only JavaScript/TypeScript imports are traced; other files count toward ownership only.",
          `A connection is drawn when it carries ${MIN_CONNECTION_IMPORTS}+ imports, or an import from or to a file the change edited.`,
          `${ids.length} parts; the folders with the most code (and any the change edited) were split first.`,
        ],
      },
    ],
    generated: {
      by: "fulcra-architecture-map",
      rules: GENERATOR_RULES,
      commit: snapshot.commit,
      planFrom: [...(options.planFrom ?? [snapshot.commit])],
    },
    ownership: ids.map((id) => ({ part: id, folder: dirById.get(id) ?? "" })),
  };
  return { ir, owner, graph, labels };
}

/** A map for one commit on its own. */
export function mapForSnapshot(
  snapshot: Snapshot,
  options: { budget?: number; title?: string } = {},
): BuiltMap {
  const packages = findPackages(snapshot);
  const plan = planParts(
    snapshot.files.map((f) => f.path).filter(isCode),
    packages.keys(),
    options.budget,
  );
  return buildMap(snapshot, { plan, title: options.title, packages });
}

/** Files that differ between two snapshots (added, removed or with different contents). */
export function changedBetween(before: Snapshot, after: Snapshot): string[] {
  const was = new Map(before.files.map((f) => [f.path, f.blob]));
  const now = new Map(after.files.map((f) => [f.path, f.blob]));
  const changed: string[] = [];
  for (const [file, blob] of now) if (was.get(file) !== blob) changed.push(file);
  for (const file of was.keys()) if (!now.has(file)) changed.push(file);
  return changed.sort();
}

export interface MapPair {
  before: BuiltMap;
  after: BuiltMap;
  plan: string[];
  changed: string[];
}

/** Before and After for a change: one plan (focused on what changed) and one layout for both ends. */
export function pairFromSnapshots(
  base: Snapshot,
  head: Snapshot,
  options: { budget?: number; title?: string } = {},
): MapPair {
  const bp = findPackages(base);
  const hp = findPackages(head);
  const changed = changedBetween(base, head);
  const code = [...base.files, ...head.files].map((f) => f.path).filter(isCode);
  const plan = planParts(code, new Set([...bp.keys(), ...hp.keys()]), options.budget, changed);
  const common = {
    plan,
    title: options.title,
    planFrom: [base.commit, head.commit],
    focus: changed,
  };
  const before = buildMap(base, { ...common, packages: bp });
  const after = buildMap(head, { ...common, packages: hp });
  // One layout over both ends, so nothing moves between Before and After and nothing overlaps.
  const allPackages = new Map([...bp, ...hp]);
  const dirById = new Map(plan.map((dir) => [partId(dir), dir]));
  const ids = [...new Set([...before.ir.components, ...after.ir.components].map((c) => c.id))]
    .filter((id) => id !== OTHER_PART)
    .sort();
  const edges = [...before.ir.connections, ...after.ir.connections];
  const positions = layoutParts(ids, edges, (id) => packageOf(dirById.get(id) ?? "", allPackages));
  const lastX = Math.max(ORIGIN, ...[...positions.values()].map(([x]) => x));
  const bottom = Math.max(
    ORIGIN - NODE_H - GAP_Y,
    ...[...positions.values()].filter(([x]) => x === lastX).map(([, y]) => y),
  );
  positions.set(OTHER_PART, [lastX, bottom + NODE_H + GAP_Y * 2]);
  for (const side of [before, after]) {
    for (const c of side.ir.components) c.pos = positions.get(c.id) ?? c.pos;
  }
  return { before, after, plan, changed };
}
