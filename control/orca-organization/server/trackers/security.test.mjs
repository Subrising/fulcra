// J3 security sweep (J3-DESIGN.md §8 "Canary sweep", mutations M1–M6). A unique canary is the keychain
// credential. The full flow runs — map, read, link, subject read, unlink, and every failure path — and the
// canary must appear in exactly one place: the Authorization header the fake tracker received.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, mapScratch, P, T } from "./harness.mjs";
import { githubRoutes, response, GH } from "./test-support.mjs";

test("X1: the credential reaches only the outbound Authorization header — never outputs, errors, logs, controller inputs or the journal", async (t) => {
  const CANARY = "CANARY-" + randomUUID();
  let mode = "ok";
  const hostile = () =>
    mode === "ok"
      ? response(200, { id: 123456, full_name: "Subrising/scratch" })
      : mode === "401"
        ? response(401, { message: `Bad credentials ${CANARY}` })
        : mode === "500"
          ? response(500, `upstream echoed ${CANARY}`)
          : mode === "json"
            ? response(200, `{"id": ${CANARY}`)
            : { throw: `socket hang up; request headers {"Authorization":"Bearer ${CANARY}"}` };
  const h = harness(t, {
    token: CANARY,
    routes: githubRoutes({ [`${GH}/repositories/123456`]: hostile }),
  });
  const logged = [],
    original = {};
  for (const k of ["log", "error", "warn", "info", "debug"]) {
    original[k] = console[k];
    console[k] = (...a) => logged.push(a.map(String).join(" "));
  }
  const outputs = [],
    errors = [];
  const run = async (p) => {
    try {
      outputs.push(await p);
    } catch (e) {
      errors.push(`${e?.name} ${e?.message} ${e?.stack} ${JSON.stringify(e)}`);
    }
  };
  try {
    await run(mapScratch(h.service));
    await run(h.service.read({ projectId: P(1) }));
    await run(
      h.service.link({
        projectId: P(1),
        subject: { kind: "task", id: T(1) },
        itemRef: "12",
        expectedMappingRevision: 1,
      }),
    );
    await run(h.service.read({ subjects: [T(1)] }));
    for (const m of ["401", "500", "json", "net"]) {
      mode = m;
      h.now.advance(3600001);
      await run(h.service.read({ projectId: P(1) }));
      await run(
        h.service.link({
          projectId: P(1),
          subject: { kind: "task", id: T(1) },
          itemRef: "7",
          expectedMappingRevision: 1,
        }),
      );
    }
    mode = "ok";
    h.now.advance(3600001);
    const link = (await h.service.read({ subjects: [T(1)] })).links[0];
    await run(h.service.unlink({ linkId: link.id, expectedRevision: link.revision }));
    await run(h.service.directory());
  } finally {
    for (const k of Object.keys(original)) console[k] = original[k];
  }
  assert.ok(outputs.length >= 10, "the flow actually ran");
  const authorised = h.fetcher.calls.filter(
    (c) => c.init.headers.Authorization === `Bearer ${CANARY}`,
  ).length;
  assert.ok(authorised > 0, "the canary did flow to the tracker");
  assert.equal(
    h.fetcher.calls.filter((c) =>
      JSON.stringify({
        url: c.url,
        headers: Object.entries(c.init.headers).filter(([k]) => k !== "Authorization"),
      }).includes(CANARY),
    ).length,
    0,
    "only in Authorization",
  );
  assert.equal(JSON.stringify(outputs).includes(CANARY), false, "service outputs");
  assert.equal(errors.join("\n").includes(CANARY), false, "thrown errors");
  assert.equal(logged.join("\n").includes(CANARY), false, "console output");
  assert.equal(JSON.stringify(h.inputs).includes(CANARY), false, "controller inputs");
  h.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  for (const f of [h.journal, h.journal + "-wal", h.journal + "-shm"])
    if (fs.existsSync(f))
      assert.equal(fs.readFileSync(f).includes(CANARY), false, path.basename(f));
  assert.equal(
    h.store.db.prepare("SELECT count(*) n FROM deliveries").get().n,
    0,
    "nothing was sent to a session",
  );
});

test("X2: fixtures and tests contain no real credential shape and no authorization value", () => {
  const here = path.dirname(fileURLToPath(import.meta.url)),
    root = path.resolve(here, "../../..");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(here);
  for (const f of [
    "orca-organization/shared/tracker-refs.test.mjs",
    "src/control/trackers.test.mjs",
    "src/control/trackers-credential.test.mjs",
  ])
    if (fs.existsSync(path.join(root, f))) files.push(path.join(root, f));
  assert.ok(files.some((f) => f.endsWith(".json")) && files.length >= 8);
  // Real token shapes, and any Authorization value that is not a per-run CANARY template.
  const shapes =
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ATATT[A-Za-z0-9_-]{20,}|ATBB[A-Za-z0-9_-]{20,}|authorization"?\s*[:=]\s*"?(?:Bearer|Basic|token)\s+(?!\$\{|CANARY)[A-Za-z0-9._~+/=-]{16,}/i;
  for (const f of files)
    assert.equal(shapes.test(fs.readFileSync(f, "utf8")), false, path.relative(root, f));
});

test("X3: J3 sources contain no raw bidi-control or zero-width characters (Trojan Source); tests use \\u escapes", () => {
  const here = path.dirname(fileURLToPath(import.meta.url)),
    root = path.resolve(here, "../../.."),
    files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(here);
  for (const f of [
    "orca-organization/shared/tracker-refs.mjs",
    "orca-organization/shared/tracker-refs.test.mjs",
    "orca-organization/shared/trackers.ts",
    "orca-organization/shared/trackers.contract.test.mjs",
    "orca-organization/client/trackers.tsx",
    "orca-organization/client/tracker-link.ts",
    "orca-organization/client/trackers.ui.test.mjs",
    "orca-organization/client/work-graph-layout.ts",
    "orca-organization/index.server.ts",
    "src/control/trackers.mjs",
    "src/control/trackers.test.mjs",
    "src/control/trackers-credential.mjs",
    "src/control/trackers-credential.test.mjs",
    "src/control/trackers.mutations.mjs",
  ])
    files.push(path.join(root, f));
  const invisible = new RegExp("[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]");
  for (const f of files)
    assert.equal(invisible.test(fs.readFileSync(f, "utf8")), false, path.relative(root, f));
});
