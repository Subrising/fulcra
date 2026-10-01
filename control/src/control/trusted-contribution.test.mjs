import { reconcileBootstrap } from "./native-bootstrap.mjs";
import { controllerTestConnection } from "../../tools/host-test-connection.mjs";
import { isNativeAdmissionRefusal } from "./trusted-native-input.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  TrustedPlugins,
  AgentManager,
  AgentStorage,
  sendPromptToAgent,
  createTestAgentClient,
  createTestLogger,
  CodexAppServerAgentSession,
  createFakeCodexAppServer,
} from "@fulcra/test-host";
import {
  createTrustedContribution,
  OWN_ID,
  sendPayload,
  payloadDigest,
} from "./trusted-contribution.mjs";
import { hostInputFence } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { isTrustedCatalogV11, canonicalJson } from "@getpaseo/protocol/trusted-input";
import { canonical, digest as sha256 } from "./permission-policy.mjs";

async function fixture(t, realCodex = false, provider = "codex") {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-hooks-")));
  const store = new ControlStore(path.join(home, "journal.sqlite")),
    logger = createTestLogger();
  const storage = new AgentStorage(path.join(home, "agents"), logger);
  await storage.initialize();
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  let api,
    calls = 0;
  host.registerV11(OWN_ID, true, (server) => {
    api = server;
    createTrustedContribution({ home })(server);
  });
  let quotaFailure = false,
    turnFailure = false;
  const external =
    realCodex &&
    createFakeCodexAppServer({
      "thread/start": () => ({
        thread: { id: "owned-thread" },
        modelProvider: "openai",
        model: "fixture-model",
      }),
      "turn/start": () => {
        if (turnFailure)
          return {
            __jsonRpcError: {
              code: -32000,
              message: "Orca native admission refused: provider failed after turn/start",
            },
          };
        return { turn: { id: "fixture-turn" } };
      },
      "thread/loaded/list": () => ({ data: ["owned-thread"] }),
      "account/rateLimits/read": () => {
        if (quotaFailure) throw Error("quota unavailable");
        return { accountId: "test-account", ordinaryUsageAllowed: true, rateLimits: {} };
      },
    });
  const client = createTestAgentClient(provider, {
    onStartTurn: () => {
      calls++;
    },
  });
  if (realCodex)
    client.createSession = async (config) => {
      const session = new CodexAppServerAgentSession(
        config,
        null,
        logger,
        async () => external.child,
      );
      await session.connect();
      return session;
    };
  const manager = new AgentManager({
    registry: storage,
    logger,
    trustedPlugins: host,
    mcpRefreshAdmission: (agent) => host.mcpRefresh(agent),
    clients: { [provider]: client },
  });
  const agent = await manager.createAgent(
    { provider, model: "fixture-model", cwd: home, modeId: "full-access" },
    undefined,
    { workspaceId: undefined },
  );
  const id = agent.id,
    message = randomUUID(),
    attempt = randomUUID(),
    text = "Write an owned report";
  store.created(id, randomUUID(), home);
  store.db
    .prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?")
    .run(host.boot, id);
  const row = store.get(id);
  const result = { generation: row.generation, nativeAttemptId: attempt, expectedLastUserAt: null };
  store.db
    .prepare("INSERT INTO deliveries VALUES (?,?,'send',?,'intent',?)")
    .run(
      message,
      id,
      JSON.stringify({ sessionId: id, messageId: message, text }),
      JSON.stringify(result),
    );
  const binding = () => ({
    agentId: id,
    kind: "prompt",
    messageId: "orca-control:" + message,
    attemptId: attempt,
    payloadDigest: payloadDigest(id, "prompt", "orca-control:" + message, sendPayload(text)),
  });
  const send = async (token = api.issueProvenance(binding()), prompt = text) => {
    const result = await host.rpc(token === null ? undefined : token, () =>
      sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: id,
        logger,
        prompt,
        messageId: "orca-control:" + message,
        clearPendingPermissions: true,
        activeTurnBehavior: "interrupt",
      }),
    );
    if (realCodex) await manager.waitForAgentRunStart(id);
    return result;
  };
  const restore = [];
  t.after(async () => {
    for (const run of restore) run();
    for (const known of manager.agents.keys()) await host.daemon(() => manager.closeAgent(known));
    await manager.flush();
    host.close();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    restore,
    home,
    host,
    manager,
    storage,
    logger,
    agent,
    store,
    api,
    id,
    message,
    attempt,
    text,
    result,
    binding,
    send,
    failTurn: () => {
      turnFailure = true;
    },
    calls: () =>
      realCodex ? external.requests().filter((r) => r.method === "turn/start").length : calls,
    failQuota: () => {
      quotaFailure = true;
    },
  };
}
test("real manager send reaches provider with registered five-hook contribution", async (t) => {
  const f = await fixture(t);
  assert.equal(
    isTrustedCatalogV11(
      {
        plugins: [],
        trustedHost: { contract: "1.1", boot: f.host.boot },
        trustedPlugins: f.host.catalog(),
      },
      OWN_ID,
      f.host.boot,
    ),
    true,
  );
  await f.send();
  assert.equal(f.calls(), 1);
});
test("unverified control prefix refuses at real manager before provider", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.send(null), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
test("same-payload capability without exact journal attempt refuses", async (t) => {
  const f = await fixture(t);
  const token = f.api.issueProvenance({ ...f.binding(), attemptId: randomUUID() });
  await assert.rejects(f.send(token), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
test("changed actual text cannot use approved capability", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.send(f.api.issueProvenance(f.binding()), "Different instruction"),
    /payload|provenance/i,
  );
  assert.equal(f.calls(), 0);
});
for (const [name, sql] of [
  ["generation", "UPDATE sessions SET generation=generation+1"],
  ["delegation", "UPDATE sessions SET mode='human'"],
  ["boot", "UPDATE sessions SET boot='other'"],
  ["delivery state", "UPDATE deliveries SET state='delivered'"],
  ["missing attempt", "UPDATE deliveries SET result=json_remove(result,'$.nativeAttemptId')"],
])
  test(`real manager refuses changed ${name}`, async (t) => {
    const f = await fixture(t);
    f.store.db.exec(sql);
    await assert.rejects(f.send(), /Trusted plugin input hook failed/);
    assert.equal(f.calls(), 0);
  });
test("human input on the target invalidates delegated send", async (t) => {
  const f = await fixture(t);
  await f.host.rpc(undefined, () => f.manager.cancelAgentRun(f.id));
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
test("foreign plugin provenance cannot impersonate controller prefix", async (t) => {
  const f = await fixture(t);
  let other;
  f.host.registerV11("foreign", true, (s) => {
    other = s;
  });
  await assert.rejects(
    f.send(other.issueProvenance(f.binding())),
    /Trusted plugin input hook failed/,
  );
  assert.equal(f.calls(), 0);
});
test("unavailable live facts refuse instead of using intent values", async (t) => {
  const f = await fixture(t);
  f.manager.getAgent(f.id).runtimeInfo.model = null;
  f.manager.getAgent(f.id).config.model = undefined;
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
test("altered send options cannot be substituted for journal text-only shape", async (t) => {
  const f = await fixture(t);
  const payload = sendPayload(f.text);
  payload.options.clearPendingPermissions = false;
  const token = f.api.issueProvenance({
    ...f.binding(),
    payloadDigest: payloadDigest(f.id, "prompt", "orca-control:" + f.message, payload),
  });
  await assert.rejects(f.send(token), /provenance|payload/i);
  assert.equal(f.calls(), 0);
});

async function queued(f) {
  const a = f.manager.getAgent(f.id),
    row = f.store.get(f.id),
    quota = a.session.getQuota
      ? await a.session.getQuota()
      : {
          sessionId: a.runtimeInfo.sessionId,
          model: a.runtimeInfo.model,
          serviceTier: null,
          accountScope: "codex:" + "a".repeat(64),
        };
  const binding = {
    boot: f.host.boot,
    generation: row.generation,
    task: row.task,
    authority: row.authority,
    expected: row.expected,
    expectedAt: row.expectedAt,
    nativeId: quota.sessionId,
    quota: {
      provider: "codex",
      sessionId: quota.sessionId,
      model: quota.model,
      serviceTier: quota.serviceTier,
      accountScope: quota.accountScope,
    },
    source: { kind: "direct" },
  };
  f.result.wait = { state: "admitted", binding };
  f.store.db
    .prepare("UPDATE deliveries SET result=? WHERE id=?")
    .run(JSON.stringify(f.result), f.message);
}
test("real Codex quota read failure commits attempt-bound no-dispatch receipt", async (t) => {
  const f = await fixture(t, true);
  await queued(f);
  f.failQuota();
  await assert.rejects(f.send());
  assert.equal(f.calls(), 0);
  const receipt = JSON.parse(
    f.store.db.prepare("SELECT result FROM deliveries WHERE id=?").get(f.message).result,
  ).nativeQuotaWait;
  assert.ok(receipt, "durable no-dispatch receipt required");
  assert.equal(receipt.attempt, f.attempt);
  assert.equal(receipt.boot, f.host.boot);
  assert.equal(receipt.nativeDispatched, false);
  assert.ok(["read_failed", "invalid_reply", "unavailable"].includes(receipt.reason));
});
test("queued send checks host model rather than substituting journal expected model", async (t) => {
  const f = await fixture(t);
  await queued(f);
  f.manager.getAgent(f.id).runtimeInfo.model = "changed-model";
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});

async function permissionFixture(t) {
  const f = await fixture(t, false, "claude"),
    a = f.manager.getAgent(f.id),
    db = f.store.db;
  db.exec(`CREATE TABLE permission_grants(session TEXT PRIMARY KEY,generation INTEGER,epoch TEXT,rootSession TEXT,rootEpoch TEXT,revoked INTEGER,reason TEXT);
 CREATE TABLE permission_intents(id TEXT PRIMARY KEY,identity TEXT,session TEXT,pool TEXT,state TEXT,body TEXT,result TEXT,created INTEGER);
 CREATE TABLE event_links(worker TEXT PRIMARY KEY,supervisor TEXT,epoch TEXT,workerGeneration INTEGER,supervisorGeneration INTEGER,observed TEXT,reason TEXT);`);
  db.prepare("UPDATE deliveries SET state='delivered'").run();
  db.prepare("UPDATE sessions SET expected=? WHERE id=?").run(f.message, f.id);
  const epoch = randomUUID(),
    intentId = randomUUID(),
    request = {
      id: randomUUID(),
      provider: "claude",
      kind: "tool",
      name: "Write",
      input: { file_path: f.home + "/notes.md", content: "draft" },
    };
  a.pendingPermissions.set(request.id, request);
  const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const body = {
    generation: f.result.generation,
    boot: f.host.boot,
    origin: f.message,
    authority: null,
    grantEpoch: epoch,
    requestId: request.id,
    requestDigest: digest(request),
    expectedLastUserAt: null,
    nativeId: a.runtimeInfo.sessionId,
    proof: { inputHash: digest(request.input), file: request.input.file_path, root: f.home },
  };
  db.prepare("INSERT INTO permission_grants VALUES (?,?,?,?,?,0,?)").run(
    f.id,
    body.generation,
    epoch,
    f.id,
    epoch,
    "fixture",
  );
  db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent',?,NULL,0)").run(
    intentId,
    intentId,
    f.id,
    epoch,
    JSON.stringify(body),
  );
  let responses = 0;
  const original = a.session.respondToPermission.bind(a.session);
  a.session.respondToPermission = async (...args) => {
    responses++;
    return original(...args);
  };
  const requestId = "orca-permission:" + intentId,
    response = { behavior: "allow" };
  const permission = () =>
    f.host.rpc(
      f.api.issueProvenance({
        agentId: f.id,
        kind: "permission",
        messageId: requestId,
        attemptId: intentId,
        payloadDigest: payloadDigest(f.id, "permission", requestId, {
          type: "permission",
          requestId,
          response,
        }),
      }),
      () => f.manager.respondToPermission(f.id, requestId, response),
    );
  return { ...f, a, request, body, intentId, permission, responses: () => responses };
}
// W1 F6 (H7 item 5 on the owned daemon): a seat's answer to its worker's question, driven through the REAL host and the
// REAL agent.permission_respond guard, not the bound policy alone. The body is the one questions.mjs journals; without
// the worker's nativeId (the af0cc58f rehearsal's shape) the guard refuses it before the provider sees anything.
async function questionFixture(t, nativeId) {
  const f = await permissionFixture(t),
    a = f.a,
    row = f.store.get(f.id);
  a.pendingPermissions.delete(f.request.id);
  const question = {
    id: randomUUID(),
    provider: "claude",
    kind: "question",
    name: "AskUserQuestion",
    title: "Question",
    input: {
      questions: [
        {
          header: "Branch",
          question: "Which branch?",
          options: [{ label: "main" }, { label: "cc/j6" }],
          multiSelect: false,
        },
      ],
    },
  };
  a.pendingPermissions.set(question.id, question);
  const response = { behavior: "allow", updatedInput: { answers: { "Which branch?": "main" } } },
    intentId = randomUUID(),
    native = nativeId(a);
  const body = {
    kind: "question-answer",
    generation: row.generation,
    boot: row.boot,
    ...(native === undefined ? {} : { nativeId: native }),
    origin: row.expected,
    authority: row.authority,
    requestId: question.id,
    requestDigest: sha256(canonical(question)),
    response: canonical(response),
    expectedLastUserAt: null,
  };
  f.store.db
    .prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent',?,NULL,0)")
    .run(intentId, intentId, f.id, "question:" + f.id, JSON.stringify(body));
  const requestId = "orca-permission:" + intentId;
  const answer = () =>
    f.host.rpc(
      f.api.issueProvenance({
        agentId: f.id,
        kind: "permission",
        messageId: requestId,
        attemptId: intentId,
        payloadDigest: payloadDigest(f.id, "permission", requestId, {
          type: "permission",
          requestId,
          response,
        }),
      }),
      () => f.manager.respondToPermission(f.id, requestId, response),
    );
  return { ...f, question, answer };
}
test("W1 F6: a journaled question answer carrying the worker nativeId is admitted by the real guard exactly once", async (t) => {
  const f = await questionFixture(t, (a) => a.runtimeInfo.sessionId);
  assert.ok(f.a.runtimeInfo.sessionId);
  await f.answer();
  assert.equal(f.responses(), 1);
  f.a.pendingPermissions.set(f.question.id, f.question);
  await assert.rejects(f.answer());
  assert.equal(f.responses(), 1);
});
for (const [name, nativeId] of [
  ["missing (the af0cc58f shape)", () => undefined],
  ["another session", () => "other-native-session"],
])
  test(`W1 F6: the real guard refuses a question answer whose nativeId is ${name}`, async (t) => {
    const f = await questionFixture(t, nativeId);
    await assert.rejects(
      f.answer(),
      /Orca native permission refused: .*Permission native session changed/,
    );
    assert.equal(f.responses(), 0);
  });
test("canonical permission rewrite reaches real manager/provider exactly once", async (t) => {
  const f = await permissionFixture(t);
  await f.permission();
  assert.equal(f.responses(), 1);
  f.a.pendingPermissions.set(f.request.id, f.request);
  await assert.rejects(f.permission(), /duplicate/);
  assert.equal(f.responses(), 1);
});
for (const [name, change] of [
  [
    "request content",
    (f) => {
      f.request.input.content = "changed";
    },
  ],
  [
    "file path",
    (f) => {
      f.request.input.file_path = f.home + "/other.md";
    },
  ],
  ["in-flight response", (f) => f.a.inFlightPermissionResponses.add(f.request.id)],
  ["generation", (f) => f.store.db.exec("UPDATE sessions SET generation=generation+1")],
  ["root revoked", (f) => f.store.db.exec("UPDATE permission_grants SET revoked=1")],
  [
    "proof root",
    (f) =>
      f.store.db.exec(
        "UPDATE permission_intents SET body=json_set(body,'$.proof.root','wrong-root')",
      ),
  ],
  [
    "proof input hash",
    (f) =>
      f.store.db.exec(
        "UPDATE permission_intents SET body=json_set(body,'$.proof.inputHash','wrong-hash')",
      ),
  ],
  ["request unavailable", (f) => f.a.pendingPermissions.delete(f.request.id)],
  [
    "native session",
    (f) => {
      f.a.runtimeInfo.sessionId = "changed";
    },
  ],
  [
    "last user message",
    (f) => {
      f.manager.agents.get(f.id).lastUserMessageAt = new Date();
    },
  ],
])
  test(`permission hook refuses changed ${name}`, async (t) => {
    const f = await permissionFixture(t);
    change(f);
    await assert.rejects(f.permission());
    assert.equal(f.responses(), 0);
  });

test("fresh capability cannot replay an attempt as another host operation", async (t) => {
  const f = await fixture(t);
  await f.send();
  for (let n = 0; n < 200 && f.manager.getAgent(f.id)?.activeForegroundTurnId; n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 1);
});

test("human input on supervisor invalidates worker through authoritative cross-agent sequence", async (t) => {
  const f = await fixture(t),
    worker = f.store.get(f.id),
    parent = await f.manager.createAgent(
      { provider: "codex", model: "fixture-model", cwd: f.home },
      undefined,
      { workspaceId: undefined },
    );
  f.store.created(parent.id, worker.task, f.home);
  f.store.db
    .prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?")
    .run(f.host.boot, parent.id);
  const epoch = randomUUID(),
    linkEpoch = randomUUID(),
    generation = f.store.get(parent.id).generation;
  f.store.db.exec(`CREATE TABLE manager_grants(supervisor TEXT,generation INTEGER,epoch TEXT);
 CREATE TABLE event_links(worker TEXT,supervisor TEXT,epoch TEXT,workerGeneration INTEGER,supervisorGeneration INTEGER);
 CREATE TABLE manager_workers(worker TEXT,supervisor TEXT,epoch TEXT,generation INTEGER,phase TEXT);`);
  f.store.db.prepare("INSERT INTO manager_grants VALUES (?,?,?)").run(parent.id, generation, epoch);
  f.store.db
    .prepare("INSERT INTO event_links VALUES (?,?,?,?,?)")
    .run(f.id, parent.id, linkEpoch, worker.generation, generation);
  f.store.db
    .prepare("INSERT INTO manager_workers VALUES (?,?,?,?,'attached')")
    .run(f.id, parent.id, epoch, worker.generation);
  f.result.supervision = { supervisor: parent.id, generation, epoch, linkEpoch };
  f.store.db
    .prepare("UPDATE deliveries SET result=? WHERE id=?")
    .run(JSON.stringify(f.result), f.message);
  await f.host.rpc(undefined, () => f.manager.cancelAgentRun(parent.id));
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
test("quota callback journal lock failure refuses with no retry-safe receipt", async (t) => {
  const f = await fixture(t, true);
  await queued(f);
  f.failQuota();
  f.store.db.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(f.send());
    assert.equal(f.calls(), 0);
    assert.equal(
      JSON.parse(
        f.store.db.prepare("SELECT result FROM deliveries WHERE id=?").get(f.message).result,
      ).nativeQuotaWait,
      undefined,
    );
  } finally {
    f.store.db.exec("ROLLBACK");
  }
});

for (const [name, change] of [
  [
    "native session",
    (a) => {
      a.runtimeInfo.sessionId = randomUUID();
    },
  ],
  [
    "service tier",
    (a) => {
      a.features.push({ id: "fast_mode", type: "toggle", value: true });
    },
  ],
])
  test(`queued send refuses changed host ${name}`, async (t) => {
    const f = await fixture(t);
    await queued(f);
    change(f.manager.agents.get(f.id));
    await assert.rejects(f.send(), /Trusted plugin input hook failed/);
    assert.equal(f.calls(), 0);
  });
test("instance replacement between real admission boundaries refuses provider dispatch", async (t) => {
  const f = await fixture(t);
  let once = false;
  f.host.registerV11("instance-test", true, (s) =>
    s.admission.onInput((_a, input) => {
      if (input.operation.pluginId === OWN_ID && !once) {
        once = true;
        f.manager.agents.get(f.id).instanceId = randomUUID();
      }
      return "allow";
    }),
  );
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
test("archived live runtime cannot be revived by controller send", async (t) => {
  const f = await fixture(t);
  await f.host.daemon(() => f.manager.archiveAgent(f.id));
  await assert.rejects(f.send());
  assert.equal(f.calls(), 0);
});
test("real host collects portable private Claude deny paths", async (t) => {
  const f = await fixture(t),
    rules = f.host.claudeDenyRules();
  for (const file of [
    "operator.secret",
    "journal.sqlite*",
    "grants/**",
    "pairing.*",
    "pairing/**",
    "devices/**",
    "control.sock",
    "config.json",
  ])
    for (const tool of ["Read", "Edit", "Write"])
      assert.ok(rules.includes(`${tool}(/${path.join(f.home, file)})`));
  assert.ok(rules.includes(`Bash(*${path.join(f.home, "grants")}*)`));
});

test("controller fence reads real host inputSequence and never the legacy label", async (t) => {
  const f = await fixture(t);
  const before = hostInputFence(f.manager.getAgent(f.id), f.host.boot);
  assert.equal(before.humanAt, 0);
  await f.host.rpc(undefined, () => f.manager.cancelAgentRun(f.id));
  assert.equal(hostInputFence(f.manager.getAgent(f.id), f.host.boot).humanAt, 1);
  assert.throws(() =>
    hostInputFence({ labels: { "orca.native-barrier": JSON.stringify(before) } }, f.host.boot),
  );
  assert.throws(() => hostInputFence(f.manager.getAgent(f.id), randomUUID()));
  assert.throws(() =>
    hostInputFence(
      { inputSequence: { boot: f.host.boot, humanAt: Number.MAX_SAFE_INTEGER } },
      f.host.boot,
    ),
  );
});
async function wire(t, f) {
  const connection = await controllerTestConnection({
    host: f.host,
    manager: f.manager,
    storage: f.storage,
    logger: f.logger,
    home: f.home,
    api: f.api,
  });
  t.after(() => connection.close());
  return connection;
}
test("public raw permission path rewrites the canonical request through the real host", async (t) => {
  const f = await permissionFixture(t),
    connection = await wire(t, f);
  await connection.inputs.permission(f.id, f.intentId);
  assert.equal(f.responses(), 1);
  f.a.pendingPermissions.set(f.request.id, f.request);
  await assert.rejects(connection.inputs.permission(f.id, f.intentId), isNativeAdmissionRefusal);
  assert.equal(f.responses(), 1);
});
for (const [name, change] of [
  [
    "request content",
    (f) => {
      f.request.input.content = "changed";
    },
  ],
  [
    "file path",
    (f) => {
      f.request.input.file_path = f.home + "/other.md";
    },
  ],
  ["in-flight response", (f) => f.a.inFlightPermissionResponses.add(f.request.id)],
  ["generation", (f) => f.store.db.exec("UPDATE sessions SET generation=generation+1")],
  ["root revoked", (f) => f.store.db.exec("UPDATE permission_grants SET revoked=1")],
  [
    "proof root",
    (f) =>
      f.store.db.exec(
        "UPDATE permission_intents SET body=json_set(body,'$.proof.root','wrong-root')",
      ),
  ],
  [
    "proof input hash",
    (f) =>
      f.store.db.exec(
        "UPDATE permission_intents SET body=json_set(body,'$.proof.inputHash','wrong-hash')",
      ),
  ],
  ["request unavailable", (f) => f.a.pendingPermissions.delete(f.request.id)],
  [
    "native session",
    (f) => {
      f.a.runtimeInfo.sessionId = "changed";
    },
  ],
  [
    "last user message",
    (f) => {
      f.manager.agents.get(f.id).lastUserMessageAt = new Date();
    },
  ],
])
  test(`public permission refuses changed ${name} before provider response`, async (t) => {
    const f = await permissionFixture(t),
      connection = await wire(t, f);
    change(f);
    await assert.rejects(connection.inputs.permission(f.id, f.intentId), isNativeAdmissionRefusal);
    assert.equal(f.responses(), 0);
  });
test("public real Codex quota failure preserves the attempt-bound receipt", async (t) => {
  const f = await fixture(t, true),
    connection = await wire(t, f);
  await queued(f);
  f.failQuota();
  await assert.rejects(connection.inputs.send(f.id, f.text, f.message, f.attempt));
  assert.equal(f.calls(), 0);
  const receipt = JSON.parse(
    f.store.db.prepare("SELECT result FROM deliveries WHERE id=?").get(f.message).result,
  ).nativeQuotaWait;
  assert.equal(receipt.attempt, f.attempt);
  assert.equal(receipt.nativeDispatched, false);
});
test("provider error after real Codex turn/start is uncertain despite refused text", async (t) => {
  const f = await fixture(t, true),
    connection = await wire(t, f);
  f.failTurn();
  await assert.rejects(
    connection.inputs.send(f.id, f.text, f.message, f.attempt),
    (error) => !isNativeAdmissionRefusal(error),
  );
  assert.equal(f.calls(), 1);
});
async function refreshFixture(t) {
  const f = await fixture(t),
    a = f.manager.getAgent(f.id),
    db = f.store.db;
  db.exec(`CREATE TABLE event_links(worker TEXT PRIMARY KEY,supervisor TEXT,epoch TEXT,workerGeneration INTEGER,supervisorGeneration INTEGER);
 CREATE TABLE manager_workers(worker TEXT PRIMARY KEY,supervisor TEXT,epoch TEXT,generation INTEGER,phase TEXT);
 CREATE TABLE manager_grants(supervisor TEXT PRIMARY KEY,generation INTEGER,epoch TEXT,maxWorkers INTEGER);
 CREATE TABLE permission_grants(session TEXT PRIMARY KEY,generation INTEGER,epoch TEXT,rootSession TEXT,rootEpoch TEXT,revoked INTEGER,reason TEXT); UPDATE deliveries SET state='delivered';`);
  const parent = await f.manager.createAgent(
    { provider: "codex", model: "fixture-model", cwd: f.home },
    undefined,
    { workspaceId: undefined },
  );
  f.store.created(parent.id, f.store.get(f.id).task, f.home);
  db.prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?").run(
    f.host.boot,
    parent.id,
  );
  db.prepare("INSERT INTO manager_grants VALUES (?,1,'manager-epoch',3)").run(parent.id);
  db.prepare("INSERT INTO manager_workers VALUES (?,?,'manager-epoch',1,'attached')").run(
    f.id,
    parent.id,
  );
  db.prepare("INSERT INTO event_links VALUES (?,?,'link-epoch',1,1)").run(f.id, parent.id);
  a.session.capabilities.supportsMcpServers = true;
  let closes = 0,
    resumes = 0;
  const original = a.session.close.bind(a.session);
  a.session.close = async () => {
    closes++;
    throw Error("Instrumented close");
  };
  const client = f.manager.requireClient("codex"),
    resume = client.resumeSession;
  client.resumeSession = async () => {
    resumes++;
    throw Error("No resume allowed");
  };
  f.restore.push(() => {
    a.session.close = original;
    client.resumeSession = resume;
  });
  const state = await f.manager.getAgentMcpRefreshState(f.id);
  return {
    ...f,
    a,
    parent: parent.id,
    db,
    counts: () => ({ closes, resumes }),
    request: {
      agentId: f.id,
      expected: {
        provider: state.provider,
        sessionId: state.sessionId,
        configRevision: state.configRevision,
      },
      changes: {},
      reconnect: true,
    },
  };
}
for (const [name, change] of [
  [
    "stale generation",
    (f) => f.db.prepare("UPDATE sessions SET generation=2 WHERE id=?").run(f.id),
  ],
  ["revoked manager grant", (f) => f.db.exec("DELETE FROM manager_grants")],
  ["changed manager epoch", (f) => f.db.exec("UPDATE manager_grants SET epoch='changed'")],
  ["changed worker link", (f) => f.db.exec("UPDATE event_links SET epoch='changed'")],
  [
    "human target input",
    (f) =>
      f.host.rpc(undefined, () =>
        f.host.input(f.a, "cancel", undefined, () => {}, {
          type: "command",
          command: "cancel",
          arguments: {},
        }),
      ),
  ],
  [
    "human parent input",
    (f) =>
      f.host.rpc(undefined, () =>
        f.host.input(f.manager.getAgent(f.parent), "cancel", undefined, () => {}, {
          type: "command",
          command: "cancel",
          arguments: {},
        }),
      ),
  ],
  ["human mode", (f) => f.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(f.id)],
])
  test(`real manager MCP hook refuses ${name} in the launch gap`, async (t) => {
    const f = await refreshFixture(t),
      original = f.manager.buildLaunchContext.bind(f.manager);
    f.manager.buildLaunchContext = async (...args) => {
      const result = await original(...args);
      change(f);
      return result;
    };
    const result = await f.host.daemon(() => f.manager.refreshAgentMcp(f.request));
    assert.equal(result.outcome, "refused");
    assert.equal(result.reason, "stale");
    assert.deepEqual(f.counts(), { closes: 0, resumes: 0 });
  });
test("stable MCP hook reaches provider close only after final synchronous validation", async (t) => {
  const f = await refreshFixture(t);
  const result = await f.host.daemon(() => f.manager.refreshAgentMcp(f.request));
  assert.equal(result.reason, "close_failed");
  assert.deepEqual(f.counts(), { closes: 1, resumes: 0 });
});

for (const [source, kind] of [
  ["agent", "prompt"],
  ["agent", "cancel"],
  ["agent", "archive"],
  ["daemon", "prompt"],
  ["human", "prompt"],
  ["plugin", "prompt"],
]) {
  test(`external ${source} ${kind} durably ends delegation before provider admission`, async (t) => {
    const f = await fixture(t);
    let observed;
    const effect = () => {
      observed = f.store.get(f.id);
    };
    const run = () =>
      f.host.input(
        f.manager.agents.get(f.id),
        kind,
        undefined,
        effect,
        kind === "prompt"
          ? sendPayload("Outside input")
          : { type: "command", command: kind, arguments: {} },
      );
    if (source === "agent") f.host.agentInput(run);
    else if (source === "human") f.host.rpc(undefined, run);
    else if (source === "plugin") {
      let foreign;
      f.host.registerV11("foreign", true, (s) => {
        foreign = s;
      });
      const token = foreign.issueProvenance({
        agentId: f.id,
        kind: "prompt",
        messageId: null,
        attemptId: randomUUID(),
        payloadDigest: payloadDigest(f.id, "prompt", null, sendPayload("Outside input")),
      });
      f.host.rpc(token, run);
    } else f.host.daemon(run);
    assert.equal(observed.mode, "human");
    assert.equal(observed.token, null);
    assert.equal(observed.generation, 2);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM transfers WHERE session=?").get(f.id).n,
      1,
    );
    await assert.rejects(f.send());
  });
}
// W1 row 9 (H7b on the owned daemon; ports shutdown-closure.test.mjs H7b 1/2 onto V4's onInput). The rehearsal saw every
// delegated session taken over at a clean restart, reason external-input/daemon/close. The exemption is keyed to the
// host's shutdown CALL PATH: bootstrap stop() runs prepareForShutdown(), then shutdownClosure(closeAllAgents).
const transfers = (f) =>
  f.store.db.prepare("SELECT generation,reason FROM transfers WHERE session=?").all(f.id);
const reasons = (f) =>
  transfers(f)
    .map((r) => JSON.parse(r.reason))
    .map((r) => [r.source, r.kind]);
const otherAgent = (f) =>
  f.manager.createAgent(
    { provider: "codex", model: "fixture-model", cwd: f.home, modeId: "full-access" },
    undefined,
    { workspaceId: undefined },
  );
// As bootstrap closeAllAgents: every agent closed in ONE shared shutdown context (the seat is not the first).
const shutdownClosure = async (f, ids) => {
  f.manager.prepareForShutdown();
  await f.host.shutdownClosure(() => Promise.all(ids.map((id) => f.manager.closeAgent(id))));
};
test("W1 H7b 1: the host shutdown closure keeps the seat delegated, with no transfer", async (t) => {
  const f = await fixture(t),
    before = f.store.get(f.id),
    other = await otherAgent(f);
  await shutdownClosure(f, [other.id, f.id]);
  const after = f.store.get(f.id);
  assert.deepEqual(
    [after.mode, after.generation, after.token],
    ["delegated", before.generation, before.token],
  );
  assert.deepEqual(transfers(f), []);
});
test("W1 H7b 2: a human (client) close still ends delegation", async (t) => {
  const f = await fixture(t);
  await f.host.rpc(undefined, () => f.manager.closeAgent(f.id));
  assert.equal(f.store.get(f.id).mode, "human");
  assert.deepEqual(reasons(f), [["human", "close"]]);
});
test("W1 H7b 2 (B1): a client delete admitted via rpc() before the shutdown and resumed after it still takes over", async (t) => {
  const f = await fixture(t),
    other = await otherAgent(f);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  // Admitted into the client's request context first; its close only runs once the shutdown closure has run.
  const client = f.host.rpc(undefined, async () => {
    await gate;
    return f.manager.closeAgent(f.id);
  });
  await shutdownClosure(f, [other.id]);
  release();
  await client;
  assert.equal(f.store.get(f.id).mode, "human");
  assert.deepEqual(reasons(f), [["human", "close"]]);
});
test("W1 H7b 2: a provider-retirement close (daemon, not the shutdown path) still takes over", async (t) => {
  const f = await fixture(t);
  await f.host.daemon(() => f.manager.closeAgent(f.id)); // agent-manager.ts provider retirement
  assert.equal(f.store.get(f.id).mode, "human");
  assert.deepEqual(reasons(f), [["daemon", "close"]]);
});
for (const [source, kind] of [
  ["shutdown", "cancel"],
  ["shutdown", "archive"],
  ["agent", "close"],
])
  test(`W1 H7b: only the shutdown CLOSE is exempt; ${source} ${kind} still ends delegation`, async (t) => {
    const f = await fixture(t);
    const run = () =>
      f.host.input(f.manager.agents.get(f.id), kind, undefined, () => {}, {
        type: "command",
        command: kind,
        arguments: {},
      });
    if (source === "agent") f.host.agentInput(run);
    else f.host.shutdownClosure(run);
    assert.equal(f.store.get(f.id).mode, "human");
    assert.equal(transfers(f).length, 1);
  });
test("external agent record failure refuses before its effect (x)", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.store.db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() =>
      f.host.agentInput(() =>
        f.host.input(f.manager.agents.get(f.id), "cancel", undefined, () => calls++, {
          type: "command",
          command: "cancel",
          arguments: {},
        }),
      ),
    );
    assert.equal(calls, 0);
  } finally {
    f.store.db.exec("ROLLBACK");
  }
  assert.equal(f.store.get(f.id).mode, "delegated");
});
test("own verified operation and its bound follow-ups preserve delegation", async (t) => {
  const f = await fixture(t);
  await f.send();
  assert.equal(f.store.get(f.id).mode, "delegated");
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM transfers WHERE session=?").get(f.id).n,
    0,
  );
});

for (const [source, kind] of [
  ["agent", "prompt"],
  ["agent", "cancel"],
  ["agent", "archive"],
  ["daemon", "prompt"],
]) {
  test(`real manager external ${source} ${kind} revokes delegation`, async (t) => {
    const f = await fixture(t);
    const action = () =>
      kind === "prompt"
        ? sendPromptToAgent({
            agentManager: f.manager,
            agentStorage: f.storage,
            agentId: f.id,
            logger: f.logger,
            prompt: "Outside input",
            clearPendingPermissions: true,
          })
        : kind === "cancel"
          ? f.manager.cancelAgentRun(f.id)
          : f.manager.archiveAgent(f.id);
    await (source === "agent" ? f.host.agentInput(action) : f.host.daemon(action));
    assert.equal(f.store.get(f.id).mode, "human");
    assert.equal(f.store.get(f.id).generation, 2);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM transfers WHERE session=?").get(f.id).n,
      1,
    );
    if (kind === "prompt") assert.equal(f.calls(), 1);
    await assert.rejects(f.send());
  });
}
test("own bound nested cancellation is not external input", async (t) => {
  const f = await fixture(t),
    live = f.manager.agents.get(f.id);
  f.host.rpc(f.api.issueProvenance(f.binding()), () =>
    f.host.input(
      live,
      "prompt",
      "orca-control:" + f.message,
      () => {
        const handle = f.host.captureOperation();
        assert.ok(handle);
        f.host.input(
          live,
          "cancel",
          undefined,
          () => {},
          { type: "command", command: "cancel", arguments: {} },
          handle,
        );
      },
      sendPayload(f.text),
    ),
  );
  assert.equal(f.store.get(f.id).mode, "delegated");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM transfers").get().n, 0);
});

test("external agent input revokes later permission authority", async (t) => {
  const f = await permissionFixture(t);
  f.host.agentInput(() =>
    f.host.input(f.manager.agents.get(f.id), "cancel", undefined, () => {}, {
      type: "command",
      command: "cancel",
      arguments: {},
    }),
  );
  await assert.rejects(f.permission());
  assert.equal(f.responses(), 0);
});
test("external agent input revokes later MCP refresh authority", async (t) => {
  const f = await refreshFixture(t);
  assert.equal(f.host.mcpRefresh(f.manager.agents.get(f.id)).allowed, true);
  f.host.agentInput(() =>
    f.host.input(f.manager.agents.get(f.id), "cancel", undefined, () => {}, {
      type: "command",
      command: "cancel",
      arguments: {},
    }),
  );
  assert.throws(
    () => f.host.mcpRefresh(f.manager.agents.get(f.id)),
    /Trusted plugin denied MCP refresh/,
  );
  const result = await f.host.daemon(() => f.manager.refreshAgentMcp(f.request));
  assert.equal(result.outcome, "refused");
  assert.deepEqual(f.counts(), { closes: 0, resumes: 0 });
});
test("external transfer write failure rolls back revocation and refuses the effect", async (t) => {
  const f = await fixture(t);
  let effects = 0;
  f.store.db.exec(
    "CREATE TRIGGER fail_external BEFORE INSERT ON transfers BEGIN SELECT RAISE(ABORT,'fixture transfer write failed'); END;",
  );
  try {
    assert.throws(() =>
      f.host.agentInput(() =>
        f.host.input(f.manager.agents.get(f.id), "cancel", undefined, () => effects++, {
          type: "command",
          command: "cancel",
          arguments: {},
        }),
      ),
    );
    assert.equal(effects, 0);
    assert.equal(f.store.get(f.id).mode, "delegated");
    assert.equal(f.store.get(f.id).generation, 1);
  } finally {
    f.store.db.exec("DROP TRIGGER fail_external");
  }
});

function neverTurned(f) {
  const a = f.manager.agents.get(f.id);
  a.runtimeInfo = { ...a.runtimeInfo, sessionId: null, model: null };
  a.persistence = null;
  a.config.model = undefined;
  a.lastUserMessageAt = null;
  return a;
}
test("first owned Claude prompt admits a known live never-turned instance", async (t) => {
  const f = await fixture(t, false, "claude");
  createdNeverTurned(f);
  await f.send();
  assert.equal(f.calls(), 1);
});
test("owned Claude prompt refuses missing native identity after a user turn", async (t) => {
  const f = await fixture(t, false, "claude");
  createdNeverTurned(f).lastUserMessageAt = new Date();
  await assert.rejects(f.send(), /Trusted plugin input hook failed/);
  assert.equal(f.calls(), 0);
});
for (const field of ["instanceId", "nativeSessionId", "model"])
  test(`first owned Claude prompt refuses changed ${field} between boundaries`, async (t) => {
    const f = await fixture(t, false, "claude"),
      a = createdNeverTurned(f);
    let once = false;
    f.host.registerV11("first-turn-change", true, (s) =>
      s.admission.onInput((_a, input) => {
        if (input.operation.pluginId === OWN_ID && !once) {
          once = true;
          if (field === "instanceId") a.instanceId = randomUUID();
          else a.runtimeInfo[field === "nativeSessionId" ? "sessionId" : "model"] = "changed";
        }
        return "allow";
      }),
    );
    await assert.rejects(f.send(), /Trusted plugin input hook failed/);
    assert.equal(f.calls(), 0);
  });
for (const [name, change] of [
  [
    "missing instance",
    (a) => {
      a.instanceId = undefined;
    },
  ],
  [
    "unavailable runtime",
    (a) => {
      a.lifecycle = "closed";
    },
  ],
])
  test(`first Claude prompt refuses ${name}`, async (t) => {
    const f = await fixture(t, false, "claude"),
      a = createdNeverTurned(f);
    change(a);
    await assert.rejects(f.send());
    assert.equal(f.calls(), 0);
  });
test("never-turned Codex still requires its native identity", async (t) => {
  const f = await fixture(t);
  neverTurned(f);
  await assert.rejects(f.send());
  assert.equal(f.calls(), 0);
});
function createdNeverTurned(f) {
  const a = neverTurned(f),
    create = randomUUID(),
    row = f.store.get(f.id);
  f.store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'create',?,'delivered',?)").run(
    create,
    JSON.stringify({
      messageId: create,
      taskId: row.task,
      provider: "claude",
      title: "Created worker",
    }),
    JSON.stringify({ id: f.id, cwd: f.home, runtimeInstanceId: a.instanceId }),
  );
  return a;
}
for (const [name, change] of [
  ["unrecorded creation", (f) => f.store.db.exec("DELETE FROM deliveries WHERE kind='create'")],
  [
    "different creation instance",
    (f) =>
      f.store.db.exec(
        "UPDATE deliveries SET result=json_set(result,'$.runtimeInstanceId','other') WHERE kind='create'",
      ),
  ],
  [
    "undelivered creation",
    (f) => f.store.db.exec("UPDATE deliveries SET state='uncertain' WHERE kind='create'"),
  ],
  [
    "foreign creation task",
    (f) =>
      f.store.db.exec(
        "UPDATE deliveries SET body=json_set(body,'$.taskId','other') WHERE kind='create'",
      ),
  ],
  [
    "different creation cwd",
    (f) =>
      f.store.db.exec(
        "UPDATE deliveries SET result=json_set(result,'$.cwd','/other') WHERE kind='create'",
      ),
  ],
  [
    "non-first owned delivery",
    (f) =>
      f.store.db
        .prepare("INSERT INTO deliveries VALUES (?,?,'send','{}','refused','{}')")
        .run(randomUUID(), f.id),
  ],
])
  test(`Claude bootstrap refuses ${name}`, async (t) => {
    const f = await fixture(t, false, "claude");
    createdNeverTurned(f);
    change(f);
    await assert.rejects(f.send(), /Trusted plugin input hook failed/);
    assert.equal(f.calls(), 0);
  });
test("Claude bootstrap claim cannot be replayed by another operation after a refused provider boundary", async (t) => {
  const f = await fixture(t, false, "claude");
  createdNeverTurned(f);
  f.host.registerV11("stop-after-claim", true, (s) =>
    s.admission.onInput((_a, input) => {
      if (input.operation.pluginId === OWN_ID) throw Error("Stop before native effect");
      return "allow";
    }),
  );
  await assert.rejects(f.send());
  assert.equal(f.calls(), 0);
  const claim = f.store.db.prepare("SELECT * FROM native_bootstrap WHERE session=?").get(f.id);
  assert.ok(claim);
  // Fresh capability creates a different operation, but cannot reuse the durable first claim.
  await assert.rejects(f.send());
  assert.equal(f.calls(), 0);
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM native_bootstrap WHERE session=?").get(f.id),
    claim,
  );
});

test("reconciled Claude bootstrap uses strict facts for its next owned send", async (t) => {
  const f = await fixture(t, false, "claude"),
    a = createdNeverTurned(f);
  await f.send();
  for (let n = 0; n < 200 && a.activeForegroundTurnId; n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.calls(), 1);
  assert.equal(a.activeForegroundTurnId, null);
  a.runtimeInfo = { ...a.runtimeInfo, sessionId: "bound-native", model: "fixture-model" };
  a.lastUserMessageAt = new Date();
  const oldRuntime = a.session.getRuntimeInfo;
  a.session.getRuntimeInfo = () => a.runtimeInfo;
  f.restore.push(() => {
    a.session.getRuntimeInfo = oldRuntime;
  });
  f.store.db.prepare("UPDATE deliveries SET state='delivered' WHERE id=?").run(f.message);
  reconcileBootstrap(f.store.db, {
    id: f.id,
    runtimeInstanceId: a.instanceId,
    boot: f.host.boot,
    lastPromptId: f.message,
    lastUserAt: a.lastUserMessageAt.toISOString(),
    nativeId: "bound-native",
  });
  const message = randomUUID(),
    attempt = randomUUID(),
    text = "Follow up on the same worker";
  f.store.db.prepare("INSERT INTO deliveries VALUES (?,?,'send',?,'intent',?)").run(
    message,
    f.id,
    JSON.stringify({ sessionId: f.id, messageId: message, text }),
    JSON.stringify({
      generation: f.result.generation,
      nativeAttemptId: attempt,
      expectedLastUserAt: a.lastUserMessageAt.toISOString(),
    }),
  );
  const provenance = f.api.issueProvenance({
    agentId: f.id,
    kind: "prompt",
    messageId: "orca-control:" + message,
    attemptId: attempt,
    payloadDigest: payloadDigest(f.id, "prompt", "orca-control:" + message, sendPayload(text)),
  });
  await f.host.rpc(provenance, () =>
    sendPromptToAgent({
      agentManager: f.manager,
      agentStorage: f.storage,
      agentId: f.id,
      logger: f.logger,
      prompt: text,
      messageId: "orca-control:" + message,
      clearPendingPermissions: true,
      activeTurnBehavior: "interrupt",
    }),
  );
  assert.equal(f.calls(), 2);
  assert.equal(
    f.store.db.prepare("SELECT nativeId FROM native_bootstrap WHERE session=?").get(f.id).nativeId,
    "bound-native",
  );
});

for (const scenario of ["ordinary", "mode-changed", "credential"])
  test(`U7 real host automatic permission: ${scenario}`, async (t) => {
    const f = await permissionFixture(t);
    f.a.currentModeId = "auto";
    f.request.name =
      scenario === "credential" ? "mcp__keychain__get_item" : "mcp__workspace__list_files";
    f.request.input = { path: f.home };
    f.request.metadata = { toolUseId: randomUUID() };
    f.body.requestDigest = sha256(canonical(f.request));
    f.body.proof = {
      kind: "automatic-tool",
      root: f.home,
      modeId: "auto",
      inputHash: sha256(canonical(f.request.input)),
    };
    f.store.db
      .prepare("UPDATE permission_intents SET body=? WHERE id=?")
      .run(JSON.stringify(f.body), f.intentId);
    if (scenario === "mode-changed") f.a.currentModeId = "default";
    if (scenario === "ordinary") {
      await f.permission();
      assert.equal(f.responses(), 1);
    } else {
      await assert.rejects(f.permission());
      assert.equal(f.responses(), 0);
    }
  });

// FIX-8 W3 (gate M, P3/P4): the daemon's finish notice for a create_agent child (source 'daemon', message id
// 'paseo-notify:<uuid>', agent-prompt.ts) is a child's report, not a person typing into the lead: the lead keeps its
// delegation and its manager/role grants. The same id from a human or an agent, or a daemon prompt without it, still
// ends delegation.
const notice = (f, messageId, wrap) =>
  wrap(() =>
    f.host.input(
      f.manager.agents.get(f.id),
      "prompt",
      messageId,
      () => {},
      sendPayload("A child finished"),
    ),
  );
test("FIX-8 M: a daemon finish notice to a delegated lead keeps it delegated", async (t) => {
  const f = await fixture(t),
    before = f.store.get(f.id);
  notice(f, "paseo-notify:" + randomUUID(), (run) => f.host.daemon(run));
  const after = f.store.get(f.id);
  assert.deepEqual([after.mode, after.generation], ["delegated", before.generation]);
  assert.deepEqual(transfers(f), []);
});
for (const [label, messageId, wrap] of [
  [
    "a human prompt with the notice prefix",
    "paseo-notify:" + randomUUID(),
    (f, run) => f.host.rpc(undefined, run),
  ],
  [
    "an agent prompt with the notice prefix",
    "paseo-notify:" + randomUUID(),
    (f, run) => f.host.agentInput(run),
  ],
  ["a daemon prompt without it", randomUUID(), (f, run) => f.host.daemon(run)],
])
  test(`FIX-8 M: ${label} still ends delegation`, async (t) => {
    const f = await fixture(t);
    try {
      notice(f, messageId, (run) => wrap(f, run));
    } catch {}
    assert.equal(f.store.get(f.id).mode, "human");
    assert.equal(transfers(f).length, 1);
  });

// FIX-8 W3 (gate Z): an ordinary tool request in an automatic mode (Claude auto, Codex full-access) on a session the
// controller does not own is answered by Fulcra before it is surfaced; credential/Keychain reads, a delegated session
// (the controller's journaled routine path), a question or a non-automatic mode are left for the owner.
test("FIX-8 Z: automaticDecision allows ordinary tool calls in automatic modes and nothing else", async (t) => {
  const { automaticDecision } = await import("./trusted-contribution.mjs");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-auto-")));
  const store = new ControlStore(path.join(home, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const human = randomUUID(),
    delegated = randomUUID();
  store.created(human, randomUUID(), home);
  store.created(delegated, randomUUID(), home);
  store.db.prepare("UPDATE sessions SET mode='delegated' WHERE id=?").run(delegated);
  const agent = (id, provider, modeId) => ({
    id,
    provider,
    cwd: home,
    runtime: { status: "known", modeId },
  });
  const tool = (provider, name, input) => ({
    id: "permission-" + randomUUID(),
    provider,
    kind: "tool",
    name,
    input,
    metadata: { toolUseId: "tu-" + randomUUID() },
  });
  const decide = (a, r) => automaticDecision(store.db, a, r);
  assert.equal(
    decide(
      agent(human, "claude", "auto"),
      tool("claude", "mcp__docs__search", { query: "release notes" }),
    ),
    "allow",
  );
  assert.equal(
    decide(
      agent(human, "claude", "auto"),
      tool("claude", "Write", { file_path: home + "/notes.txt", content: "x" }),
    ),
    "allow",
  );
  assert.equal(
    decide(
      agent(human, "codex", "full-access"),
      tool("codex", "mcp__docs__search", { query: "x" }),
    ),
    "allow",
  );
  assert.equal(
    decide(
      agent(human, "claude", "auto"),
      tool("claude", "Bash", { command: 'security find-generic-password -s "Fulcra account" -w' }),
    ),
    "ask",
    "Keychain read",
  );
  assert.equal(
    decide(
      agent(human, "claude", "auto"),
      tool("claude", "Bash", { command: "cat ~/.codex/auth.json" }),
    ),
    "ask",
    "credential file",
  );
  assert.equal(
    decide(
      agent(human, "claude", "auto"),
      tool("claude", "Bash", { command: "git push --force origin main" }),
    ),
    "ask",
    "destructive shared git",
  );
  assert.equal(
    decide(agent(human, "claude", "auto"), tool("claude", "Bash", { command: "npm publish" })),
    "ask",
    "publishing",
  );
  assert.equal(
    decide(agent(human, "claude", "auto"), tool("codex", "mcp__docs__search", { query: "x" })),
    "ask",
    "provider mismatch",
  );
  assert.equal(
    decide(agent(human, "unknown", "auto"), tool("unknown", "mcp__docs__search", { query: "x" })),
    "ask",
    "unknown provider",
  );
  assert.equal(
    decide(
      agent(human, "claude", "bypassPermissions"),
      tool("claude", "mcp__docs__search", { query: "x" }),
    ),
    "ask",
    "bypass mode",
  );
  assert.equal(
    decide(agent(delegated, "claude", "auto"), tool("claude", "mcp__docs__search", { query: "x" })),
    "ask",
    "the controller owns delegated sessions",
  );
  assert.equal(
    decide(agent(human, "claude", "default"), tool("claude", "mcp__docs__search", { query: "x" })),
    "ask",
    "not an automatic mode",
  );
  assert.equal(
    decide(agent(human, "claude", "auto"), {
      ...tool("claude", "AskUserQuestion", {}),
      kind: "question",
    }),
    "ask",
    "a question",
  );
  assert.equal(
    decide(
      { ...agent(human, "claude", "auto"), runtime: { status: "unavailable" } },
      tool("claude", "mcp__docs__search", { query: "x" }),
    ),
    "ask",
    "mode unknown",
  );
});
