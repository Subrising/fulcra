import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { patchBookModules, patchBookPermissionAcknowledgement, stage } from "./stage.mjs";
const fixture = {
  "session.js": `class Session {
    async handleAgentPermissionResponse(agentId, requestId, response) {
            await respondToAgentPermission({
                agentManager: this.agentManager,
                agentId,
                requestId,
                response,
                logger: this.sessionLogger,
            });
    }
    async interruptAgentIfRunning(agentId) {}
    async fetch() {
        const agent = await this.getAgentPayloadById(resolved.agentId);
        if (!agent) {} } }`,
  "agent/lifecycle-command.js":
    "export async function cancelAgentRunCommand(dependencies, agentId) {}",
  "agent/agent-manager.js": `class Manager {
    async archiveSnapshot(agentId, archivedAt) {}
    closeAgent(agentId) {}
    async archiveAgent(agentId) {}
    async cancelAgentRun(agentId) {}
    streamAgent(agentId, prompt, options) {
        const existingAgent = this.requireSessionAgent(agentId); }
    async replaceAgentRun(agentId, prompt, options) {
        const snapshot = this.requireAgent(agentId); }
    async steerOrReplaceActiveTurn(agentId, prompt, options) {
        const agent = this.requireSessionAgent(agentId); }
    async respondToPermission(agentId, requestId, response) {
        const agent = this.requireAgent(agentId); }
    async begin(params) {
        const { agent, agentId, pendingRun, prompt, options } = params;
        try {
            const result = await agent.session.startTurn(prompt, options);
        } catch(e) { throw e; } } }`,
  "agent/agent-prompt.js": `export async function startAgentRun(agentManager, agentId, prompt, logger, options) {
    const snapshot = agentManager.getAgent(agentId); }
export async function sendPromptToAgent(params) {
    const record = await params.agentStorage.get(params.agentId);
    if (record?.archivedAt) {} }`,
};
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "book-stage-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = dir + "/owned",
    prefix = "@getpaseo/server/dist/server/server/",
    rows = [],
    sha = (x) => createHash("sha256").update(x).digest("hex");
  for (const [name, bytes] of Object.entries(fixture)) {
    const file = root + "/node_modules/" + prefix + name;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    rows.push([prefix + name, "file", sha(bytes)]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  fs.mkdirSync(root + "/source/config", { recursive: true });
  const runtime = {
    installation: root,
    home: root + "/home",
    installedTree: sha(JSON.stringify(rows)),
  };
  fs.writeFileSync(root + "/source/config/runtime.macbook.json", JSON.stringify(runtime));
  const p = dir + "/profile.json";
  fs.writeFileSync(
    p,
    JSON.stringify({
      runtimeSource: root + "/source",
      journal: dir + "/receiver.sqlite",
      controller: "fixture-controller",
    }),
  );
  return { dir, root, prefix, sha, p };
}
test("staging preserves original bytes and pins a separate reviewed bundle without applying", async (t) => {
  const { dir, root, prefix, sha, p } = setup(t),
    manifest = stage(p, dir + "/staged");
  assert.notEqual(manifest.tree.before, manifest.tree.after);
  const native = await import(pathToFileURL(dir + "/staged/bundle/src/book/native.mjs").href);
  const page = await import(pathToFileURL(dir + "/staged/bundle/src/book/activity-page.mjs").href);
  assert.deepEqual(native.bookMemoryPolicy("codex", { "shared-memory": {} }), {
    preapproved: [
      { kind: "mcp", server: "shared-memory", tool: "shared_memory_read" },
      { kind: "mcp", server: "shared-memory", tool: "shared_memory_search" },
    ],
  });
  assert.equal(
    page.validPageInput({
      sessionId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222",
      cursor: null,
      includeMessages: true,
    }),
    true,
  );
  const messages = "orca-organization/shared/work-messages.mjs";
  assert.equal(
    manifest.hashes[messages],
    sha(fs.readFileSync(new URL("../../" + messages, import.meta.url))),
  );
  assert.equal(sha(fs.readFileSync(dir + "/staged/bundle/" + messages)), manifest.hashes[messages]);
  for (const [name, bytes] of Object.entries(fixture)) {
    assert.equal(fs.readFileSync(root + "/node_modules/" + prefix + name, "utf8"), bytes);
    assert.equal(fs.readFileSync(dir + "/staged/before/" + name, "utf8"), bytes);
  }
  assert.equal(
    JSON.parse(fs.readFileSync(dir + "/staged/receiver-profile.json")).release,
    manifest.release,
  );
  assert.throws(() => stage(p, dir + "/staged"), /new absolute/);
  fs.appendFileSync(root + "/node_modules/" + prefix + "session.js", "changed");
  assert.throws(() => stage(p, dir + "/other"), /tree changed/);
});
test("an upgrade preserves installed guard hooks, authority and rollback bytes and rejects changed prior inputs before output", async (t) => {
  const { dir, root, prefix, sha, p } = setup(t),
    first = dir + "/first",
    prior = stage(p, first),
    runtimeFile = root + "/source/config/runtime.macbook.json";
  for (const name of Object.keys(fixture))
    fs.copyFileSync(first + "/after/" + name, root + "/node_modules/" + prefix + name);
  fs.copyFileSync(first + "/runtime.after.json", runtimeFile);
  const profile = first + "/receiver-profile.json",
    runtimeBefore = fs.readFileSync(runtimeFile),
    profileBefore = fs.readFileSync(profile);
  let attempt = 0;
  const reject = (previous = first) => {
    const out = dir + "/rejected-" + attempt++;
    assert.throws(() => stage(profile, out, previous), /Previous Book|Book dependency tree/);
    assert.equal(fs.existsSync(out), false);
  };
  const changed = (file, bytes, fn = reject) => {
    const original = fs.readFileSync(file),
      mode = fs.statSync(file).mode;
    fs.chmodSync(file, 0o600);
    try {
      fs.writeFileSync(file, bytes);
      fn();
    } finally {
      fs.writeFileSync(file, original);
      fs.chmodSync(file, mode);
    }
  };
  changed(
    profile,
    JSON.stringify({ ...JSON.parse(profileBefore), controller: "different-controller" }),
  );
  changed(runtimeFile, JSON.stringify({ ...JSON.parse(runtimeBefore), unexpected: true }));
  changed(first + "/bundle/src/book/native.mjs", "changed module");
  changed(first + "/bundle/src/book/guard-entry.mjs", "changed guard");
  changed(root + "/node_modules/" + prefix + "session.js", "changed installed module");
  changed(
    first + "/manifest.json",
    JSON.stringify({
      ...prior,
      records: {
        ...prior.records,
        "session.js": { ...prior.records["session.js"], after: "0".repeat(64) },
      },
    }),
  );
  changed(
    first + "/manifest.json",
    JSON.stringify({ ...prior, hashes: { "../outside.mjs": "0".repeat(64) } }),
  );
  for (const field of ["runtimeFile", "installation", "runtimeHome", "prefix"])
    changed(first + "/manifest.json", JSON.stringify({ ...prior, [field]: "different" }));
  changed(first + "/manifest.json", JSON.stringify({ ...prior, hashes: {} }));
  fs.symlinkSync(first, dir + "/alias");
  reject(dir + "/alias");
  reject("");
  // Even a self-consistent prior manifest may not silently change the injected hook format.
  const session = root + "/node_modules/" + prefix + "session.js",
    wrapped = fs.readFileSync(session, "utf8").replace("import {guard", "import {\n guard");
  changed(session, wrapped, () => {
    const rows = Object.keys(fixture)
      .map((n) => [prefix + n, "file", sha(fs.readFileSync(root + "/node_modules/" + prefix + n))])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const runtime = JSON.stringify({
      ...JSON.parse(runtimeBefore),
      installedTree: sha(JSON.stringify(rows)),
    });
    changed(runtimeFile, runtime, () =>
      changed(
        first + "/manifest.json",
        JSON.stringify({
          ...prior,
          tree: { ...prior.tree, after: JSON.parse(runtime).installedTree },
          runtimeHashes: { ...prior.runtimeHashes, after: sha(runtime) },
          records: {
            ...prior.records,
            "session.js": { ...prior.records["session.js"], after: sha(wrapped) },
          },
        }),
      ),
    );
  });
  const next = dir + "/next",
    upgraded = stage(profile, next, first);
  assert.deepEqual(JSON.parse(fs.readFileSync(next + "/receiver-profile.json")), {
    ...JSON.parse(profileBefore),
    release: upgraded.release,
  });
  assert.deepEqual(fs.readFileSync(runtimeFile), runtimeBefore);
  assert.deepEqual(fs.readFileSync(profile), profileBefore);
  assert.deepEqual(fs.readFileSync(next + "/runtime.before.json"), runtimeBefore);
  for (const name of Object.keys(fixture)) {
    const before = fs.readFileSync(first + "/after/" + name, "utf8"),
      after = fs.readFileSync(next + "/after/" + name, "utf8");
    assert.equal(
      after,
      before.replace(
        JSON.stringify(first + "/bundle/src/book/guard-entry.mjs"),
        JSON.stringify(next + "/bundle/src/book/guard-entry.mjs"),
      ),
    );
    assert.equal(after.slice(after.indexOf("\n")), before.slice(before.indexOf("\n")));
    assert.equal(fs.readFileSync(root + "/node_modules/" + prefix + name, "utf8"), before);
    assert.equal(fs.readFileSync(next + "/before/" + name, "utf8"), before);
    assert.deepEqual(upgraded.records[name], { before: sha(before), after: sha(after) });
  }
  const oldGuard = await import(pathToFileURL(first + "/bundle/src/book/guard-entry.mjs").href),
    newGuard = await import(pathToFileURL(next + "/bundle/src/book/guard-entry.mjs").href);
  assert.notEqual(
    oldGuard.observation("saved-agent").boot,
    newGuard.observation("saved-agent").boot,
  );
  assert.equal(newGuard.observation("saved-agent").receiverRelease, upgraded.release);
  await import(pathToFileURL(next + "/bundle/src/book/native.mjs").href);
  await import(pathToFileURL(next + "/bundle/src/book/activity-page.mjs").href);
  assert.equal(fs.existsSync(dir + "/receiver.sqlite"), false);
});
test("patch rejects duplicate/missing anchors and makes final admission single-use", () => {
  const result = patchBookModules(fixture, "/private/tmp/reviewed-entry.mjs");
  assert.equal(result["agent/agent-manager.js"].split("),true);").length, 2);
  assert.match(result["agent/agent-manager.js"], /pendingRun.start=\{status:"failed"/);
  assert.throws(() => patchBookModules(result, "/other.mjs"), /anchor drift/);
  assert.throws(
    () =>
      patchBookModules({ ...fixture, "session.js": fixture["session.js"].repeat(2) }, "/other.mjs"),
    /anchor drift/,
  );
});
test("legacy installed deny hook upgrades exactly while retaining rollback and one human fence", (t) => {
  const { dir, root, prefix, sha, p } = setup(t),
    first = dir + "/legacy",
    m = stage(p, first),
    runtimeFile = root + "/source/config/runtime.macbook.json";
  for (const name of Object.keys(fixture)) {
    let text = fs
      .readFileSync(first + "/after/" + name, "utf8")
      .replace(",permissionGuard as orcaBookPermissionGuard", "")
      .replace(",mcpRefreshAdmission as orcaBookMcpRefreshAdmission", "");
    if (name === "session.js")
      text = text.replace(
        /\n {12}if \(requestId\.startsWith\("orca-permission:"\)\).*?;(?=\n)/,
        "",
      );
    if (name === "agent/agent-manager.js")
      text = text.replace(
        "        requestId = orcaBookPermissionGuard(agent,requestId,response);",
        '        if (requestId.startsWith("orca-permission:")) throw Error("Book automated permissions unsupported");\n        orcaBookGuard(agent,"",undefined,false);',
      );
    fs.writeFileSync(root + "/node_modules/" + prefix + name, text);
    m.records[name].after = sha(text);
  }
  const rows = Object.keys(fixture)
    .sort()
    .map((n) => [prefix + n, "file", sha(fs.readFileSync(root + "/node_modules/" + prefix + n))]);
  const runtime = {
    ...JSON.parse(fs.readFileSync(first + "/runtime.after.json")),
    installedTree: sha(JSON.stringify(rows)),
  };
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
  m.tree.after = runtime.installedTree;
  m.runtimeHashes.after = sha(fs.readFileSync(runtimeFile));
  fs.chmodSync(first + "/manifest.json", 0o600);
  fs.writeFileSync(first + "/manifest.json", JSON.stringify(m));
  const next = dir + "/upgraded";
  stage(first + "/receiver-profile.json", next, first);
  const manager = fs.readFileSync(next + "/after/agent/agent-manager.js", "utf8");
  assert.match(manager, /requestId = orcaBookPermissionGuard\(agent,requestId,response\)/);
  assert(!manager.includes("Book automated permissions unsupported"));
  assert.match(
    fs.readFileSync(next + "/before/agent/agent-manager.js", "utf8"),
    /Book automated permissions unsupported/,
  );
  const entry = fs.readFileSync(next + "/bundle/src/book/guard-entry.mjs", "utf8");
  assert.equal(entry.split("createReceiverGuard(").length, 2);
  assert.match(entry, /createBookPermissionGuard\(.*input\)/);
});

test("Book synthetic acknowledgement follows native completion and preserves original identity", async () => {
  const patched = patchBookPermissionAcknowledgement(fixture["session.js"]);
  const emitted = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const Session = Function(
    "respondToAgentPermission",
    patched + ";return Session;",
  )(async (input) => {
    assert.equal(input.requestId, "orca-permission:intent");
    await gate;
  });
  const session = new Session();
  session.emit = (e) => emitted.push(e);
  const response = { behavior: "allow" };
  const pending = session.handleAgentPermissionResponse(
    "agent",
    "orca-permission:intent",
    response,
  );
  await Promise.resolve();
  assert.deepEqual(emitted, []);
  release();
  await pending;
  assert.deepEqual(emitted, [
    {
      type: "agent_permission_resolved",
      payload: { agentId: "agent", requestId: "orca-permission:intent", resolution: response },
    },
  ]);
  assert.equal(patchBookPermissionAcknowledgement(patched), patched);
});
test("Book rejection and ordinary human permission produce no synthetic success", async () => {
  const patched = patchBookPermissionAcknowledgement(fixture["session.js"]);
  for (const rejected of [true, false]) {
    const Session = Function(
      "respondToAgentPermission",
      patched + ";return Session;",
    )(async () => {
      if (rejected) throw Error("final admission refused");
    });
    const session = new Session(),
      emitted = [];
    session.emit = (e) => emitted.push(e);
    const pending = session.handleAgentPermissionResponse(
      "agent",
      rejected ? "orca-permission:intent" : "native-request",
      { behavior: "allow" },
    );
    if (rejected) await assert.rejects(pending, /final admission refused/);
    else await pending;
    assert.deepEqual(emitted, []);
  }
});
test("Book acknowledgement patch refuses absent, duplicate and misplaced anchors", () => {
  const raw = fixture["session.js"],
    patched = patchBookPermissionAcknowledgement(raw),
    ack = patched.slice(
      patched.indexOf("\n            if (requestId.startsWith"),
      patched.indexOf("\n    }"),
    );
  assert.throws(
    () =>
      patchBookPermissionAcknowledgement(
        raw.replace("await respondToAgentPermission", "await otherHandler"),
      ),
    /anchor drift/,
  );
  assert.throws(() => patchBookPermissionAcknowledgement(raw + raw), /anchor drift/);
  assert.throws(() => patchBookPermissionAcknowledgement(patched + raw), /anchor drift/);
  assert.throws(() => patchBookPermissionAcknowledgement(patched + ack), /duplicated/);
  assert.throws(() => patchBookPermissionAcknowledgement(ack + raw), /anchor drift/);
});

test("already-routine installed stage without acknowledgement gains one hook and retains rollback", (t) => {
  const { dir, root, prefix, sha, p } = setup(t),
    first = dir + "/routine-no-ack",
    m = stage(p, first),
    runtimeFile = root + "/source/config/runtime.macbook.json";
  for (const name of Object.keys(fixture)) {
    let text = fs.readFileSync(first + "/after/" + name, "utf8");
    if (name === "session.js")
      text = text.replace(
        /\n {12}if \(requestId\.startsWith\("orca-permission:"\)\).*?;(?=\n)/,
        "",
      );
    fs.writeFileSync(root + "/node_modules/" + prefix + name, text);
    m.records[name].after = sha(text);
  }
  const rows = Object.keys(fixture)
    .sort()
    .map((n) => [prefix + n, "file", sha(fs.readFileSync(root + "/node_modules/" + prefix + n))]);
  const runtime = {
    ...JSON.parse(fs.readFileSync(first + "/runtime.after.json")),
    installedTree: sha(JSON.stringify(rows)),
  };
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
  m.tree.after = runtime.installedTree;
  m.runtimeHashes.after = sha(fs.readFileSync(runtimeFile));
  fs.chmodSync(first + "/manifest.json", 0o600);
  fs.writeFileSync(first + "/manifest.json", JSON.stringify(m));
  const next = dir + "/upgraded";
  stage(first + "/receiver-profile.json", next, first);
  assert(
    !fs.readFileSync(next + "/before/session.js", "utf8").includes("agent_permission_resolved"),
  );
  assert.equal(
    fs.readFileSync(next + "/after/session.js", "utf8").split("agent_permission_resolved").length,
    2,
  );
});
