#!/usr/bin/env node
// Generate a project's architecture map from its code at one commit (CHANGES, automatic maps).
//
// The rules are deliberately simple so a reader can predict them (GENERATOR_RULES):
// - Parts are folders. Every package (a folder with a package.json) starts as one part; the part with the most
//   code is split into its sub-folders, largest first, until the map has about `budget` parts. A folder with
//   too little code stays with its parent. Files directly in a split folder stay in the parent part.
// - Connections are import statements between parts (JavaScript/TypeScript `import`, `export … from`,
//   `import()` and `require()`), resolved relative to the file, by workspace package name or by tsconfig paths.
//   They are code references as written, never observed traffic.
// - Ownership: a file belongs to the part whose folder is the longest prefix of its path. Files outside every
//   code part (docs, config at the root) belong to "Other project files".
// - Identity is the folder path, so a part keeps its id across commits. For a pull request both ends are drawn
//   with ONE plan, made from the files at base and head together, so a part only appears or disappears when its
//   code did, and nothing moves on the page between Before and After.
//
// Everything is read from git objects (`git ls-tree`, `git cat-file --batch`) at a full commit id: the working
// copy, uncommitted edits and the network are never used. The output is Architecture IR v1 (validate.mjs) plus
// two fields the renderer ignores: `generated` (commit, rules, plan) and `ownership` (part -> folder prefixes).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GENERATOR_RULES = 1;
export const DEFAULT_BUDGET = 36;
const MIN_PART_CODE_FILES = 3;
// A connection is drawn when it carries at least this many imports, or when one of its imports starts or ends at a
// file the change edited.
export const MIN_CONNECTION_IMPORTS = 5;
const MAX_PARSE_BYTES = 512 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;
const CODE = /\.(mjs|js|ts|tsx|cjs|mts|cts|jsx)$/;
const TEST = /\.test\.|\.spec\.|(^|\/)__tests__\//;
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".expo",
  "vendor",
  ".git",
  ".turbo",
  ".cache",
]);
export const OTHER = "other-files";
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export const isCode = (file) => CODE.test(file) && !file.endsWith(".d.ts");
export const isTest = (file) => TEST.test(file);
const ignored = (file) => file.split("/").some((segment) => IGNORED_DIRS.has(segment));
const dirOf = (file) => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
};
const under = (file, dir) => dir === "" || file === dir || file.startsWith(`${dir}/`);

// ---- Reading a commit ------------------------------------------------------------------------------------------

const git = (root, args, input) => {
  const out = spawnSync("git", args, {
    cwd: root,
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (out.status !== 0)
    throw new Error(`git ${args[0]} failed: ${String(out.stderr).trim().split("\n")[0]}`);
  return out.stdout;
};

/** Every tracked file at `commit` as { path, blob, size }, read from git objects only. */
export function listCommitFiles(root, commit) {
  if (!COMMIT.test(commit)) throw new Error("A full commit id is required");
  const raw = git(root, ["ls-tree", "-r", "-z", "--long", "--full-tree", commit]).toString("utf8");
  const files = [];
  for (const entry of raw.split("\0")) {
    // "<mode> blob <oid> <size>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, blob, size] = entry.slice(0, tab).trim().split(/\s+/);
    if (type !== "blob" || mode === "120000") continue;
    files.push({ path: entry.slice(tab + 1), blob, size: Number(size) || 0 });
  }
  return files;
}

/** The contents of many blobs in one `git cat-file --batch` call. */
export function readBlobs(root, blobs) {
  const unique = [...new Set(blobs)];
  const found = new Map();
  if (unique.length === 0) return found;
  const out = git(root, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let at = 0;
  while (at < out.length) {
    const newline = out.indexOf(10, at);
    if (newline < 0) break;
    const header = out.subarray(at, newline).toString("utf8").split(" ");
    at = newline + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    found.set(header[0], out.subarray(at, at + size));
    at += size + 1;
  }
  return found;
}

/** A commit as the generator sees it: its files and a text reader for the ones it parses. */
export function readCommit(root, commit) {
  const files = listCommitFiles(root, commit).filter((f) => !ignored(f.path));
  const wanted = files.filter(
    (f) =>
      f.size <= MAX_PARSE_BYTES &&
      (isCode(f.path) || /(^|\/)(package|tsconfig)\.json$/.test(f.path)),
  );
  const blobs = readBlobs(
    root,
    wanted.map((f) => f.blob),
  );
  const texts = new Map(wanted.map((f) => [f.path, blobs.get(f.blob)?.toString("utf8") ?? ""]));
  return { commit, files: files.map((f) => ({ path: f.path, blob: f.blob })), texts };
}

// ---- Packages and imports ---------------------------------------------------------------------------------------

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    /* tsconfig allows comments and trailing commas */
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
};

/** Folders with a package.json, with their package name and tsconfig path aliases. */
export function findPackages(snapshot) {
  const packages = new Map();
  for (const [file, text] of snapshot.texts) {
    const name = path.posix.basename(file);
    if (name !== "package.json") continue;
    const json = parseJson(text);
    packages.set(dirOf(file), {
      dir: dirOf(file),
      name: typeof json?.name === "string" ? json.name : null,
      aliases: [],
    });
  }
  if (!packages.has("")) packages.set("", { dir: "", name: null, aliases: [] });
  for (const [file, text] of snapshot.texts) {
    if (path.posix.basename(file) !== "tsconfig.json") continue;
    const owner = packages.get(dirOf(file));
    const options = parseJson(text)?.compilerOptions;
    if (!owner || !options || typeof options.paths !== "object" || options.paths === null) continue;
    const baseUrl = path.posix.join(
      dirOf(file),
      typeof options.baseUrl === "string" ? options.baseUrl : ".",
    );
    for (const [pattern, targets] of Object.entries(options.paths)) {
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

const packageOf = (file, packages) => {
  let best = "";
  for (const dir of packages.keys()) if (under(file, dir) && dir.length > best.length) best = dir;
  return best;
};

const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"'\n]+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+["']([^"'\n]+)["']/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** Module specifiers a file imports (comments removed first, so commented-out imports don't count). */
export function importSpecifiers(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Set();
  for (const pattern of SPECIFIERS) for (const match of code.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function resolveFile(candidate, fileSet) {
  const clean = path.posix.normalize(candidate).replace(/^\.\//, "");
  if (clean.startsWith("..")) return null;
  if (fileSet.has(clean) && isCode(clean)) return clean;
  const stem = clean.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const ext of RESOLVE_EXTENSIONS) if (fileSet.has(stem + ext)) return stem + ext;
  for (const ext of RESOLVE_EXTENSIONS)
    if (fileSet.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
  return null;
}

/** The repository file an import points at, or null for a third-party module / unresolved path. */
export function resolveImport(from, specifier, fileSet, packages, byName) {
  if (specifier.startsWith("."))
    return resolveFile(path.posix.join(dirOf(from), specifier), fileSet);
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
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = byName.get(name);
  if (dir === undefined) return null;
  const rest = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
  const join = (...p) => path.posix.join(...p.filter(Boolean));
  const tries = rest
    ? [join(dir, "src", rest), join(dir, rest)]
    : [join(dir, "src/index"), join(dir, "index"), join(dir, "src/main"), join(dir, "src")];
  for (const t of tries) {
    const hit = resolveFile(t, fileSet);
    if (hit) return hit;
  }
  // A workspace package whose entry file we can't pin still counts as a reference to that package.
  return { package: dir };
}

/** File-level import graph: code file -> repository files (or package folders) it imports. */
export function importGraph(snapshot, packages = findPackages(snapshot)) {
  const fileSet = new Set(snapshot.files.map((f) => f.path));
  const byName = new Map([...packages.values()].filter((p) => p.name).map((p) => [p.name, p.dir]));
  const edges = new Map();
  for (const { path: file } of snapshot.files) {
    if (!isCode(file)) continue;
    const targets = new Set();
    for (const specifier of importSpecifiers(snapshot.texts.get(file) ?? "")) {
      const hit = resolveImport(file, specifier, fileSet, packages, byName);
      if (typeof hit === "string" && hit !== file) targets.add(hit);
      else if (hit && typeof hit === "object") targets.add(`${hit.package}/`);
    }
    edges.set(file, [...targets].sort());
  }
  return edges;
}

// ---- The plan: which folders are parts --------------------------------------------------------------------------

export function partId(dir) {
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

// Folders that hold tests, tooling or samples. They are never parts of their own: their files stay with the part
// around them, so the budget is spent on the product's own structure.
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
const isSupportPath = (dir) => dir.split("/").some((segment) => SUPPORT.has(segment));
const deepestIn = (file, dirs) => {
  let best = null;
  for (const d of dirs) if (under(file, d) && (best === null || d.length > best.length)) best = d;
  return best;
};

/**
 * Choose the part folders for a set of code file paths (from one commit, or from base and head together).
 * Size is non-test code. With `focus` (the files a change touched), folders holding changed code are split first
 * and further, so the picture is detailed where the change is and coarse elsewhere. Deterministic: the same
 * files and focus always give the same plan.
 */
export function planParts(codeFiles, packageDirs, budget = DEFAULT_BUDGET, focus = []) {
  const files = [...new Set(codeFiles)].filter((f) => !isTest(f)).sort();
  const hot = new Set(focus);
  const dirs = new Set([
    "",
    ...[...packageDirs].filter(
      (dir) =>
        dir !== "" &&
        !isSupportPath(dir) &&
        files.filter((f) => under(f, dir)).length >= MIN_PART_CODE_FILES,
    ),
  ]);
  const ownFiles = (dir) => files.filter((f) => deepestIn(f, dirs) === dir);
  if (ownFiles("").length === 0 && dirs.size > 1) dirs.delete("");
  const perSplit = Math.max(3, Math.floor(budget / 4));
  const done = new Set();
  const heat = (list) => list.filter((f) => hot.has(f)).length;
  while (dirs.size < budget) {
    const next = [...dirs]
      .filter((d) => !done.has(d))
      .map((d) => [d, ownFiles(d)])
      .filter(([, mine]) => mine.length >= MIN_PART_CODE_FILES * 2)
      .sort(
        (a, b) =>
          Math.sign(heat(b[1])) - Math.sign(heat(a[1])) ||
          b[1].length - a[1].length ||
          a[0].localeCompare(b[0]),
      )[0];
    if (!next) break;
    const [dir, mine] = next;
    done.add(dir);
    // Descend through a lone wrapper folder ("src") so the split is by meaningful folders.
    let base = dir;
    for (;;) {
      const subs = new Set(
        mine
          .filter((f) => dirOf(f) !== base)
          .map((f) => (base ? f.slice(base.length + 1) : f).split("/")[0]),
      );
      if (subs.size === 1 && !mine.some((f) => dirOf(f) === base))
        base = base ? `${base}/${[...subs][0]}` : [...subs][0];
      else break;
    }
    const children = new Map();
    for (const f of mine) {
      if (dirOf(f) === base) continue;
      const seg = (base ? f.slice(base.length + 1) : f).split("/")[0];
      if (SUPPORT.has(seg)) continue;
      const child = base ? `${base}/${seg}` : seg;
      const c = children.get(child) ?? { n: 0, hot: 0 };
      c.n += 1;
      if (hot.has(f)) c.hot += 1;
      children.set(child, c);
    }
    // Changed folders first (any size of one file or more), then the largest others.
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

// ---- Drawing -----------------------------------------------------------------------------------------------------

const TYPE_RULES = [
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
export const partType = (dir) => TYPE_RULES.find(([re]) => re.test(dir))?.[1] ?? "service";

function partLabel(dir, packages) {
  if (dir === "") return "Repository root";
  const pkg = packages.get(packageOf(dir, packages));
  const pkgName =
    pkg && pkg.dir !== ""
      ? (pkg.name ?? path.posix.basename(pkg.dir)).replace(/^@[^/]+\//, "")
      : null;
  const inside =
    pkg && pkg.dir !== "" ? dir.slice(pkg.dir.length).replace(/^\/?(src\/)?/, "") : dir;
  const label = pkgName ? (inside ? `${pkgName} › ${inside}` : pkgName) : inside;
  return label.length > 120 ? `…${label.slice(-119)}` : label;
}

const NODE_W = 230,
  NODE_H = 66,
  GAP_X = 70,
  GAP_Y = 26,
  ORIGIN = 40;

/**
 * One column per package (wrapping when tall), packages ordered by dependency depth: what uses others on the left,
 * what is used on the right. Pure geometry, from the plan and the connections.
 */
function layoutParts(ids, edges, groupOf) {
  const groups = new Map();
  for (const id of ids) groups.set(groupOf(id), [...(groups.get(groupOf(id)) ?? []), id]);
  const out = new Map([...groups.keys()].map((g) => [g, new Set()]));
  for (const { from, to } of edges) {
    const a = groupOf(from),
      b = groupOf(to);
    if (a !== b) out.get(a)?.add(b);
  }
  const depth = new Map(),
    visiting = new Set();
  const visit = (g) => {
    if (depth.has(g)) return depth.get(g);
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
      depth.get(b) - depth.get(a) ||
      groups.get(b).length - groups.get(a).length ||
      a.localeCompare(b),
  );
  const maxRows = Math.max(5, Math.ceil(Math.sqrt(ids.length) * 1.4));
  const positions = new Map();
  let x = ORIGIN,
    y = ORIGIN,
    colHeight = 0;
  // Small packages share a column (stacked) so the page stays roughly square.
  for (const g of order) {
    const members = [...groups.get(g)].sort((a, b) => a.localeCompare(b));
    if (colHeight > 0 && colHeight + members.length > maxRows) {
      x += NODE_W + GAP_X;
      y = ORIGIN;
      colHeight = 0;
    }
    for (const id of members) {
      if (colHeight >= maxRows) {
        x += NODE_W + GAP_X;
        y = ORIGIN;
        colHeight = 0;
      }
      positions.set(id, [x, y]);
      y += NODE_H + GAP_Y;
      colHeight += 1;
    }
    y += GAP_Y;
  }
  return positions;
}

const connectionId = (from, to) => {
  const id = `${from}--${to}`;
  return id.length <= 64 ? id : `c-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
};

/** Which part owns a file: the longest part folder that contains it, or "other files". */
export function ownerOf(file, partDirs) {
  let best = null;
  for (const dir of partDirs)
    if (under(file, dir) && (best === null || dir.length > best.length)) best = dir;
  return best;
}

/**
 * Build the map for one snapshot with a given plan. Returns the IR and the file-level facts (owner of every file,
 * the import graph) that the change view's blast radius uses.
 */
export function buildMap(
  snapshot,
  { plan, title, planFrom = [snapshot.commit], packages = findPackages(snapshot), focus = [] },
) {
  const graph = importGraph(snapshot, packages);
  const partDirs = plan;
  const owner = new Map();
  const counts = new Map();
  for (const { path: file } of snapshot.files) {
    const dir = ownerOf(file, partDirs);
    // Non-code files at the root belong to "Other project files"; inside a part folder they are the part's.
    const id = dir === null || (dir === "" && !isCode(file)) ? OTHER : partId(dir);
    owner.set(file, id);
    const c = counts.get(id) ?? { files: 0, code: 0, tests: 0 };
    c.files += 1;
    if (isCode(file)) isTest(file) ? c.tests++ : c.code++;
    counts.set(id, c);
  }
  const partFor = (target) => {
    if (!target.endsWith("/")) return owner.get(target) ?? null;
    const d = ownerOf(`${target}index.ts`, partDirs);
    return d === null ? null : partId(d);
  };
  const weights = new Map();
  const hotEdges = new Set();
  const hot = new Set(focus);
  for (const [file, targets] of graph) {
    // Tests are coverage, not structure: they never draw a connection.
    if (isTest(file)) continue;
    const from = owner.get(file);
    for (const target of targets) {
      const to = partFor(target);
      if (!from || !to || from === to || from === OTHER || to === OTHER) continue;
      const key = `${from}\0${to}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
      if (hot.has(file) || hot.has(target)) hotEdges.add(key);
    }
  }
  const ids = [...counts.keys()].filter((id) => id !== OTHER).sort();
  const drawn = (key) => weights.get(key) >= MIN_CONNECTION_IMPORTS || hotEdges.has(key);
  const connections = [...weights.keys()]
    .filter(drawn)
    .sort()
    .map((key) => {
      const [from, to] = key.split("\0");
      return { id: connectionId(from, to), from, to };
    });
  const dirById = new Map(partDirs.map((dir) => [partId(dir), dir]));
  const positions = layoutParts(ids, connections, (id) =>
    packageOf(dirById.get(id) ?? "", packages),
  );
  const components = ids.map((id) => {
    const dir = dirById.get(id) ?? "";
    const c = counts.get(id);
    return {
      id,
      type: partType(dir),
      label: partLabel(dir, packages),
      sublabel: (dir || ".").slice(-200),
      tag: `${c.code} code · ${c.tests} tests`,
      pos: positions.get(id),
      size: [NODE_W, NODE_H],
    };
  });
  if (counts.has(OTHER)) {
    const lastX = Math.max(ORIGIN, ...components.map((c) => c.pos[0]));
    const bottom = Math.max(
      ORIGIN - NODE_H - GAP_Y,
      ...components.filter((c) => c.pos[0] === lastX).map((c) => c.pos[1]),
    );
    components.push({
      id: OTHER,
      type: "external",
      label: "Other project files",
      sublabel: "docs, config and scripts outside the parts",
      tag: `${counts.get(OTHER).files} files`,
      pos: [lastX, bottom + NODE_H + GAP_Y * 2],
      size: [NODE_W, NODE_H],
    });
  }
  const short = snapshot.commit.slice(0, 9);
  const ir = {
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: (title ?? "Architecture").slice(0, 200),
      subtitle: `Automatically generated from the code at ${short}: parts are folders, connections are imports; not deployed, no runtime observation`,
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
      planFrom: [...planFrom],
    },
    ownership: ids.map((id) => ({ part: id, folder: dirById.get(id) ?? "" })),
  };
  return { ir, owner, graph, packages };
}

/** A map for one commit on its own (on demand). */
export function generateAtCommit(root, commit, { budget = DEFAULT_BUDGET, title } = {}) {
  const snapshot = readCommit(root, commit);
  const packages = findPackages(snapshot);
  const plan = planParts(snapshot.files.map((f) => f.path).filter(isCode), packages.keys(), budget);
  return buildMap(snapshot, { plan, title, packages });
}

/** Files that differ between two snapshots (added, removed or with different contents). */
export function changedBetween(before, after) {
  const was = new Map(before.files.map((f) => [f.path, f.blob]));
  const now = new Map(after.files.map((f) => [f.path, f.blob]));
  const changed = [];
  for (const [file, blob] of now) if (was.get(file) !== blob) changed.push(file);
  for (const file of was.keys()) if (!now.has(file)) changed.push(file);
  return changed.sort();
}

/** Before and After for a change: one plan from both ends (focused on what changed), so ids and positions line up. */
export function generatePair(root, base, head, { budget = DEFAULT_BUDGET, title } = {}) {
  const b = readCommit(root, base);
  const h = readCommit(root, head);
  return pairFromSnapshots(b, h, { budget, title });
}

export function pairFromSnapshots(b, h, { budget = DEFAULT_BUDGET, title } = {}) {
  const bp = findPackages(b),
    hp = findPackages(h);
  const changed = changedBetween(b, h);
  const code = [...b.files, ...h.files].map((f) => f.path).filter(isCode);
  const plan = planParts(code, new Set([...bp.keys(), ...hp.keys()]), budget, changed);
  const planFrom = [b.commit, h.commit];
  const before = buildMap(b, { plan, title, planFrom, packages: bp, focus: changed });
  const after = buildMap(h, { plan, title, planFrom, packages: hp, focus: changed });
  // One layout over both ends, so nothing moves between Before and After and nothing overlaps.
  const allPackages = new Map([...bp, ...hp]);
  const dirById = new Map(plan.map((dir) => [partId(dir), dir]));
  const ids = [...new Set([...before.ir.components, ...after.ir.components].map((c) => c.id))]
    .filter((id) => id !== OTHER)
    .sort();
  const positions = layoutParts(ids, [...before.ir.connections, ...after.ir.connections], (id) =>
    packageOf(dirById.get(id) ?? "", allPackages),
  );
  const lastX = Math.max(ORIGIN, ...[...positions.values()].map(([x]) => x));
  const bottom = Math.max(
    ORIGIN - NODE_H - GAP_Y,
    ...[...positions.values()].filter(([x]) => x === lastX).map(([, y]) => y),
  );
  positions.set(OTHER, [lastX, bottom + NODE_H + GAP_Y * 2]);
  for (const side of [before, after])
    for (const c of side.ir.components) c.pos = positions.get(c.id) ?? c.pos;
  return { before, after, plan, changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const writeAt = args.indexOf("--write");
  const writeName = writeAt < 0 ? null : args.splice(writeAt, 2)[1];
  const [root, commit, head] = args.filter((a) => !a.startsWith("--"));
  if (
    !root ||
    !commit ||
    (writeName !== null && (head || !/^[a-z0-9][a-z0-9_-]{0,60}$/.test(writeName ?? "")))
  ) {
    console.error(
      "usage: node generate.mjs <repo> <commit> [<head commit>]   (prints the IR; with two commits, {before, after})\n       node generate.mjs <repo> <commit> --write <name>   (writes .fulcra/architecture/<name>.ir.json)",
    );
    process.exit(2);
  }
  if (writeName !== null) {
    const rev = git(root, ["rev-parse", "--verify", `${commit}^{commit}`])
      .toString("utf8")
      .trim();
    const ir = generateAtCommit(root, rev).ir;
    const dir = path.join(root, ".fulcra", "architecture");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${writeName}.ir.json`), `${JSON.stringify(ir, null, 2)}\n`);
    console.log(
      `.fulcra/architecture/${writeName}.ir.json: ${ir.components.length} parts, ${ir.connections.length} connections, commit ${rev}`,
    );
    process.exit(0);
  }
  try {
    const rev = (r) =>
      git(root, ["rev-parse", "--verify", `${r}^{commit}`])
        .toString("utf8")
        .trim();
    const out = head
      ? (({ before, after }) => ({ before: before.ir, after: after.ir }))(
          generatePair(root, rev(commit), rev(head)),
        )
      : generateAtCommit(root, rev(commit)).ir;
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
