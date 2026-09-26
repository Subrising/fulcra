import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

// The optional root installs only these real packages for a bounded canary.
// Normal repository runs resolve the actual overridden workspace dependencies.
const fixture = process.env.PASEO_DEPENDENCY_FIXTURE;
const require = createRequire(fixture ? path.join(fixture, "package.json") : import.meta.url);
const shell = require("shell-quote");
const tarConsumers = fixture
  ? [{ name: "fixture", tar: require("tar") }]
  : [
      "@expo/cli",
      "@electron/rebuild",
      "@mapbox/node-pre-gyp",
      "app-builder-lib",
      "cacache",
      "node-gyp",
      "eas-cli",
    ].map((name) => ({
      name,
      tar: createRequire(
        require.resolve(name === "@electron/rebuild" ? name : `${name}/package.json`),
      )("tar"),
    }));

test("shell arguments round-trip without evaluating their contents", () => {
  const values = ["", "two words", "it's", "$HOME; $(example)", "a\nb", "\\", '"quoted"', "🌊"];
  assert.deepEqual(shell.parse(shell.quote(values)), values);
  for (let i = 0; i < 128; i++) {
    const args = [values[i % values.length] + i, values[(i * 3) % values.length]];
    assert.deepEqual(shell.parse(shell.quote(args)), args);
  }
});

test("object tokens obey the documented operator boundary", () => {
  assert.deepEqual(shell.parse(shell.quote([{ op: ";" }])), [";"]);
  for (const value of [{}, { op: ";\nexample" }, { op: "\r" }, { comment: "x\ny" }]) {
    // @ts-expect-error Deliberately malformed external input exercises runtime validation.
    assert.throws(() => shell.quote([value]), TypeError);
  }
});

test("large plain argument lists preserve every token", { timeout: 3000 }, () => {
  const tokens = Array.from({ length: 16000 }, (_, i) => `item${i}`);
  assert.deepEqual(shell.parse(tokens.join(" ")), tokens);
});

test(
  "concurrently passes quoted string arguments to its real child",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-quoting-"));
    try {
      const script = path.join(dir, "args.cjs");
      await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const cli = path.join(
        path.dirname(require.resolve("concurrently/package.json")),
        "dist/bin/concurrently.js",
      );
      const command = shell.quote([process.execPath, script]) + " {@}";
      const args = ["two words", "O'Reilly"];
      const result = spawnSync(
        process.execPath,
        [cli, "--raw", "--passthrough-arguments", command, "--", ...args],
        {
          encoding: "utf8",
          timeout: 8000,
          maxBuffer: 65536,
          env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), args);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

for (const { name, tar } of tarConsumers) {
  test(`${name}: tar preserves stripping, member selection and stream extraction`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-archive-"));
    try {
      await mkdir(path.join(dir, "source/package"), { recursive: true });
      await mkdir(path.join(dir, "output"));
      await writeFile(path.join(dir, "source/package/keep.txt"), "expected contents");
      await writeFile(path.join(dir, "source/package/drop.txt"), "excluded");
      const file = path.join(dir, "fixture.tgz");
      await tar.create({ cwd: path.join(dir, "source"), file, gzip: true }, ["package"]);
      await tar.extract({ file, cwd: path.join(dir, "output"), strip: 1 }, ["package/keep.txt"]);
      assert.equal(await readFile(path.join(dir, "output/keep.txt"), "utf8"), "expected contents");
      await assert.rejects(stat(path.join(dir, "output/drop.txt")), { code: "ENOENT" });
      const output = path.join(dir, "stream-output");
      await mkdir(output);
      const entries = [];
      await pipeline(
        createReadStream(file),
        tar.extract({
          cwd: output,
          strip: 1,
          filter: (entry) => entry.endsWith("keep.txt"),
          onentry: (entry) => entries.push(entry.path),
        }),
      );
      assert.equal(await readFile(path.join(output, "keep.txt"), "utf8"), "expected contents");
      assert(entries.some((entry) => entry.endsWith("keep.txt")));
      await assert.rejects(stat(path.join(output, "drop.txt")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: tar rejects excessive decompression using a small bounded fixture`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-ratio-"));
    try {
      await mkdir(path.join(dir, "source"));
      await mkdir(path.join(dir, "output"));
      await writeFile(path.join(dir, "source/zeros"), Buffer.alloc(65536));
      const file = path.join(dir, "fixture.tgz");
      await tar.create({ cwd: path.join(dir, "source"), file, gzip: true }, ["zeros"]);
      await assert.rejects(
        tar.extract({ file, cwd: path.join(dir, "output"), maxDecompressionRatio: 2 }),
        /max decompression ratio exceeded/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: tar keeps traversal entries inside the disposable test boundary`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-traversal-"));
    try {
      await mkdir(path.join(dir, "output"));
      const header = new tar.Header({ path: "../escape.txt", size: 1, mode: 0o644, type: "File" });
      header.encode();
      const file = path.join(dir, "traversal.tar");
      await writeFile(
        file,
        Buffer.concat([header.block, Buffer.from("x"), Buffer.alloc(511 + 1024)]),
      );
      const warnings = [];
      await tar.extract({
        file,
        cwd: path.join(dir, "output"),
        onwarn: (_code, message) => warnings.push(message),
      });
      assert(warnings.some((message) => message.includes("..")));
      await assert.rejects(stat(path.join(dir, "escape.txt")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test(
  "browser provider commands enforce file permissions before touching the browser",
  { skip: Boolean(fixture) },
  async () => {
    const { PlaywrightBrowserProvider } = await import(
      pathToFileURL(require.resolve("@vitest/browser-playwright"))
    );
    const { resolveConfig } = await import(pathToFileURL(require.resolve("vite")));
    const boundary = await mkdtemp(path.join(tmpdir(), "paseo-browser-permissions-"));
    const root = path.join(boundary, "project");
    await mkdir(root);
    const outside = path.join(boundary, "outside.txt");
    const inside = path.join(root, "inside.txt");
    await writeFile(outside, "outside fixture");
    await writeFile(inside, "inside fixture");
    const config = await resolveConfig(
      { configFile: false, root, server: { fs: { strict: true, allow: [root] } } },
      "serve",
    );
    const commands = new Map();
    const project = {
      config: { root, browser: { name: "chromium", api: { allowWrite: false } } },
      vite: { config },
      vitest: { config: { api: { allowWrite: false } }, vite: { config } },
      browser: { registerCommand: (name, command) => commands.set(name, command) },
    };
    const provider = new PlaywrightBrowserProvider(project, {});
    const uploads = [];
    const context = {
      project,
      provider,
      testPath: path.join(root, "fixture.test.ts"),
      iframe: { locator: () => ({ setInputFiles: async (files) => uploads.push(files) }) },
    };
    try {
      await assert.rejects(
        commands.get("__vitest_upload")(context, "input", [outside]),
        /Access denied/,
      );
      assert.deepEqual(uploads, []);
      await commands.get("__vitest_upload")(context, "input", ["inside.txt"]);
      assert.deepEqual(uploads, [[inside]]);
      await assert.rejects(
        commands.get("__vitest_takeScreenshot")(context, "fixture", {
          save: true,
          path: path.join(root, "screenshot.png"),
        }),
        /File writing is disabled/,
      );
      await assert.rejects(
        commands.get("__vitest_deleteTracing")(context, { traces: [inside] }),
        /File writing is disabled/,
      );
      assert.equal(await readFile(inside, "utf8"), "inside fixture");
      project.config.browser.api.allowWrite = true;
      project.vitest.config.api.allowWrite = true;
      await assert.rejects(
        commands.get("__vitest_deleteTracing")(context, { traces: [outside] }),
        /Access denied/,
      );
      await commands.get("__vitest_deleteTracing")(context, { traces: [inside] });
      await assert.rejects(stat(inside), { code: "ENOENT" });
      assert.equal(await readFile(outside, "utf8"), "outside fixture");
    } finally {
      process.off("SIGTERM", provider.onSIGTERM);
      await rm(boundary, { recursive: true, force: true });
    }
  },
);
