import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nativeIdentity } from "./native-identity.mjs";
const snapshot = () => {
  const id = randomUUID();
  return {
    provider: "claude",
    cwd: "/owned/task",
    runtimeInfo: { sessionId: null },
    persistence: { provider: "claude", sessionId: id, metadata: { cwd: "/owned/task" } },
  };
};
test("native identity uses matching resume handles and reports conflicts without breaking inspection", () => {
  const a = snapshot(),
    id = a.persistence.sessionId;
  assert.deepEqual(nativeIdentity(a), {
    nativeId: id,
    source: "persistence",
    runtimeId: null,
    persistenceId: id,
    conflict: null,
  });
  a.runtimeInfo.sessionId = id;
  assert.equal(nativeIdentity(a).source, "both");
  for (const change of [
    (a) => (a.runtimeInfo.provider = "codex"),
    (a) => (a.runtimeInfo.sessionId = randomUUID()),
    (a) => (a.persistence.provider = "codex"),
    (a) => (a.persistence.metadata.cwd = "/unrelated"),
    (a) => (a.persistence.sessionId = "invalid"),
    (a) => (a.runtimeInfo.sessionId = {}),
  ]) {
    const b = structuredClone(a);
    change(b);
    const r = nativeIdentity(b);
    assert.equal(r.nativeId, null);
    assert.ok(r.conflict);
  }
  delete a.persistence;
  assert.equal(nativeIdentity(a).source, "runtime");
  a.runtimeInfo.sessionId = null;
  assert.equal(nativeIdentity(a).source, "unavailable");
});
// The real adapter comes from the product build the host-test harness supplies (FULCRA_TEST_PRODUCT, with
// packages/server built); without one the test says so rather than reaching for a machine path.
const productAdapter =
  process.env.FULCRA_TEST_PRODUCT &&
  path.join(
    process.env.FULCRA_TEST_PRODUCT,
    "packages/server/dist/server/server/agent/providers/claude/agent.js",
  );
const adapterSkip = !productAdapter
  ? "set FULCRA_TEST_PRODUCT to a product checkout with packages/server built"
  : !fs.existsSync(productAdapter)
    ? "build packages/server in FULCRA_TEST_PRODUCT (npm run build --workspace=@getpaseo/server)"
    : false;
test(
  "actual installed Claude adapter stale cache resolves from its public resume handle without a provider run",
  { skip: adapterSkip },
  async () => {
    const { ClaudeAgentClient } = await import(pathToFileURL(productAdapter).href);
    const logger = {
        child() {
          return this;
        },
        debug() {},
        warn() {},
        info() {},
        error() {},
        trace() {},
      },
      forbidden = () => {
        throw Error("No model query or binary launch permitted");
      };
    const client = new ClaudeAgentClient({
      logger,
      defaults: {},
      runtimeSettings: {},
      queryFactory: forbidden,
      resolveBinary: forbidden,
      resolveVersion: forbidden,
    });
    for (const kind of ["init", "assistant"]) {
      const cwd = "/owned/task",
        session = await client.createSession({ provider: "claude", cwd, model: "claude-opus-5" }),
        id = randomUUID();
      assert.equal((await session.getRuntimeInfo()).sessionId, null);
      if (kind === "init")
        session.handleSystemMessage({
          type: "system",
          subtype: "init",
          session_id: id,
          permissionMode: "default",
        });
      else session.captureSessionIdFromMessage({ type: "assistant", session_id: id });
      const a = {
        provider: "claude",
        cwd,
        runtimeInfo: await session.getRuntimeInfo(),
        persistence: session.describePersistence(),
      };
      assert.equal(a.runtimeInfo.sessionId, null);
      assert.equal(nativeIdentity(a).nativeId, id);
      assert.equal(nativeIdentity(a).source, "persistence");
      session.captureSessionIdFromMessage({ type: "assistant", session_id: randomUUID() });
      const changed = nativeIdentity({
        ...a,
        runtimeInfo: { sessionId: id },
        persistence: session.describePersistence(),
      });
      assert.equal(changed.nativeId, null);
      assert.ok(changed.conflict);
    }
  },
);
