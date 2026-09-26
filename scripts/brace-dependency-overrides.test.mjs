import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith("/brace-expansion"));
const examples = [
  [
    "src/{app,server}/file{01..03}.ts",
    [
      "src/app/file01.ts",
      "src/app/file02.ts",
      "src/app/file03.ts",
      "src/server/file01.ts",
      "src/server/file02.ts",
      "src/server/file03.ts",
    ],
  ],
  ["a{b,{c,d}}z", ["abz", "acz", "adz"]],
  ["file{3..1}.ts", ["file3.ts", "file2.ts", "file1.ts"]],
  ["x\\{a,b\\}", ["x{a,b}"]],
  ["${a,b}", ["${a,b}"]],
  ["", []],
];

function loadExpansion(directory) {
  const require = createRequire(path.join(directory, "package.json"));
  const module = require(directory);
  return typeof module === "function" ? module : module.expand;
}

// Children bound both CPU time and heap if a future update reintroduces a hang.
function boundedExpansion(directory, input, options = {}) {
  const script = `
    const { createRequire } = require('node:module');
    const path = require('node:path');
    const [directory, input, options] = JSON.parse(process.argv[1]);
    const load = createRequire(path.join(directory, 'package.json'));
    const module = load(directory);
    const expand = typeof module === 'function' ? module : module.expand;
    const values = expand(input, options);
    process.stdout.write(JSON.stringify({count: values.length,
      length: values.reduce((sum, value) => sum + value.length, 0),
      first: values.slice(0, 3), same: values.length === 1 && values[0] === input}));
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=96", "-e", script, JSON.stringify([directory, input, options])],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  assert.equal(
    result.status,
    0,
    `${result.error?.message ?? result.signal ?? ""}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

test("all installed brace copies preserve ordinary expansion and match the lock", () => {
  assert(copies.length > 0);
  for (const [name, metadata] of copies) {
    const directory = path.join(root, name);
    assert.equal(
      JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).version,
      metadata.version,
      name,
    );
    const expand = loadExpansion(directory);
    for (const [pattern, expected] of examples) assert.deepEqual(expand(pattern), expected, name);
  }
});

const representatives = new Map();
for (const [name, metadata] of copies) {
  const major = metadata.version.split(".")[0];
  if (!representatives.has(major)) representatives.set(major, path.join(root, name));
}
assert.deepEqual([...representatives.keys()].sort(), ["1", "2", "5"]);
for (const [major, directory] of representatives) {
  test(`brace${major} preserves generated small Cartesian products`, () => {
    const expand = loadExpansion(directory);
    for (let n = 1; n <= 128; n++) {
      assert.deepEqual(expand(`{a,b}${n}{x,y}`), [`a${n}x`, `a${n}y`, `b${n}x`, `b${n}y`]);
    }
  });
  test(`brace${major} treats zero step as one without looping`, () => {
    const result = boundedExpansion(directory, "{1..3..0}");
    assert.deepEqual(result.first, ["1", "2", "3"]);
    assert.equal(result.count, 3);
  });
  test(`brace${major} finishes consecutive non-expanding groups`, () => {
    assert.equal(boundedExpansion(directory, "a" + Array(30).fill("{}").join(",")).same, true);
  });
  test(`brace${major} bounds Cartesian result count`, () => {
    assert.equal(boundedExpansion(directory, "{a,b}".repeat(10), { max: 16 }).count, 16);
  });
  test(`brace${major} bounds accumulated output length`, () => {
    const result = boundedExpansion(directory, "prefix{a,b}".repeat(10), {
      max: 1000,
      maxLength: 128,
    });
    assert(result.length <= 128);
    assert(result.count > 0);
  });
  test(`brace${major} applies the default count ceiling`, () => {
    assert.equal(boundedExpansion(directory, "{1..100001}").count, 100000);
  });
  test(`brace${major} handles deep nesting within the configured depth`, () => {
    const result = boundedExpansion(directory, "{".repeat(1200) + "a,b" + "}".repeat(1200), {
      maxDepth: 8,
      maxLength: 10000,
    });
    assert.equal(result.same, true);
    assert(result.length <= 10000);
  });
}

test("every minimatch consumer preserves include, exclude and brace routing", () => {
  const consumers = Object.entries(lock.packages).filter(
    ([, value]) => value.dependencies?.["brace-expansion"],
  );
  assert(consumers.length > 0);
  for (const [name] of consumers) {
    assert(name.endsWith("/minimatch"), `Add behavior acceptance for new consumer ${name}`);
    const directory = path.join(root, name);
    const require = createRequire(path.join(directory, "package.json"));
    const module = require(directory);
    const minimatch = typeof module === "function" ? module : module.minimatch;
    assert.equal(minimatch("src/app/file01.ts", "src/{app,server}/file{01..03}.ts"), true, name);
    assert.equal(minimatch("src/other/file01.ts", "src/{app,server}/file{01..03}.ts"), false, name);
    assert.equal(minimatch("src/app/file01.ts", "!src/{app,server}/*.ts"), false, name);
    assert.equal(minimatch("src/app/.private.ts", "src/app/*.ts"), false, name);
  }
});

test("real glob consumers discover files with ordinary brace patterns", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-brace-glob-"));
  try {
    await mkdir(path.join(directory, "src/app"), { recursive: true });
    await mkdir(path.join(directory, "src/server"), { recursive: true });
    for (const file of ["src/app/a.ts", "src/app/b.js", "src/server/c.ts"]) {
      await writeFile(path.join(directory, file), "fixture");
    }
    const globCopies = Object.keys(lock.packages).filter((name) => name.endsWith("/glob"));
    assert(globCopies.length > 0);
    for (const name of globCopies) {
      const require = createRequire(path.join(root, name, "package.json"));
      const glob = require(path.join(root, name));
      const result = glob.sync("src/{app,server}/*.ts", { cwd: directory, ignore: "**/c.ts" });
      assert.deepEqual(result, ["src/app/a.ts"], name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
