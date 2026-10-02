// Fulcra J8 Environments RPC contracts (CONTRACTS.md §6). The server handlers are driven against the REAL controller on
// a temporary journal and a temporary git repository (src/control/environments.fixture.mjs), so every output schema is
// checked against what the controller actually returns. Fake scripts only: nothing here touches a host.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setup, definition, REPO } from "../../src/control/environments.fixture.mjs";
import { P } from "../../src/control/decisions.fixture.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  require = createRequire(import.meta.url);
const out = path.join(root, "runtime");
fs.mkdirSync(out, { recursive: true });
for (const [entry, file] of [
  ["server/environments.ts", "environments-server.mjs"],
  ["shared/cc/environment.ts", "cc-environment.mjs"],
])
  await require("esbuild").build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.join(out, file),
    logLevel: "silent",
  });
const { createEnvironments } = await import(path.join(out, "environments-server.mjs"));
const E = await import(path.join(out, "cc-environment.mjs"));

test("every Environments output matches the plugin schema, through a whole promotion", async (t) => {
  const s = await setup(t);
  let offline = false;
  const server = createEnvironments({
    call: (method, input) =>
      offline
        ? Promise.reject(new Error("organization.environments did not finish within 20 s"))
        : s.op(method, input),
  });
  const dev = await s.environment("dev", 0),
    next = await s.environment("next", 1);
  // Something is already on dev (recorded by an earlier promotion into it).
  s.env.recordDeployment({
    environmentId: dev.id,
    projectId: P(1),
    commit: `commit:${REPO}@${s.r.second}`,
    promotionId: null,
    status: "succeeded",
    note: "Now on Dev",
    by: "human",
  });
  const first = await server.view({ projectId: P(1) });
  E.environmentsRpc.output.parse(first);
  assert.deepEqual(
    first.environments.map((e) => [e.key, e.health]),
    [
      ["dev", "good"],
      ["next", "unknown"],
    ],
  );
  assert.equal(first.environments[1].meaning, "the practice copy customers don't see yet");
  // The app prepares; the result parses; the approval card waits for the decision store (CONTRACT-CHANGE-J8-1).
  const created = await server.create({
    messageId: randomUUID(),
    projectId: P(1),
    from: dev.id,
    to: next.id,
    commit: `commit:${REPO}@${s.r.second}`,
    expectedRevision: next.revision,
  });
  E.promotionCreateRpc.output.parse(created);
  // C1: with J3's decisions.askSystem (v1.15) merged, the controller asks the owner itself once the checks finish;
  // without it, the card waits for the orchestrator to ask.
  const systemAsks = s.env.canAskSystem();
  assert.equal(created.ok, true);
  if (systemAsks) assert.equal(created.waiting, null);
  else assert.match(created.waiting, /orchestrator/);
  await s.env.preparing.get(created.promotion.id);
  // The approval is asked; the owner approves on a paired device; the runner finishes. Each view parses.
  if (!systemAsks) await s.ask(s.env.promotion(created.promotion.id));
  const waiting = await server.view({ projectId: P(1) });
  E.environmentsRpc.output.parse(waiting);
  assert.equal(waiting.promotions[0].promotion.state, "awaiting-approval");
  await s.chooseProven(
    s.dev,
    s.control.decisions.packet(waiting.promotions[0].promotion.decisionId),
    "approve",
  );
  await s.settle();
  const done = await server.view({ projectId: P(1) });
  E.environmentsRpc.output.parse(done);
  assert.equal(done.promotions[0].promotion.state, "succeeded");
  assert.equal(done.environments[1].current.status, "succeeded");
  // A stall returns the last good view, marked stale, never an empty tab (CONTRACTS §1 Observation).
  offline = true;
  const stalled = await server.view({ projectId: P(1) });
  assert.equal(stalled.stale, true);
  assert.match(stalled.error, /did not finish/);
  assert.deepEqual(stalled.environments, done.environments);
  offline = false;
  // Refusals come back as plain messages, not failures of the RPC.
  const again = await server.create({
    messageId: randomUUID(),
    projectId: P(1),
    from: next.id,
    to: dev.id,
    commit: `commit:${REPO}@${s.r.second}`,
    expectedRevision: dev.revision,
  });
  assert.equal(again.ok, false);
  assert.match(again.message, /go forward along the path/);
});

test("the propose input refuses scripts outside the repository before anything is sent", () => {
  const good = definition("next", 1);
  assert.ok(E.definitionInput.safeParse(good).success);
  for (const script of ["/bin/sh", "../x.sh", "scripts/../../x.sh"]) {
    const bad = { ...good, steps: { ...good.steps, deploy: { ...good.steps.deploy, script } } };
    assert.equal(E.definitionInput.safeParse(bad).success, false, script);
  }
  assert.equal(
    E.definitionInput.safeParse({ ...good, command: "deploy" }).success,
    false,
    "unknown keys are refused",
  );
  assert.equal(
    E.environmentProposeRpc.input.safeParse({
      messageId: randomUUID(),
      projectId: P(1),
      environmentId: null,
      expectedRevision: 0,
      definition: good,
      note: "See /Users/someone/plan",
    }).success,
    false,
    "personal paths are refused in notes",
  );
});
