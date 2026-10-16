import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableTagsSince } from "./upstream-watch.mjs";

const script = fileURLToPath(new URL("./upstream-watch.mjs", import.meta.url));
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

test("stable tag selection keeps every newer version in numeric order", () => {
  const refs = [
    "v0.11.4",
    "v0.11.2",
    "v0.11.3",
    "v0.11.4^{}",
    "v0.11.4-beta.1",
    "v0.12.0",
    "v0.11.4",
  ]
    .map((tag) => `${"a".repeat(40)}\trefs/tags/${tag}`)
    .join("\n");
  assert.deepEqual(stableTagsSince(refs, "0.11.2"), ["v0.11.3", "v0.11.4", "v0.12.0"]);
  assert.deepEqual(stableTagsSince(refs, "0.12.0"), []);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-watch-"));
  const upstream = path.join(root, "upstream"),
    origin = path.join(root, "origin.git"),
    work = path.join(root, "work"),
    bin = path.join(root, "bin");
  const git = (cwd, ...args) =>
    execFileSync(realGit, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  fs.mkdirSync(upstream);
  fs.mkdirSync(bin);
  git(upstream, "init", "-b", "main");
  git(upstream, "config", "user.name", "Fulcra");
  git(upstream, "config", "user.email", "fulcra@users.noreply.github.com");
  fs.mkdirSync(path.join(upstream, ".github"));
  fs.writeFileSync(
    path.join(upstream, ".github/upstream-watch.json"),
    JSON.stringify({ upstreams: { paseo: { kind: "merge", repo: "fixture/upstream" } } }),
  );
  fs.writeFileSync(path.join(upstream, "package.json"), '{"version":"0.11.2"}\n');
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Fixture base");
  git(upstream, "tag", "v0.11.2");
  git(root, "clone", "--bare", upstream, origin);
  const commits = {};
  for (const version of ["0.11.3", "0.11.4"]) {
    fs.writeFileSync(path.join(upstream, "package.json"), JSON.stringify({ version }) + "\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", `Fixture ${version}`);
    git(upstream, "tag", "-a", `v${version}`, "-m", `Fixture ${version}`);
    commits[version] = git(upstream, "rev-parse", "HEAD");
  }
  git(root, "clone", origin, work);
  git(work, "remote", "add", "upstream", upstream);
  const state = path.join(root, "prs.json"),
    calls = path.join(root, "calls.jsonl");
  fs.writeFileSync(state, "[]");
  fs.writeFileSync(calls, "");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    WATCH_TEST_UPSTREAM: upstream,
    WATCH_TEST_GIT: realGit,
    WATCH_TEST_PRS: state,
    WATCH_TEST_CALLS: calls,
    WATCH_BASE_BRANCH: "main",
    WATCH_ORIGIN: "origin",
    GH_TOKEN: "synthetic-token",
    GITHUB_TOKEN: "synthetic-token",
    GITHUB_OUTPUT: path.join(root, "output"),
  };
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.WATCH_TEST_CALLS,JSON.stringify(['git',...a])+'\\n');if(a[0]==='ls-remote')a[a.length-1]=process.env.WATCH_TEST_UPSTREAM;process.stdout.write(execFileSync(process.env.WATCH_TEST_GIT,a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.WATCH_TEST_CALLS,JSON.stringify(['gh',...a])+'\\n');const file=process.env.WATCH_TEST_PRS;const prs=JSON.parse(fs.readFileSync(file,'utf8'));
if(a[0]==='api'){const tag=a[1].split('/').pop();console.log(JSON.stringify({body:'Fixture release',html_url:'https://example.invalid/'+tag}));}
else if(a[0]==='pr'&&a[1]==='list'){if(process.env.WATCH_TEST_REFUSE_LIST)process.exit(1);console.log(JSON.stringify(prs));}
else if(a[0]==='pr'&&a[1]==='create'){const get=k=>a[a.indexOf(k)+1];prs.push({number:prs.length+1,title:get('--title'),body:get('--body'),head:get('--head')});fs.writeFileSync(file,JSON.stringify(prs));console.log('https://example.invalid/pull/'+prs.length);}
else process.exit(2);
`,
    { mode: 0o755 },
  );
  return {
    root,
    work,
    origin,
    upstream,
    commits,
    state,
    calls,
    env,
    git,
    run(args = [], extra = {}) {
      return spawnSync(process.execPath, [script, "--only", "paseo", ...args], {
        cwd: work,
        env: { ...env, ...extra },
        encoding: "utf8",
      });
    },
    prs() {
      return JSON.parse(fs.readFileSync(state, "utf8"));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("each pending tag gets one PR, original ancestry, and no duplicate on a second pass", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      f.prs().map((pr) => pr.title),
      ["Sync paseo 0.11.3", "Sync paseo 0.11.4"],
    );
    for (const version of ["0.11.3", "0.11.4"]) {
      const head = f.git(f.origin, "rev-parse", `refs/heads/sync/paseo-${version}`);
      assert.equal(f.git(f.work, "rev-parse", `${head}^2`), f.commits[version]);
      assert.equal(
        f.git(f.work, "rev-parse", `refs/remotes/upstream/tags/v${version}^{commit}`),
        f.commits[version],
      );
    }
    const again = f.run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(f.prs().length, 2);
  } finally {
    f.cleanup();
  }
});

test("dry run reports both tags without commits, pushes, or PR creation", () => {
  const f = fixture();
  try {
    const before = f.git(f.work, "rev-parse", "HEAD");
    const result = f.run(["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would merge paseo v0\.11\.3/);
    assert.match(result.stdout, /would merge paseo v0\.11\.4/);
    assert.equal(f.git(f.work, "rev-parse", "HEAD"), before);
    assert.deepEqual(f.prs(), []);
    const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(
      calls.some(
        ([cmd, op]) => cmd === "git" && ["push", "checkout", "commit", "config"].includes(op),
      ),
      false,
    );
    assert.equal(
      calls.some(([cmd, op, sub]) => cmd === "gh" && op === "pr" && sub === "create"),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("large PR histories do not exceed the command output buffer", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      f.state,
      JSON.stringify([{ number: 99, title: "Unrelated PR", body: "x".repeat(2 * 1024 * 1024) }]),
    );
    const result = f.run(["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would merge paseo v0\.11\.3/);
    assert.match(result.stdout, /would merge paseo v0\.11\.4/);
    assert.equal(f.prs().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a manual intake marker covers both tags without relying on PR titles", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      f.state,
      JSON.stringify([
        {
          number: 7,
          title: "Upstream Paseo v0.11.4",
          body: "<!-- upstream-watch:paseo:v0.11.3 -->\n<!-- upstream-watch:paseo:v0.11.4 -->",
        },
      ]),
    );
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.prs().length, 1);
    assert.match(result.stdout, /PR #7 already covers this tag/);
  } finally {
    f.cleanup();
  }
});

test("PR enumeration failure refuses writes instead of opening a duplicate", () => {
  const f = fixture();
  try {
    const result = f.run([], { WATCH_TEST_REFUSE_LIST: "1" });
    assert.equal(result.status, 1);
    assert.deepEqual(f.prs(), []);
    assert.match(result.stderr, /pr list/);
  } finally {
    f.cleanup();
  }
});

test("dispatch dry runs use a read-only job while the writer checks out main", () => {
  const text = fs.readFileSync(
    new URL("../.github/workflows/upstream-watch.yml", import.meta.url),
    "utf8",
  );
  const dry = text.split("  dry-run:")[1].split("  watch:")[0];
  assert.match(dry, /contents: read/);
  assert.match(dry, /pull-requests: read/);
  assert.doesNotMatch(dry, /: write/);
  assert.match(dry, /persist-credentials: false/);
  assert.match(dry, /ref: \$\{\{ github.sha \}\}/);
  const writer = text.split("  watch:")[1].split("  verify:")[0];
  assert.match(writer, /ref: main/);
  assert.match(writer, /!inputs.dry_run/);
});
