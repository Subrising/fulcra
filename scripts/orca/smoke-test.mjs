// Reuse this checkout's completed server/web builds to test a fresh composed home.
// Pass clean runtime, conversation and workspace checkouts. No provider turns.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { install, compose, probe, task } from "./bootstrap.mjs";
const [runtime, conversation, workspace] = process.argv.slice(2);
const root = fs.mkdtempSync("/private/tmp/orca-start-"),
  home = root + "/home";
let launcher;
try {
  await install(home, {
    port: 54871,
    prepareOnly: true,
    native: ".",
    runtime,
    conversation,
    workspace,
  });
  const native = home + "/sources/native";
  for (const name of fs.readdirSync("packages")) {
    for (const folder of ["dist", "node_modules"]) {
      const source = path.resolve("packages", name, folder);
      if (!fs.existsSync(source)) continue;
      if (folder === "dist")
        fs.cpSync(source, native + "/packages/" + name + "/" + folder, { recursive: true });
      else fs.symlinkSync(source, native + "/packages/" + name + "/" + folder);
    }
  }
  fs.symlinkSync(path.resolve("node_modules"), native + "/node_modules");
  fs.appendFileSync(native + "/.git/info/exclude", "\nnode_modules\n");
  const receipt = await compose(home);
  task(home, "add", "Fresh portable project");
  fs.mkdirSync(root + "/os-home");
  const log = fs.openSync(root + "/startup.log", "w");
  launcher = spawn(process.execPath, ["scripts/orca/bootstrap.mjs", "start", "--home", home], {
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      HOME: root + "/os-home",
      CODEX_HOME: root + "/os-home/codex",
      CLAUDE_CONFIG_DIR: root + "/os-home/claude",
      OPENAI_API_KEY: "fake-portable-test-only",
      ANTHROPIC_API_KEY: "fake-portable-test-only",
    },
  });
  fs.closeSync(log);
  let observation, lastError;
  for (let n = 0; n < 180; n++) {
    if (launcher.exitCode !== null)
      throw Error(`Launcher exited ${launcher.exitCode}; see ${root}/startup.log`);
    try {
      if (!fs.readFileSync(root + "/startup.log", "utf8").includes("Orca: http://"))
        throw Error("Waiting for the launcher's ready banner");
      observation = await probe(home);
      break;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!observation) throw lastError;
  assert.equal(observation.workspace.available, true);
  assert.equal(observation.workspace.taskCount, 2);
  assert.equal(observation.web, true);
  assert.deepEqual(observation.sessions.sessions, []);
  assert.equal(observation.hosts.hosts[0].available, true);
  assert.throws(() => fs.mkdirSync(home), { code: "EEXIST" });
  const evidence = {
    passed: true,
    modelTurns: 0,
    home,
    receipt,
    observation,
    buildReuse:
      "Freshly built same native checkout; dist copied, dependency trees linked into test home only.",
  };
  fs.writeFileSync(root + "/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: root + "/evidence.json" }));
} finally {
  if (launcher && launcher.exitCode === null) {
    const ended = once(launcher, "exit");
    launcher.kill("SIGTERM");
    await ended;
  }
}
