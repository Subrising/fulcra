import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { patchEmptySession } from "./empty-session.mjs";
const provider =
  "/Volumes/test-volume/openclaw/projects/orca-paseo-20260911/node_modules/@getpaseo/server/dist/server/server/agent/providers/codex-app-server-agent.js";
const original = fs.readFileSync(process.env.ORCA_PROVIDER_BASE ?? provider, "utf8");
const patched = patchEmptySession(original);
// Preserve the exact installed dependency resolution when loading the isolated patch.
const moduleText = patched.replace(
  /from (["'])(\.{1,2}\/[^"']+)\1/g,
  (_, q, specifier) =>
    `from ${q}${pathToFileURL(path.resolve(path.dirname(provider), specifier)).href}${q}`,
);
const dir = new URL("../runtime/empty-provider/", import.meta.url);
fs.mkdirSync(dir, { recursive: true });
try {
  fs.symlinkSync(
    "/Volumes/test-volume/openclaw/projects/orca-paseo-20260911/node_modules",
    new URL("node_modules", dir),
    "dir",
  );
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
const staged = new URL("provider.mjs", dir);
fs.writeFileSync(staged, moduleText);
const { CodexAppServerAgentSession: Session } = await import(staged.href + "?test=" + randomUUID());
function fixture({ ephemeral = false, resumed = false, fail = null, read = null } = {}) {
  const id = randomUUID(),
    calls = [],
    logger = {
      child() {
        return this;
      },
    };
  const s = new Session(
    { model: "gpt-6-astra", thinkingOptionId: "medium", cwd: "/tmp" },
    resumed ? { sessionId: id } : undefined,
    logger,
    null,
    {},
    ephemeral,
  );
  s.client = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (fail === method) throw Error("Injected transport failure");
      return method === "thread/start"
        ? { thread: { id } }
        : method === "thread/read"
          ? (read ?? { thread: { id, turns: [] } })
          : {};
    },
  };
  return {
    s,
    calls,
    id,
    recover: () => {
      fail = null;
      read = null;
    },
  };
}
test("new persistent provider selects legacy and confirms empty history without a turn", async () => {
  const f = fixture();
  await f.s.ensureThread();
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["thread/start", "thread/name/set", "thread/read"],
  );
  assert.equal(f.calls[0].params.historyMode, "legacy");
  assert.equal(f.s.id, f.id);
  await f.s.ensureThread();
  assert.equal(f.calls.length, 3);
});
test("ephemeral and resumed sessions do not acquire persistence or new names", async () => {
  const e = fixture({ ephemeral: true });
  await e.s.ensureThread();
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].params.ephemeral, true);
  assert.equal(e.calls[0].params.historyMode, undefined);
  const r = fixture({ resumed: true });
  await r.s.ensureThread();
  assert.equal(r.calls.length, 0);
});
for (const fail of ["thread/name/set", "thread/read"])
  test("retry after " + fail + " failure keeps the original native identity", async () => {
    const f = fixture({ fail });
    await assert.rejects(f.s.ensureThread(), /Injected/);
    assert.equal(f.s.id, f.id);
    f.recover();
    await Promise.all([f.s.ensureThread(), f.s.ensureThread()]);
    assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "thread/name/set").length, 2);
    assert.equal(f.s.orcaEmptySessionPending, false);
  });
for (const read of [{ thread: { id: "different", turns: [] } }, { thread: { turns: [] } }, {}])
  test("unconfirmed response refuses creation success", async () => {
    const f = fixture({ read });
    await assert.rejects(f.s.ensureThread(), /not confirmed/);
    assert.equal(f.s.orcaEmptySessionPending, true);
    assert.equal(f.s.id, f.id);
  });
test("unrecognized revision and already-patched provider are refused", () => {
  assert.throws(() => patchEmptySession(original + "\n"), /revision/);
  assert.throws(() => patchEmptySession(patched), /revision/);
});
