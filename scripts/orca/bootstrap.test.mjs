import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  initHome,
  cleanEnvironment,
  task,
  appLaunchEnvironment,
  resolveNativeApp,
  nativeHandoffReport,
  open,
  shellQuote,
} from "./bootstrap.mjs";

test("fresh home has independent identities, private isolated data and no inherited credentials", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "orca-setup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = initHome(path.join(root, "space and 'quote"), 53421),
    other = initHome(path.join(root, "other"), 53422);
  const read = (h, f) => JSON.parse(fs.readFileSync(path.join(h, f)));
  const config = read(home, "config.json"),
    second = read(other, "config.json");
  assert.notEqual(config.authority.programmeId, second.authority.programmeId);
  assert.equal(config.hosts.macbook, null);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(home, "daemon/controller.secret"), "utf8"), /^[\w-]{43}$/);
  assert.deepEqual(fs.readdirSync(path.join(home, "memory")), ["history"]);
  const env = cleanEnvironment(home, {
    ORCA_BOOK_TRANSPORT_PROFILE: "/private",
    PASEO_HOME: "/live",
    PASEO_PASSWORD: "fake-old-password",
    EXPO_PUBLIC_LOCAL_DAEMON: "other",
    ANTHROPIC_API_KEY: "fake-local-only",
  });
  assert.equal(env.PASEO_PASSWORD, undefined);
  assert.equal(env.ORCA_BOOK_TRANSPORT_PROFILE, undefined);
  assert.equal(env.PASEO_HOME, path.join(home, "daemon"));
  assert.ok(!JSON.stringify(config).includes("fake-local-only"));
  const project = task(home, "add", "My actual project"),
    item = task(home, "add", "Implement actual outcome", project.id);
  assert.equal(item.parentId, project.id);
  assert.equal(task(home, "close", item.id).status, "done");
  assert.equal(task(home, "reopen", item.id).status, "in_progress");
  const before = fs.readFileSync(path.join(home, "tasks.json"));
  assert.throws(() => initHome(home), { code: "EEXIST" });
  assert.deepEqual(fs.readFileSync(path.join(home, "tasks.json")), before);
  const link = path.join(root, "alias");
  fs.symlinkSync(home, link);
  assert.throws(() => initHome(link), { code: "EEXIST" });
  const empty = path.join(root, "existing-empty");
  fs.mkdirSync(empty);
  assert.throws(() => initHome(empty), { code: "EEXIST" });
  assert.throws(() => initHome(path.join(root, "bad"), 80), /Port/);
  assert.equal(fs.existsSync(path.join(root, "bad")), false);
});

test("native handoff prefers the installed app, never leaks the portable home or password", () => {
  const installed = "/Applications/Orca.app";
  const app = resolveNativeApp({
    platform: "darwin",
    exists: (candidate) => candidate === installed,
    registered: () => assert.fail("launch database should not be consulted once the bundle exists"),
    home: "/Users/someone",
  });
  assert.deepEqual(app, {
    found: true,
    path: installed,
    candidates: [installed, "/Users/someone/Applications/Orca.app"],
  });
  // A home is a user-chosen path. The printed copy command must survive every character a
  // shell would otherwise expand, so paste it back through sh and compare.
  const passwordFile = '/tmp/o\'rca $HOME `whoami` "x"/daemon/controller.secret';
  const report = nativeHandoffReport({
    app,
    url: "http://127.0.0.1:6791",
    port: 6791,
    passwordFile,
  });
  assert.match(report, /Opening the installed Orca app \(\/Applications\/Orca\.app\)/);
  // Wording tracks the app's own labels; see the comment in nativeHandoffReport.
  assert.match(report, /Settings -> Host -> Add host -> Direct connection/);
  assert.match(report, /Host 127\.0\.0\.1, Port 6791/);
  assert.match(report, /relay is|relay disabled/);
  assert.ok(report.includes(passwordFile));
  assert.ok(!report.includes("secret-value"));
  assert.match(report, /Browser fallback: http:\/\/127\.0\.0\.1:6791/);
  const copyLine = report.split("\n").find((line) => line.includes("pbcopy"));
  const quoted = copyLine.slice(copyLine.indexOf("pbcopy < ") + "pbcopy < ".length);
  const echoed = spawnSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
  assert.equal(echoed.status, 0);
  assert.equal(echoed.stdout, passwordFile);
  assert.equal(
    spawnSync("sh", ["-c", `printf %s ${shellQuote("a'b$c`d\"e f")}`], { encoding: "utf8" }).stdout,
    "a'b$c`d\"e f",
  );
  // A cold app launch inherits this environment; the portable home must not travel with it.
  const launch = appLaunchEnvironment({
    PASEO_HOME: "/private/home/daemon",
    ORCA_HOME: "/private/home",
    EXPO_PUBLIC_LOCAL_DAEMON: "portable",
    PATH: "/usr/bin",
  });
  assert.deepEqual(launch, { PATH: "/usr/bin" });
});

test("native handoff falls back to the browser with instructions when no app is installed", () => {
  const missing = resolveNativeApp({
    platform: "darwin",
    exists: () => false,
    registered: () => false,
    home: "/Users/someone",
  });
  assert.equal(missing.found, false);
  assert.equal(missing.reason, "missing");
  const report = nativeHandoffReport({
    app: missing,
    url: "http://127.0.0.1:6791",
    port: 6791,
    passwordFile: "/private/home/daemon/controller.secret",
  });
  assert.match(report, /No installed Orca app found/);
  assert.match(report, /packages\/desktop/);
  assert.match(report, /Using the bundled browser client: http:\/\/127\.0\.0\.1:6791/);
  const registered = resolveNativeApp({
    platform: "darwin",
    exists: () => false,
    registered: () => true,
    home: "/Users/someone",
  });
  assert.deepEqual({ found: registered.found, path: registered.path }, { found: true, path: null });
  assert.equal(resolveNativeApp({ platform: "linux", exists: () => false }).reason, "platform");
  assert.throws(
    () => resolveNativeApp({ explicit: "/nope/Orca.app", exists: () => false }),
    /No application bundle/,
  );
});

test("open refuses an incomplete installation and a daemon that is not answering", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "orca-open-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // open() loads the home, which rewrites this process's ORCA_/PASEO_ variables.
  const outerEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, outerEnv);
  });
  const home = initHome(path.join(root, "home"), 53424);
  // print: true throughout — a regression in the refusals must never reach a real app.
  await assert.rejects(() => open(home, { print: true }), /Installation is incomplete/);
  // Something answering on the port that is not the bundled client stands in for a
  // stopped or foreign installation. Bind an ephemeral port so the check never depends
  // on a fixed port being free on the machine running the test.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const config = path.join(home, "sources/runtime/src");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(config, "portable-config.mjs"),
    `export const loadPortable = () => ({ daemon: { port: ${port} }, daemonHome: ${JSON.stringify(
      path.join(home, "daemon"),
    )}, url: "http://127.0.0.1:${port}" });\n`,
  );
  fs.writeFileSync(path.join(home, "installed.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(() => open(home, { print: true }), /No portable daemon answering/);
  // And once that listener is gone, the refusal still holds.
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(() => open(home, { print: true }), /No portable daemon answering/);
});

test("catalog lock excludes a live writer and is released after its process crashes", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/orca-task-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = initHome(path.join(root, "home"), 53423);
  task(home, "add", "Existing project");
  const file = path.join(home, "tasks.json");
  const before = fs.readFileSync(file);
  fs.writeFileSync(file + ".tmp", "orphaned older write", { mode: 0o600 });
  const holder = spawn(
    "python3",
    [
      "-c",
      "import fcntl,sys; f=open(sys.argv[1], 'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()",
      file + ".lock",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await once(holder.stdout, "data");
  assert.throws(() => task(home, "add", "Must wait"), /Another task command/);
  assert.deepEqual(fs.readFileSync(file), before);
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
  assert.equal(task(home, "add", "After crash").title, "After crash");
  assert.equal(JSON.parse(fs.readFileSync(file)).issues.length, 3);
  assert.equal(fs.readFileSync(file + ".tmp", "utf8"), "orphaned older write");
});

test("project creation registers a real catalog project and keeps an older catalog intact", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "orca-project-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = initHome(path.join(root, "home"), 53425);
  const file = path.join(home, "tasks.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

  // A fresh home already carries a valid, empty projects array.
  assert.deepEqual(read().projects, []);

  // Work that predates any project keeps working and stays unaffiliated.
  const legacyTask = task(home, "add", "Existing work");
  assert.equal(legacyTask.projectId, null);
  const legacyBefore = read().issues;

  const created = task(home, "project-add", "Portable delivery", null, "Ship the portable route");
  const { project, task: anchor } = created;
  assert.match(project.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(project.id, anchor.id);
  assert.ok(!read().issues.some((row) => row.id === project.id));
  assert.deepEqual(
    { name: project.name, description: project.description, status: project.status },
    { name: "Portable delivery", description: "Ship the portable route", status: "active" },
  );
  assert.equal(
    project.companyId,
    JSON.parse(fs.readFileSync(path.join(home, "config.json"))).authority.companyId,
  );
  assert.equal(anchor.projectId, project.id);

  // A task under the anchor inherits that registered project explicitly.
  const member = task(home, "add", "Write the installer", anchor.id);
  assert.equal(member.projectId, project.id);

  // Membership reads back from the stored catalog, not from the return values.
  const stored = read();
  assert.deepEqual(
    stored.projects.map((row) => row.id),
    [project.id],
  );
  const members = stored.issues
    .filter((row) => row.projectId === project.id)
    .map((row) => row.title);
  assert.deepEqual(members, ["Portable delivery", "Write the installer"]);

  // The older rows were carried through untouched — no relabel, no overwrite.
  for (const before of legacyBefore) {
    assert.deepEqual(
      stored.issues.find((row) => row.id === before.id),
      before,
    );
  }
  assert.equal(stored.issues.find((row) => row.id === legacyTask.id).projectId, null);

  // A catalog written before projects existed still accepts a project.
  const old = {
    version: 1,
    issues: stored.issues.map(({ projectId: _projectId, ...rest }) => rest),
  };
  fs.writeFileSync(file, JSON.stringify(old, null, 2) + "\n", { mode: 0o600 });
  const second = task(home, "project-add", "Second project");
  assert.equal(second.project.description, null);
  assert.deepEqual(
    read().projects.map((row) => row.name),
    ["Second project"],
  );
  assert.equal(read().issues.filter((row) => row.projectId === second.project.id).length, 1);

  assert.throws(() => task(home, "project-add", ""), /Project name required/);
  assert.throws(() => task(home, "project-add", "x", null, "d".repeat(2001)), /1–2000 characters/);
});
