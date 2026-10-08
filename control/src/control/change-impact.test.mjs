import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  FENCES,
  coverage,
  dependents,
  fencesTouched,
  importGraph,
  nearest,
  report,
  sourceFiles,
} from "./change-impact.mjs";
import { randomUUID, createHash } from "node:crypto";
import {
  planRadiusChange,
  validateRadiusPlan,
  radiusScratchFiles,
} from "../../orca-organization/shared/cc/radius-workflow.mjs";
import { createRadiusScratch } from "../../orca-organization/server/radius-scratch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// A synthetic tree, so the graph assertions are about the walker and not about whatever the repo happens
// to import today.
const TREE = {
  "src/a.mjs": "import { b } from './b.mjs';",
  "src/b.mjs": "import { c } from './c.mjs';",
  "src/c.mjs": "export const c = 1;",
  "src/lonely.mjs": "export const x = 1;",
  "src/a.test.mjs": "import './a.mjs';",
  "src/lonely.test.mjs": "import './nothing-real.mjs';",
};
const tree = importGraph(Object.keys(TREE), (f) => TREE[f]);

const radiusDraft = () => ({
  application: "scratch-demo",
  requirements: [{ id: "web-port", resourceId: "web", port: 8080 }],
  current: [{ id: "old", image: "nginx:1.27.4", port: 80 }],
  proposed: [{ id: "web", image: "nginx:1.27.5", port: 8080 }],
});
function scratch(t, check = () => {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "radius-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const scratchRoot = path.join(parent, "private-scratch");
  return {
    parent,
    scratchRoot,
    adapter: createRadiusScratch({ root: scratchRoot, assertCurrentOwner: check }),
  };
}

test("Radius scratch plan binds requirements, exact changes and generated retained resource definitions", () => {
  const plan = planRadiusChange(radiusDraft());
  assert.deepEqual(
    plan.changes.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "old", kind: "remove" },
      { id: "web", kind: "add" },
    ],
  );
  assert.equal(Object.isFrozen(plan.definition.proposed[0]), true);
  assert.equal(validateRadiusPlan(plan, plan.revision).kind, "valid");
  const files = radiusScratchFiles(plan, plan.revision);
  assert.match(files["app.bicep"], /Applications.Core\/containers@2023-10-01-preview/);
  assert.doesNotMatch(files["app.bicep"], /Radius.Core|rad deploy|credential/);
  const receipt = JSON.parse(files["deployment-simulation.json"]);
  assert.deepEqual(
    [
      receipt.kind,
      receipt.nativeCompilation,
      receipt.environmentDeployment,
      receipt.externalEffects,
    ],
    ["local-scratch-simulation", "not_run", "held", false],
  );
});

test("Radius scratch validation blocks unmet requirements and stale or tampered infrastructure plans", () => {
  const draft = radiusDraft();
  draft.requirements[0].port = 9000;
  const blocked = planRadiusChange(draft);
  assert.deepEqual(validateRadiusPlan(blocked, blocked.revision).requirements, [
    { id: "web-port", state: "fail" },
  ]);
  assert.throws(() => radiusScratchFiles(blocked, blocked.revision), /requirements/);
  const plan = planRadiusChange(radiusDraft());
  assert.throws(() => radiusScratchFiles(plan, "stale"), /invalid/);
  assert.throws(() => radiusScratchFiles({ ...plan, changes: [] }, plan.revision), /invalid/);
});

test("Radius scratch input refuses commands, external targets, duplicate identities and definition injection", () => {
  assert.throws(() => planRadiusChange({ ...radiusDraft(), environment: "live" }), /invalid/);
  assert.throws(() => planRadiusChange({ ...radiusDraft(), command: "rad deploy" }), /invalid/);
  assert.throws(
    () => planRadiusChange({ ...radiusDraft(), application: "x'\nparam secret string" }),
    /invalid/,
  );
  assert.throws(
    () =>
      planRadiusChange({
        ...radiusDraft(),
        proposed: [{ id: "web", image: "https://user:throwaway@host/image", port: 8080 }],
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      planRadiusChange({
        ...radiusDraft(),
        proposed: [{ id: "web", image: "nginx:latest", port: 8080 }],
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      planRadiusChange({
        ...radiusDraft(),
        proposed: [...radiusDraft().proposed, ...radiusDraft().proposed],
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      planRadiusChange({ ...radiusDraft(), proposed: Array(17).fill(radiusDraft().proposed[0]) }),
    /invalid/,
  );
});

test("Radius scratch writes and reads four real private files once, preserving unknown files", (t) => {
  const { adapter, scratchRoot } = scratch(t),
    plan = planRadiusChange(radiusDraft()),
    attemptId = randomUUID();
  const input = { attemptId, plan, expectedRevision: plan.revision };
  const result = adapter.simulate(input),
    expected = radiusScratchFiles(plan, plan.revision);
  assert.equal(result.outputs.length, 4);
  for (const row of result.outputs) {
    const data = fs.readFileSync(path.join(scratchRoot, attemptId, row.file));
    assert.equal(data.toString(), expected[row.file]);
    assert.equal(row.bytes, data.length);
    assert.equal(row.sha256, createHash("sha256").update(data).digest("hex"));
  }
  fs.writeFileSync(path.join(scratchRoot, "unknown-user-file"), "preserve");
  assert.throws(() => adapter.simulate(input));
  assert.equal(fs.readFileSync(path.join(scratchRoot, "unknown-user-file"), "utf8"), "preserve");
  assert.equal(JSON.stringify(result).includes(scratchRoot), false);
});

test("Radius scratch original owner refusal has zero filesystem effects before admission", (t) => {
  const { adapter, scratchRoot } = scratch(t, () => {
      throw new Error("owner refused");
    }),
    plan = planRadiusChange(radiusDraft());
  assert.throws(
    () => adapter.simulate({ attemptId: randomUUID(), plan, expectedRevision: plan.revision }),
    /owner refused/,
  );
  assert.equal(fs.existsSync(scratchRoot), false);
});

test("Radius scratch rechecks owner at each effect and permanently retains a failed attempt without replay", (t) => {
  let calls = 0,
    reject = true;
  const { adapter, scratchRoot } = scratch(t, () => {
    if (++calls === 4 && reject) throw new Error("revoked");
  });
  const plan = planRadiusChange(radiusDraft()),
    input = { attemptId: randomUUID(), plan, expectedRevision: plan.revision };
  assert.throws(() => adapter.simulate(input), /revoked/);
  assert.deepEqual(fs.readdirSync(path.join(scratchRoot, input.attemptId)), []);
  reject = false;
  assert.throws(() => adapter.simulate(input));
  assert.deepEqual(fs.readdirSync(path.join(scratchRoot, input.attemptId)), []);
});

test("Radius scratch refuses foreign symlink roots and never changes their target", (t) => {
  const { parent, scratchRoot } = scratch(t),
    target = path.join(parent, "foreign");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, "keep"), "original");
  fs.symlinkSync(target, scratchRoot);
  const plan = planRadiusChange(radiusDraft());
  const adapter = createRadiusScratch({ root: scratchRoot, assertCurrentOwner: () => {} });
  assert.throws(() =>
    adapter.simulate({ attemptId: randomUUID(), plan, expectedRevision: plan.revision }),
  );
  assert.deepEqual(fs.readdirSync(target), ["keep"]);
});

test("Radius scratch requires a synchronous actual guard and refuses caller path fields", (t) => {
  const { scratchRoot } = scratch(t),
    plan = planRadiusChange(radiusDraft()),
    input = { attemptId: randomUUID(), plan, expectedRevision: plan.revision };
  const adapter = createRadiusScratch({
    root: scratchRoot,
    assertCurrentOwner: () => Promise.resolve(),
  });
  assert.throws(() => adapter.simulate(input), /refused/);
  assert.equal(fs.existsSync(scratchRoot), false);
  assert.throws(() => createRadiusScratch({ root: scratchRoot }));
  assert.throws(() =>
    createRadiusScratch({ root: scratchRoot, assertCurrentOwner: () => {} }).simulate({
      ...input,
      path: "/outside",
    }),
  );
});

const radiusDrifts = ["rename", "unlink", "replace", "hardlink", "mode"];
for (const drift of radiusDrifts) {
  test(`Radius RS1 refuses post-open ${drift} before any displaced or aliased write`, (t) => {
    const plan = planRadiusChange(radiusDraft());
    const input = { attemptId: randomUUID(), plan, expectedRevision: plan.revision };
    let changed = false;
    let witness;
    t.after(() => {
      if (witness !== undefined) fs.closeSync(witness);
    });
    const fixture = scratch(t, () => {
      const leaf = path.join(fixture.scratchRoot, input.attemptId, "app.bicep");
      if (changed || !fs.existsSync(leaf) || fs.statSync(leaf).size !== 0) return;
      changed = true;
      witness = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const displaced = path.join(fixture.parent, "displaced");
      if (drift === "rename" || drift === "replace") fs.renameSync(leaf, displaced);
      if (drift === "unlink") fs.unlinkSync(leaf);
      if (drift === "replace") fs.writeFileSync(leaf, "unknown replacement", { mode: 0o600 });
      if (drift === "hardlink") fs.linkSync(leaf, displaced);
      if (drift === "mode") fs.chmodSync(leaf, 0o644);
    });
    fs.writeFileSync(path.join(fixture.parent, "unknown"), "preserve");
    assert.throws(() => fixture.adapter.simulate(input));
    assert.equal(changed, true);
    assert.equal(fs.fstatSync(witness).size, 0);
    const attempt = path.join(fixture.scratchRoot, input.attemptId);
    assert.deepEqual(
      fs.readdirSync(attempt),
      drift === "unlink" || drift === "rename" ? [] : ["app.bicep"],
    );
    const displaced = path.join(fixture.parent, "displaced");
    if (fs.existsSync(displaced)) assert.equal(fs.statSync(displaced).size, 0);
    if (drift === "replace")
      assert.equal(fs.readFileSync(path.join(attempt, "app.bicep"), "utf8"), "unknown replacement");
    if (drift === "hardlink" || drift === "mode")
      assert.equal(fs.statSync(path.join(attempt, "app.bicep")).size, 0);
    assert.equal(fs.readFileSync(path.join(fixture.parent, "unknown"), "utf8"), "preserve");
    assert.throws(() => fixture.adapter.simulate(input));
  });
}
for (const drift of ["replace", "hardlink", "unlink"]) {
  test(`Radius RS1 refuses final-publication ${drift} of an earlier output`, (t) => {
    const plan = planRadiusChange(radiusDraft());
    const expected = radiusScratchFiles(plan, plan.revision);
    const input = { attemptId: randomUUID(), plan, expectedRevision: plan.revision };
    let changed = false;
    const fixture = scratch(t, () => {
      const attempt = path.join(fixture.scratchRoot, input.attemptId);
      const last = path.join(attempt, "deployment-simulation.json");
      if (changed || !fs.existsSync(last) || fs.statSync(last).size === 0) return;
      changed = true;
      const first = path.join(attempt, "app.bicep");
      const displaced = path.join(fixture.parent, "displaced");
      if (drift === "replace") {
        fs.renameSync(first, displaced);
        fs.writeFileSync(first, "unknown replacement", { mode: 0o600 });
      }
      if (drift === "hardlink") fs.linkSync(first, displaced);
      if (drift === "unlink") fs.unlinkSync(first);
    });
    fs.writeFileSync(path.join(fixture.parent, "unknown"), "preserve");
    assert.throws(() => fixture.adapter.simulate(input));
    assert.equal(changed, true);
    const displaced = path.join(fixture.parent, "displaced");
    if (fs.existsSync(displaced))
      assert.equal(fs.readFileSync(displaced, "utf8"), expected["app.bicep"]);
    if (drift === "replace")
      assert.equal(
        fs.readFileSync(path.join(fixture.scratchRoot, input.attemptId, "app.bicep"), "utf8"),
        "unknown replacement",
      );
    assert.equal(fs.readFileSync(path.join(fixture.parent, "unknown"), "utf8"), "preserve");
    assert.throws(() => fixture.adapter.simulate(input));
  });
}

function radiusRetentionFixture(t, count = 1) {
  const fixture = scratch(t);
  const plan = planRadiusChange(radiusDraft());
  const inputs = Array.from({ length: count }, () => ({
    attemptId: randomUUID(),
    plan,
    expectedRevision: plan.revision,
  }));
  for (const input of inputs) fixture.adapter.simulate(input);
  return {
    ...fixture,
    inputs,
    next: () => ({ attemptId: randomUUID(), plan, expectedRevision: plan.revision }),
  };
}
function radiusFill(scratchPath) {
  let counter = 0;
  while (fs.readdirSync(scratchPath).length < 64)
    fs.writeFileSync(path.join(scratchPath, `unknown-${counter++}`), "preserve", { mode: 0o600 });
}
function radiusRecovered(fixture, prune = () => {}, owner = () => {}) {
  return createRadiusScratch({
    root: fixture.scratchRoot,
    assertCurrentOwner: owner,
    assertCurrentPruneOwner: prune,
  });
}
function radiusFileSnapshot(directory) {
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      return {
        name,
        ino: stat.ino,
        mode: stat.mode,
        nlink: stat.nlink,
        hash: stat.isFile()
          ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
          : null,
      };
    });
}

test("Radius R19 recovers after a real source process restart and prunes oldest known to48, then reserves incoming", (t) => {
  const fixture = radiusRetentionFixture(t, 17);
  radiusFill(fixture.scratchRoot);
  const input = fixture.next();
  const module = path.resolve("control/orca-organization/server/radius-scratch.mjs");
  const script = `import {createRadiusScratch} from ${JSON.stringify(new URL("file://" + module).href)}; const [root,input]=process.argv.slice(1); const adapter=createRadiusScratch({root,assertCurrentOwner:()=>{},assertCurrentPruneOwner:()=>{}}); console.log(JSON.stringify(adapter.simulate(JSON.parse(input))));`;
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, fixture.scratchRoot, JSON.stringify(input)],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
  assert.equal(output.attemptId, input.attemptId);
  assert.equal(output.outputs.length, 4);
  assert.equal(fs.readdirSync(fixture.scratchRoot).length, 49);
  for (const old of fixture.inputs.slice(0, 16))
    assert.equal(fs.existsSync(path.join(fixture.scratchRoot, old.attemptId)), false);
  assert.equal(fs.existsSync(path.join(fixture.scratchRoot, fixture.inputs[16].attemptId)), true);
  assert.equal(fs.readFileSync(path.join(fixture.scratchRoot, "unknown-0"), "utf8"), "preserve");
  assert.deepEqual(fs.readdirSync(path.join(fixture.scratchRoot, input.attemptId)).sort(), [
    "app.bicep",
    "attempt.json",
    "deployment-simulation.json",
    "infra-change.json",
    "requirements.json",
  ]);
});
for (const corruption of ["corrupt", "temp"]) {
  test(`Radius R19 ${corruption} manifest isolates one attempt and permits unrelated publication and recovery`, (t) => {
    const fixture = radiusRetentionFixture(t, 2);
    const bad = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
    if (corruption === "corrupt") fs.writeFileSync(path.join(bad, "attempt.json"), "{");
    else fs.writeFileSync(path.join(bad, ".attempt.tmp"), "unknown temp", { mode: 0o600 });
    const before = radiusFileSnapshot(bad);
    const fresh = fixture.next();
    radiusRecovered(fixture).simulate(fresh);
    radiusFill(fixture.scratchRoot);
    const incoming = fixture.next();
    radiusRecovered(fixture).simulate(incoming);
    assert.deepEqual(radiusFileSnapshot(bad), before);
    assert.equal(fs.existsSync(path.join(fixture.scratchRoot, fixture.inputs[1].attemptId)), false);
    assert.equal(fs.existsSync(path.join(fixture.scratchRoot, fresh.attemptId)), false);
    assert.equal(
      fs.existsSync(path.join(fixture.scratchRoot, incoming.attemptId, "attempt.json")),
      true,
    );
  });
}
for (const drift of [
  "extra",
  "missing",
  "bytes",
  "replace",
  "hardlink",
  "mode",
  "symlink",
  "oversize",
  "duplicate-record",
  "root-record",
  "order-record",
  "max-order",
  "manifest-missing",
  "manifest-symlink",
  "manifest-link",
  "manifest-mode",
  "unsupported",
]) {
  test(`Radius R19 whole candidate ${drift} stays untouched and full root refuses`, (t) => {
    const fixture = radiusRetentionFixture(t);
    const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
    const leaf = path.join(attempt, "app.bicep");
    const manifest = path.join(attempt, "attempt.json");
    if (drift === "extra") fs.writeFileSync(path.join(attempt, "unknown"), "preserve");
    if (drift === "missing") fs.unlinkSync(leaf);
    if (drift === "bytes") fs.appendFileSync(leaf, "changed");
    if (drift === "replace") {
      fs.renameSync(leaf, path.join(fixture.parent, "displaced"));
      fs.writeFileSync(leaf, "replacement", { mode: 0o600 });
    }
    if (drift === "hardlink") fs.linkSync(leaf, path.join(fixture.parent, "alias"));
    if (drift === "mode") fs.chmodSync(leaf, 0o644);
    if (drift === "symlink") {
      fs.renameSync(leaf, path.join(fixture.parent, "displaced"));
      fs.symlinkSync(path.join(fixture.parent, "displaced"), leaf);
    }
    if (drift === "oversize") fs.writeFileSync(manifest, "x".repeat(4097));
    if (drift === "manifest-missing") fs.unlinkSync(manifest);
    if (drift === "manifest-symlink") {
      fs.renameSync(manifest, path.join(fixture.parent, "manifest-displaced"));
      fs.symlinkSync(path.join(fixture.parent, "manifest-displaced"), manifest);
    }
    if (drift === "manifest-link")
      fs.linkSync(manifest, path.join(fixture.parent, "manifest-alias"));
    if (drift === "manifest-mode") fs.chmodSync(manifest, 0o644);
    if (
      ["duplicate-record", "root-record", "order-record", "max-order", "unsupported"].includes(
        drift,
      )
    ) {
      const record = JSON.parse(fs.readFileSync(manifest));
      if (drift === "duplicate-record") record.outputs[1] = record.outputs[0];
      if (drift === "root-record") record.root.ino += 1;
      if (drift === "order-record") record.order = 0;
      if (drift === "max-order") record.order = Number.MAX_SAFE_INTEGER;
      if (drift === "unsupported") record.format = 2;
      fs.writeFileSync(manifest, JSON.stringify(record) + "\n");
    }
    radiusFill(fixture.scratchRoot);
    const before = radiusFileSnapshot(attempt);
    const input = fixture.next();
    assert.throws(() => radiusRecovered(fixture).simulate(input));
    assert.deepEqual(radiusFileSnapshot(attempt), before);
    assert.equal(fs.readdirSync(fixture.scratchRoot).length, 64);
    assert.equal(fs.existsSync(path.join(fixture.scratchRoot, input.attemptId)), false);
  });
}

test("Radius R19 absent destructive guard and retained duplicate refuse before any prune", (t) => {
  const fixture = radiusRetentionFixture(t);
  radiusFill(fixture.scratchRoot);
  const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
  const before = radiusFileSnapshot(attempt);
  let calls = 0;
  assert.throws(() =>
    radiusRecovered(fixture, () => {
      calls++;
    }).simulate(fixture.inputs[0]),
  );
  assert.equal(calls, 0);
  assert.throws(() => fixture.adapter.simulate(fixture.next()));
  assert.deepEqual(radiusFileSnapshot(attempt), before);
});
for (const drift of ["revoke", "root", "extra", "leaf"]) {
  test(`Radius R19 held destructive ${drift} refuses with zero subsequent candidate deletion`, (t) => {
    const fixture = radiusRetentionFixture(t);
    const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
    radiusFill(fixture.scratchRoot);
    let checks = 0;
    const prune = () => {
      // Collection finishes at9; whole-candidate validation finishes at14.
      if (++checks !== 15) return;
      if (drift === "revoke") throw new Error("original epoch revoked");
      if (drift === "root") {
        fs.renameSync(fixture.scratchRoot, path.join(fixture.parent, "moved"));
        fs.mkdirSync(fixture.scratchRoot, { mode: 0o700 });
      }
      if (drift === "extra") fs.writeFileSync(path.join(attempt, "unknown"), "preserve");
      if (drift === "leaf") {
        fs.renameSync(path.join(attempt, "app.bicep"), path.join(fixture.parent, "displaced"));
        fs.writeFileSync(path.join(attempt, "app.bicep"), "replacement", { mode: 0o600 });
      }
    };
    assert.throws(() => radiusRecovered(fixture, prune).simulate(fixture.next()));
    const actual =
      drift === "root" ? path.join(fixture.parent, "moved", fixture.inputs[0].attemptId) : attempt;
    assert.equal(fs.existsSync(path.join(actual, "attempt.json")), true);
    assert.equal(fs.existsSync(path.join(actual, "requirements.json")), true);
    assert.equal(fs.existsSync(path.join(actual, "app.bicep")), true);
    if (drift === "extra")
      assert.equal(fs.readFileSync(path.join(actual, "unknown"), "utf8"), "preserve");
    if (drift === "leaf")
      assert.equal(fs.readFileSync(path.join(actual, "app.bicep"), "utf8"), "replacement");
  });
}

test("Radius R19 partial pruning stops after original revoke without rollback or cleanup", (t) => {
  const fixture = radiusRetentionFixture(t);
  radiusFill(fixture.scratchRoot);
  const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
  const prune = () => {
    if (!fs.existsSync(path.join(attempt, "app.bicep")))
      throw new Error("revoked after first unlink");
  };
  assert.throws(() => radiusRecovered(fixture, prune).simulate(fixture.next()));
  assert.equal(fs.existsSync(path.join(attempt, "app.bicep")), false);
  assert.deepEqual(fs.readdirSync(attempt).sort(), [
    "attempt.json",
    "deployment-simulation.json",
    "infra-change.json",
    "requirements.json",
  ]);
  assert.throws(() => radiusRecovered(fixture).simulate(fixture.next()));
  assert.deepEqual(fs.readdirSync(attempt).sort(), [
    "attempt.json",
    "deployment-simulation.json",
    "infra-change.json",
    "requirements.json",
  ]);
});

for (const deleted of [2, 3, 4, 5]) {
  test(`Radius R19 held guard after ${deleted} unlinks stops subsequent effects including rmdir`, (t) => {
    const fixture = radiusRetentionFixture(t);
    radiusFill(fixture.scratchRoot);
    const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
    const originalGuard = () => {
      if (fs.readdirSync(attempt).length === 5 - deleted) throw new Error("original epoch revoked");
    };
    assert.throws(() => radiusRecovered(fixture, () => {}, originalGuard).simulate(fixture.next()));
    assert.equal(fs.existsSync(attempt), true);
    assert.equal(fs.readdirSync(attempt).length, 5 - deleted);
  });
}

test("Radius R19 original revoke-regain epoch across destructive guard refuses before unlink", (t) => {
  const fixture = radiusRetentionFixture(t);
  radiusFill(fixture.scratchRoot);
  const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
  const before = radiusFileSnapshot(attempt);
  let epoch = 0,
    checks = 0;
  const originalGuard = () => {
    if (epoch !== 0) throw new Error("original captured epoch superseded");
  };
  const destructiveGuard = () => {
    if (++checks === 15) epoch += 2;
  };
  assert.throws(() =>
    radiusRecovered(fixture, destructiveGuard, originalGuard).simulate(fixture.next()),
  );
  assert.equal(epoch, 2);
  assert.deepEqual(radiusFileSnapshot(attempt), before);
});

test("Radius R19 duplicate recovered creation orders are ineligible, preserving both full-root attempts", (t) => {
  const fixture = radiusRetentionFixture(t, 2);
  const attempts = fixture.inputs.map((input) => path.join(fixture.scratchRoot, input.attemptId));
  const manifest = path.join(attempts[1], "attempt.json");
  const record = JSON.parse(fs.readFileSync(manifest));
  record.order = 1;
  fs.writeFileSync(manifest, JSON.stringify(record) + "\n");
  radiusFill(fixture.scratchRoot);
  const before = attempts.map(radiusFileSnapshot);
  assert.throws(() => radiusRecovered(fixture).simulate(fixture.next()));
  assert.deepEqual(attempts.map(radiusFileSnapshot), before);
});

test("Radius R19 incoming reservation keeps full unknown refusal and eviction ends UUID tombstone", (t) => {
  const fixture = radiusRetentionFixture(t);
  radiusFill(fixture.scratchRoot);
  const old = fixture.inputs[0];
  const fresh = fixture.next();
  radiusRecovered(fixture).simulate(fresh);
  assert.equal(fs.existsSync(path.join(fixture.scratchRoot, old.attemptId)), false);
  const result = radiusRecovered(fixture).simulate(old);
  assert.equal(result.attemptId, old.attemptId);
  assert.equal(fs.readdirSync(fixture.scratchRoot).length, 64);
});

test("Radius R19 interrupted last manifest publication retains failure but does not strand fresh attempts", (t) => {
  const fixture = radiusRetentionFixture(t, 0);
  const input = fixture.next();
  const attempt = path.join(fixture.scratchRoot, input.attemptId);
  const owner = () => {
    if (fs.existsSync(path.join(attempt, ".attempt.tmp"))) throw new Error("revoked publication");
  };
  assert.throws(() => radiusRecovered(fixture, () => {}, owner).simulate(input));
  assert.equal(fs.existsSync(path.join(attempt, ".attempt.tmp")), true);
  assert.equal(fs.existsSync(path.join(attempt, "attempt.json")), false);
  const before = radiusFileSnapshot(attempt);
  assert.throws(() => radiusRecovered(fixture).simulate(input));
  const next = fixture.next();
  radiusRecovered(fixture).simulate(next);
  assert.deepEqual(radiusFileSnapshot(attempt), before);
  assert.equal(fs.existsSync(path.join(fixture.scratchRoot, next.attemptId, "attempt.json")), true);
});

// Keep FIFO regressions in a timeout-bounded source child: a blocking open must
// fail this test without blocking the parent suite or touching another process.
function radiusCaptureChild(fixture, input, target, replacement = null) {
  const module = new URL("../../orca-organization/server/radius-scratch.mjs", import.meta.url);
  const script = `
    import fs from "node:fs";
    import {execFileSync} from "node:child_process";
    import {createRadiusScratch} from ${JSON.stringify(module.href)};
    const [root, raw, target, replacement] = process.argv.slice(1);
    let changed = false, nonblocking = null, opened = false;
    const original = fs.openSync;
    fs.openSync = function(name, flags, ...rest) {
      if (replacement && name === target && !changed) {
        changed = true;
        fs.renameSync(target, target + ".displaced");
        if (replacement === "fifo") {
          execFileSync("/usr/bin/mkfifo", ["-m", "600", target], {timeout: 2000});
        } else fs.writeFileSync(target, "unknown replacement", {mode: 0o600});
        nonblocking = (flags & fs.constants.O_NONBLOCK) !== 0;
        if (!nonblocking) throw new Error("blocking capture flags");
      }
      const fd = original.call(fs, name, flags, ...rest);
      if (replacement && name === target) opened = true;
      return fd;
    };
    const adapter = createRadiusScratch({root, assertCurrentOwner:()=>{}, assertCurrentPruneOwner:()=>{}});
    let refused = false;
    try { adapter.simulate(JSON.parse(raw)); } catch { refused = true; }
    console.log(JSON.stringify({refused, changed, nonblocking, opened}));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        fixture.scratchRoot,
        JSON.stringify(input),
        target,
        replacement ?? "",
      ],
      { encoding: "utf8", timeout: 5000 },
    ),
  );
}
for (const file of ["attempt.json", "app.bicep"]) {
  test(`Radius R19-6 pre-existing FIFO ${file} is bounded and untouched`, (t) => {
    const fixture = radiusRetentionFixture(t);
    const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
    const leaf = path.join(attempt, file);
    fs.unlinkSync(leaf);
    execFileSync("/usr/bin/mkfifo", ["-m", "600", leaf], { timeout: 2000 });
    const before = radiusFileSnapshot(attempt);
    if (file === "app.bicep") radiusFill(fixture.scratchRoot);
    const input = fixture.next();
    const result = radiusCaptureChild(fixture, input, leaf);
    assert.equal(result.refused, file === "app.bicep");
    assert.equal(result.changed, false);
    assert.deepEqual(radiusFileSnapshot(attempt), before);
    assert.equal(fs.lstatSync(leaf).isFIFO(), true);
    assert.equal(
      fs.existsSync(path.join(fixture.scratchRoot, input.attemptId)),
      file === "attempt.json",
    );
  });
  for (const replacement of ["fifo", "regular"]) {
    test(`Radius R19-6 held ${file} replacement by ${replacement} refuses without retarget`, (t) => {
      const fixture = radiusRetentionFixture(t);
      const attempt = path.join(fixture.scratchRoot, fixture.inputs[0].attemptId);
      const leaf = path.join(attempt, file);
      const original = fs.readFileSync(leaf);
      radiusFill(fixture.scratchRoot);
      const input = fixture.next();
      const result = radiusCaptureChild(fixture, input, leaf, replacement);
      assert.deepEqual(result, { refused: true, changed: true, nonblocking: true, opened: true });
      assert.deepEqual(fs.readFileSync(leaf + ".displaced"), original);
      if (replacement === "fifo") assert.equal(fs.lstatSync(leaf).isFIFO(), true);
      else assert.equal(fs.readFileSync(leaf, "utf8"), "unknown replacement");
      assert.equal(fs.readdirSync(attempt).length, 6);
      assert.equal(fs.readdirSync(fixture.scratchRoot).length, 64);
      assert.equal(fs.existsSync(path.join(fixture.scratchRoot, input.attemptId)), false);
    });
  }
}

test("blast radius is transitive, and excludes the changed files themselves", () => {
  assert.deepEqual(dependents(tree, ["src/c.mjs"]), ["src/a.mjs", "src/a.test.mjs", "src/b.mjs"]);
  assert.deepEqual(
    dependents(tree, ["src/lonely.mjs"]),
    [],
    "nothing imports it, so nothing is affected",
  );
  // b imports c, so a change touching both would list b as collateral of itself. A reviewer reads the
  // radius as "what I did not change but must still think about", so a changed file never belongs in it.
  assert.deepEqual(dependents(tree, ["src/b.mjs", "src/c.mjs"]), ["src/a.mjs", "src/a.test.mjs"]);
  // b is reached only through a: if the walk were one hop deep this would be missing.
  assert.ok(
    dependents(tree, ["src/c.mjs"]).includes("src/a.mjs"),
    "the walk must be transitive, not one hop",
  );
});

test("coverage is transitive too, and an unreached module is named", () => {
  assert.deepEqual(
    coverage(tree, ["src/c.mjs"]),
    [{ file: "src/c.mjs", tests: ["src/a.test.mjs"] }],
    "a test importing a, which imports b, which imports c, exercises c",
  );
  assert.deepEqual(coverage(tree, ["src/lonely.mjs"]), [{ file: "src/lonely.mjs", tests: [] }]);
  const text = report({ range: "x..y", changed: ["src/lonely.mjs"], graph: tree });
  assert.match(text, /NO TEST REACHES/);
  assert.match(text, /src\/lonely\.mjs/);
});

test("the report separates production blast radius from the tests that cover it", () => {
  const text = report({ range: "x..y", changed: ["src/c.mjs"], graph: tree });
  const blast = text.slice(text.indexOf("BLAST RADIUS"), text.indexOf("TEST COVERAGE"));
  assert.match(blast, /src\/a\.mjs/);
  assert.doesNotMatch(
    blast,
    /a\.test\.mjs/,
    "a reviewer asking what else is affected means production modules",
  );
  assert.match(text.slice(text.indexOf("TEST COVERAGE")), /a\.test\.mjs/);
});

test("a fenced surface is named with the reason it matters, and an ordinary change is not", () => {
  const hit = fencesTouched(["src/control/role-channels.mjs"]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, "role-authority");
  assert.ok(hit[0].why.length > 40, "a fence without a reason is a label");
  assert.deepEqual(fencesTouched(["README.md", "src/lonely.mjs"]), []);
  assert.match(
    report({ range: "x..y", changed: ["src/control/admission-guard.mjs"], graph: tree }),
    /FENCED SURFACES TOUCHED[\s\S]*Native admission guard/,
  );
  assert.match(
    report({ range: "x..y", changed: ["README.md"], graph: tree }),
    /FENCED SURFACES: none touched/,
  );
});

// FENCES is a list of path strings, so a rename would silently empty a fence and the report would go quiet
// about the surface it exists to shout about. That is the failure this repository keeps finding, so the
// table checks itself against the tree.
test("every fenced path still exists, so a rename cannot silently empty a fence", () => {
  assert.ok(FENCES.length >= 4);
  const missing = FENCES.flatMap((f) =>
    f.files.filter((rel) => !fs.existsSync(path.join(root, rel))).map((rel) => `${f.id}: ${rel}`),
  );
  assert.deepEqual(
    missing,
    [],
    "a fenced file moved; update FENCES or the report will stay silent about it",
  );
  for (const f of FENCES) assert.ok(f.files.length && f.why && f.label, `${f.id} is incomplete`);
});

test("the real repository graph is non-empty, so the report is not vacuous", () => {
  const files = sourceFiles(root);
  assert.ok(files.length > 100, `only ${files.length} source files found`);
  const graph = importGraph(files, (f) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      return "";
    }
  });
  const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
  assert.ok(edges > 100, `only ${edges} import edges resolved`);
  // A known real dependency, so an edge-resolution bug fails here rather than showing an empty radius.
  assert.ok(
    dependents(graph, ["src/control/provider-mode.mjs"]).includes("src/control/native.mjs"),
  );
});

test("the report always states what it cannot see", () => {
  const text = report({ range: "x..y", changed: [], graph: tree });
  assert.match(text, /WHAT THIS CANNOT SEE/);
  for (const limit of [
    /Dynamic dispatch/,
    /outside this repository/,
    /Runtime configuration/,
    /actually asserts/,
  ])
    assert.match(text, limit);
});

test("a long coverage list is summarised to the tests a reviewer would open first", () => {
  const many = [
    "src/zeta.test.mjs",
    "src/control/far.test.mjs",
    "src/thing.test.mjs",
    "src/alpha.test.mjs",
  ];
  // Named after the module first, then same-directory neighbours, then the rest -- and alphabetical inside
  // each rank so the output does not reorder itself between runs.
  assert.deepEqual(nearest("src/thing.mjs", many), [
    "src/thing.test.mjs",
    "src/alpha.test.mjs",
    "src/zeta.test.mjs",
  ]);
  assert.equal(nearest("src/thing.mjs", many).length, 3, "the wall is capped");
  const wide = { ...TREE };
  for (let i = 0; i < 9; i++) wide[`src/w${i}.test.mjs`] = "import './c.mjs';";
  const text = report({
    range: "x..y",
    changed: ["src/c.mjs"],
    graph: importGraph(Object.keys(wide), (f) => wide[f]),
  });
  const section = text.slice(text.indexOf("TEST COVERAGE"), text.indexOf("WHAT THIS CANNOT SEE"));
  assert.match(
    section,
    /10 test file\(s\), nearest: /,
    "the count survives even though the list does not",
  );
  assert.match(section, /\(\+7 more\)/);
  assert.ok(
    section.split("\n").length < 8,
    `coverage section is a wall again: ${section.split("\n").length} lines`,
  );
});

// ---- Any repository: root + range, read at the head commit -------------------------------------------
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  aliasesFrom,
  classify,
  describeImpact,
  measureImpact,
  parseJsonc,
  resolveSpecifier,
} from "./change-impact.mjs";

function productRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j7-impact-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: dir,
  };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "step");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  return { dir, git, write, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("any repository: aliases, extensionless and .js-for-.ts imports, tests, other languages, deletions", () => {
  const repo = productRepo();
  try {
    repo.write(
      "packages/app/tsconfig.json",
      '{\n  // the app alias\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },\n}\n',
    );
    repo.write("packages/app/src/price.ts", "export const price = (n: number) => n * 2;\n");
    repo.write(
      "packages/app/src/cart/index.ts",
      "import { price } from '@/price';\nexport const total = price(1);\n",
    );
    repo.write(
      "packages/app/src/checkout.tsx",
      "import { total } from './cart';\nexport const Checkout = () => total;\n",
    );
    repo.write("packages/app/src/checkout.test.tsx", "import { Checkout } from './checkout.js';\n");
    repo.write("packages/app/src/lonely.ts", "export const lonely = 1;\n");
    repo.write("packages/app/src/old.ts", "export const old = 1;\n");
    repo.write("tools/report.py", "print(1)\n");
    const base = repo.commit();
    repo.write("packages/app/src/price.ts", "export const price = (n: number) => n * 3;\n");
    repo.write("packages/app/src/lonely.ts", "export const lonely = 2;\n");
    repo.write("tools/report.py", "print(2)\n");
    repo.write("README.md", "notes\n");
    fs.rmSync(path.join(repo.dir, "packages/app/src/old.ts"));
    const head = repo.commit();
    // Uncommitted: must not appear. It would add an importer of lonely.ts if the working tree were read.
    repo.write("packages/app/src/uses-lonely.ts", "import { lonely } from './lonely';\n");

    const impact = measureImpact({ root: repo.dir, range: `${base}..${head}` });
    assert.equal(impact.head, head);
    assert.deepEqual(impact.counts, {
      changed: 5,
      code: 2,
      covered: 1,
      tests: 0,
      notMeasured: 1,
      deleted: 1,
      other: 1,
    });
    const price = impact.files.find((f) => f.path === "packages/app/src/price.ts");
    assert.equal(
      price.tests,
      1,
      "checkout.test -> checkout.js(.tsx) -> ./cart (index.ts) -> @/price",
    );
    assert.deepEqual(price.nearestTests, ["packages/app/src/checkout.test.tsx"]);
    assert.equal(impact.files.find((f) => f.path === "packages/app/src/lonely.ts").tests, 0);
    assert.deepEqual(
      impact.dependents,
      ["packages/app/src/cart/index.ts", "packages/app/src/checkout.tsx"],
      "production dependents only, from the committed tree",
    );
    assert.deepEqual(impact.notMeasured, [{ path: "tools/report.py", language: "Python" }]);
    assert.ok(
      impact.files.every((f) => !path.isAbsolute(f.path) && !f.path.includes(repo.dir)),
      "repo-relative paths only",
    );
    assert.equal(
      describeImpact(impact, 3),
      "Touches 3 parts of the system and 5 files; 1 of the 2 code files are covered by tests. 1 file is in another language and was not checked for tests.",
    );
    // A bare revision means "from there to HEAD".
    assert.equal(measureImpact({ root: repo.dir, range: base }).range, `${base}..HEAD`);
  } finally {
    repo.done();
  }
});

test("any repository: refuses option-like ranges and unknown commits", () => {
  const never = () => {
    throw new Error("git must not run");
  };
  for (const bad of ["--output=/tmp/x", "a b", "-p", "a....b"])
    assert.throws(() => measureImpact({ root: ".", range: bad, git: never }), /Not a range/, bad);
  const repo = productRepo();
  try {
    repo.write("a.ts", "export {}\n");
    repo.commit();
    assert.throws(
      () => measureImpact({ root: repo.dir, range: `HEAD..${"f".repeat(40)}` }),
      /No such commit/,
    );
  } finally {
    repo.done();
  }
});

test("the plain sentence reads naturally when every changed file is code", () => {
  const impact = { counts: { changed: 14, code: 14, covered: 9, notMeasured: 0 } };
  assert.equal(
    describeImpact(impact, 3),
    "Touches 3 parts of the system and 14 files; 9 of the 14 are covered by tests.",
  );
  assert.equal(
    describeImpact({ counts: { changed: 1, code: 0, covered: 0, notMeasured: 0 } }),
    "Touches 1 file; it is not code that tests could cover.",
  );
});

test("tsconfig parsing and alias scoping", () => {
  assert.deepEqual(parseJsonc('{"a": "// not a comment", /* x */ "b": [1,],}'), {
    a: "// not a comment",
    b: [1],
  });
  const aliases = aliasesFrom([
    {
      path: "packages/app/tsconfig.json",
      text: '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    },
    { path: "tsconfig.json", text: "not json" },
  ]);
  assert.deepEqual(aliases, [
    { scope: "packages/app/", prefix: "@/", targets: ["packages/app/src/"] },
  ]);
  const known = new Set(["packages/app/src/x.ts", "packages/server/src/x.ts"]);
  assert.equal(
    resolveSpecifier(known, "packages/app/src/a.ts", "@/x", aliases),
    "packages/app/src/x.ts",
  );
  assert.equal(
    resolveSpecifier(known, "packages/server/src/a.ts", "@/x", aliases),
    null,
    "an alias applies only under its own tsconfig",
  );
  assert.equal(
    resolveSpecifier(known, "packages/app/src/a.ts", "react", aliases),
    null,
    "packages are not followed",
  );
  assert.deepEqual(
    [classify("a.py"), classify("a.test.ts"), classify("a.md"), classify("a.ts", "D")].map(
      (c) => c.kind,
    ),
    ["not-measured", "test", "other", "deleted"],
  );
});

test("small numbers read as words", () => {
  const say = (changed, code, covered, parts = null) =>
    describeImpact({ counts: { changed, code, covered, notMeasured: 0 } }, parts);
  assert.equal(say(1, 1, 0), "Touches 1 file; it is not covered by tests.");
  assert.equal(
    say(3, 1, 1, 2),
    "Touches 2 parts of the system and 3 files; the 1 code file is covered by tests.",
  );
  assert.equal(
    say(4, 4, 0, 0),
    "Touches 4 files and no part of the system; none of the 4 are covered by tests.",
  );
  assert.equal(say(1, 0, 0), "Touches 1 file; it is not code that tests could cover.");
});

// FULCRA(partial-clone): a --filter=blob:none clone must not fetch every blob to size the tree.
test("partial clone: measures the change without fetching blobs it does not read", () => {
  const repo = productRepo();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "j7-impact-clone-"));
  try {
    repo.git("config", "uploadpack.allowFilter", "true");
    repo.git("config", "uploadpack.allowAnySHA1InWant", "true");
    repo.write("src/price.ts", "export const price = 1;\n");
    repo.write("src/price.test.ts", "import { price } from './price';\n");
    const base = repo.commit();
    repo.write("src/price.ts", "export const price = 2;\n");
    repo.write("assets/picture.png", Buffer.alloc(2 * 1024 * 1024, 7));
    const head = repo.commit();
    const picture = repo.git("rev-parse", `${head}:assets/picture.png`);
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${repo.dir}`, clone]);
    const local = (oid) => {
      try {
        execFileSync("git", ["cat-file", "-e", oid], {
          cwd: clone,
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(local(picture), false);
    const impact = measureImpact({ root: clone, range: `${base}..${head}` });
    assert.equal(impact.counts.changed, 2);
    assert.equal(impact.counts.covered, 1);
    assert.equal(local(picture), false, "the picture blob was fetched");
  } finally {
    repo.done();
    fs.rmSync(clone, { recursive: true, force: true });
  }
});
