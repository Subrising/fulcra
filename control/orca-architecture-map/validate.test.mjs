import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  MAP_DIRECTORY,
  checkContract,
  checkEvidence,
  resolveInside,
  validateFile,
} from "./validate.mjs";

const fixtures = new URL("./fixtures/", import.meta.url);
const headIr = JSON.parse(fs.readFileSync(new URL("head.ir.json", fixtures), "utf8"));
const BASELINE_BICEP_SHA = "ba2a84b8";

/** A throwaway project: the baseline Bicep as the cited source, and a map citing it. */
function project(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "j4-archmap-"));
  fs.copyFileSync(new URL("app.baseline.bicep", fixtures), path.join(root, "app.baseline.bicep"));
  fs.mkdirSync(path.join(root, MAP_DIRECTORY), { recursive: true });
  const ir = structuredClone(headIr);
  ir.cards[0].items = [
    `app.baseline.bicep SHA256 ${BASELINE_BICEP_SHA}`,
    "manually mapped — not compiled/extracted",
  ];
  mutate?.(ir, root);
  const file = `${MAP_DIRECTORY}/defproof.ir.json`;
  fs.writeFileSync(path.join(root, file), typeof ir === "string" ? ir : JSON.stringify(ir));
  return { root, file };
}

function validate(mutate) {
  const { root, file } = project(mutate);
  try {
    return validateFile(root, file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a reviewed map whose cited source hash matches", () => {
  const result = validate();
  assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
});

test("limits match the Fulcra renderer contract", () => {
  assert.equal(LIMITS.maxBytes, 1_048_576);
  assert.equal(LIMITS.maxComponents, 500);
  assert.equal(LIMITS.maxConnections, 2000);
  assert.equal(LIMITS.labelLength, 120);
});

test("refuses a map outside .fulcra/architecture", () => {
  const { root } = project();
  try {
    fs.writeFileSync(path.join(root, "elsewhere.ir.json"), JSON.stringify(headIr));
    assert.match(validateFile(root, "elsewhere.ir.json").errors[0], /^location:/);
    assert.match(validateFile(root, `${MAP_DIRECTORY}/../../x.ir.json`).errors[0], /^location:/);
    assert.match(validateFile(root, `${MAP_DIRECTORY}/map.json`).errors[0], /^location:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a cited source hash that does not match the file", () => {
  const result = validate((ir) => {
    ir.cards[0].items[0] = "app.baseline.bicep SHA256 deadbeef";
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /SHA256 deadbeef does not match ba2a84b8/);
});

test("refuses a map that cites no source", () => {
  const result = validate((ir) => {
    ir.cards = [{ title: "Notes", items: ["hand drawn"] }];
  });
  assert.match(result.errors.join("\n"), /cite at least one source file/);
});

test("refuses a citation that leaves the project root", () => {
  const traversal = validate((ir) => {
    ir.cards[0].items[0] = "../outside.bicep SHA256 ba2a84b8";
  });
  assert.match(traversal.errors.join("\n"), /not found inside the project root/);
  const absolute = validate((ir) => {
    ir.cards[0].items[0] = "/etc/hosts SHA256 ba2a84b8";
  });
  assert.match(absolute.errors.join("\n"), /not found inside the project root|cite at least one/);
});

test("refuses a citation through a symlink that escapes the project root", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "j4-outside-"));
  try {
    fs.copyFileSync(new URL("app.baseline.bicep", fixtures), path.join(outside, "secret.bicep"));
    const result = validate((ir, root) => {
      fs.symlinkSync(path.join(outside, "secret.bicep"), path.join(root, "linked.bicep"));
      ir.cards[0].items[0] = `linked.bicep SHA256 ${BASELINE_BICEP_SHA}`;
    });
    assert.match(result.errors.join("\n"), /linked\.bicep: not found inside the project root/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveInside rejects NUL, empty and dot-dot paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "j4-root-"));
  try {
    assert.equal(resolveInside(root, "a\0b"), null);
    assert.equal(resolveInside(root, ""), null);
    assert.equal(resolveInside(root, "a/../../b"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires the manual-mapping qualifier in the subtitle", () => {
  const result = validate((ir) => {
    ir.meta.subtitle = "Radius definition (no deployment)";
  });
  assert.match(result.errors.join("\n"), /manually mapped/);
});

test("requires the subtitle to say nothing was deployed", () => {
  const result = validate((ir) => {
    ir.meta.subtitle = "Manually mapped from the reviewed Radius definition";
  });
  assert.match(result.errors.join("\n"), /nothing was deployed/);
});

test("warns on text that claims a live observation", () => {
  const result = validate((ir) => {
    ir.connections[0].label = "observed traffic 40 rps";
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /claims a live observation/);
});

test("contract: duplicate ids, dangling edges and bad versions fail", () => {
  const ir = structuredClone(headIr);
  ir.schema_version = 2;
  ir.components[1].id = "environment";
  ir.connections[0].to = "nowhere";
  const errors = checkContract(ir).join("\n");
  assert.match(errors, /schema_version: must be 1/);
  assert.match(errors, /components\.1\.id: duplicate id "environment"/);
  assert.match(errors, /connections\.0\.to: unknown component/);
});

test("contract: ids that name prototype members or paths fail", () => {
  const ir = structuredClone(headIr);
  ir.components[0].id = "__proto__";
  ir.components[1].id = "../app";
  const errors = checkContract(ir).join("\n");
  assert.match(errors, /components\.0\.id: invalid id/);
  assert.match(errors, /components\.1\.id: invalid id/);
});

test("contract: labels, coordinates and counts are capped", () => {
  const ir = structuredClone(headIr);
  ir.components[0].label = "x".repeat(LIMITS.labelLength + 1);
  ir.components[1].pos = [1e9, 0];
  ir.components[2].size = [0, 62];
  const errors = checkContract(ir).join("\n");
  assert.match(errors, /components\.0\.label: longer than 120/);
  assert.match(errors, /components\.1\.pos/);
  assert.match(errors, /components\.2\.size/);
  const many = structuredClone(headIr);
  many.connections = [];
  many.components = Array.from({ length: LIMITS.maxComponents + 1 }, (_, i) => ({
    id: `n${i}`,
    type: "backend",
    label: "n",
    pos: [0, 0],
    size: [1, 1],
  }));
  assert.match(checkContract(many).join("\n"), /components: more than 500/);
});

test("refuses documents over the byte cap or not UTF-8 JSON", () => {
  const big = validate(() => {});
  assert.equal(big.ok, true);
  const { root, file } = project();
  try {
    fs.writeFileSync(path.join(root, file), Buffer.alloc(LIMITS.maxBytes + 1, 0x20));
    assert.match(validateFile(root, file).errors[0], /larger than/);
    fs.writeFileSync(path.join(root, file), Buffer.from([0x7b, 0xff, 0x7d]));
    assert.match(validateFile(root, file).errors[0], /not valid UTF-8 JSON/);
    // A stray invalid byte inside an otherwise valid map must not be silently replaced.
    const text = fs.readFileSync(new URL("head.ir.json", fixtures), "utf8");
    const at = text.indexOf("defproof-app");
    const bytes = Buffer.concat([
      Buffer.from(text.slice(0, at)),
      Buffer.from([0xff]),
      Buffer.from(text.slice(at)),
    ]);
    assert.doesNotThrow(() => JSON.parse(new TextDecoder("utf-8").decode(bytes)));
    fs.writeFileSync(path.join(root, file), bytes);
    assert.match(validateFile(root, file).errors[0], /not valid UTF-8 JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkEvidence never needs anything but the files it cites", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "j4-empty-"));
  try {
    const { errors } = checkEvidence(headIr, root);
    assert.match(errors.join("\n"), /source app\.bicep: not found inside the project root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- The ADW gate (validate.mjs --since <base>) ------------------------------------------------------
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SIGNIFICANT_FILES, mapGate } from "./validate.mjs";

const changes = (name) =>
  JSON.parse(fs.readFileSync(new URL(`changes/${name}.ir.json`, fixtures), "utf8"));
const sha = (text) => createHash("sha256").update(text).digest("hex");
/** A repository on `main` with the example shop's source and a map citing it, then a branch `work`. */
function gateRepo({ withMap = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "j7-gate-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: root,
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const map = (name, source) => {
    const ir = changes(name);
    ir.cards[0].items[0] = `services.yaml SHA256 ${sha(source).slice(0, 12)}`;
    return JSON.stringify(ir, null, 2);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "step");
  };
  git("init", "-q", "-b", "main");
  write("services.yaml", "orders: {}\nreports: {}\n");
  if (withMap) write(`${MAP_DIRECTORY}/shop.ir.json`, map("base", "orders: {}\nreports: {}\n"));
  commit();
  git("checkout", "-q", "-b", "work");
  const touchFiles = (n) => {
    for (let i = 0; i < n; i++) write(`src/file-${i}.js`, `export const n = ${i};\n`);
  };
  return {
    root,
    git,
    write,
    map,
    commit,
    touchFiles,
    gate: (opts) => mapGate({ root, since: "main", ...opts }),
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('gate: a significant change that leaves the map alone is refused with "map not updated"', () => {
  const repo = gateRepo();
  try {
    repo.touchFiles(SIGNIFICANT_FILES);
    repo.commit();
    const result = repo.gate();
    assert.equal(result.ok, false);
    assert.equal(result.significant, true);
    assert.equal(result.mapUpdated, false);
    assert.match(
      result.errors.join("\n"),
      /^Map not updated: this change is significant \(10 files changed/m,
    );
    assert.equal(
      repo.gate({ threshold: 11 }).ok,
      true,
      "below the threshold, and no cited source touched",
    );
  } finally {
    repo.done();
  }
});

test("gate: the same change passes once the map is updated in the branch", () => {
  const repo = gateRepo();
  try {
    repo.touchFiles(SIGNIFICANT_FILES);
    repo.write(`${MAP_DIRECTORY}/shop.ir.json`, repo.map("head", "orders: {}\nreports: {}\n"));
    repo.commit();
    const result = repo.gate();
    assert.deepEqual(
      {
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        mapUpdated: result.mapUpdated,
      },
      { ok: true, errors: [], warnings: [], mapUpdated: true },
    );
    assert.deepEqual(result.updatedMaps, [`${MAP_DIRECTORY}/shop.ir.json`]);
    assert.equal(result.changedFiles, SIGNIFICANT_FILES, "the map file itself is not counted");
  } finally {
    repo.done();
  }
});

test("gate: changing a cited source is significant on its own, and the stale hash is named", () => {
  const repo = gateRepo();
  try {
    repo.write("services.yaml", "orders: {}\nsearch: {}\n");
    repo.commit();
    const stale = repo.gate();
    assert.equal(stale.ok, false);
    assert.deepEqual(stale.reasons, ["a source the map is drawn from changed: services.yaml"]);
    assert.match(stale.errors.join("\n"), /Map not updated/);
    assert.match(
      stale.errors.join("\n"),
      /shop\.ir\.json is out of date: services\.yaml changed since the map cited it/,
    );
    assert.deepEqual(stale.maps[0].stale, ["services.yaml"]);
    assert.equal(
      stale.errors.filter((e) => /does not match/.test(e)).length,
      0,
      "said once, in plain words",
    );
    // Updating the map and re-citing the new hash clears both.
    repo.write(`${MAP_DIRECTORY}/shop.ir.json`, repo.map("head", "orders: {}\nsearch: {}\n"));
    repo.commit();
    assert.deepEqual(repo.gate().errors, []);
  } finally {
    repo.done();
  }
});

test("gate: a small change that touches no cited source passes without a map update", () => {
  const repo = gateRepo();
  try {
    repo.touchFiles(2);
    repo.commit();
    const result = repo.gate();
    assert.equal(result.ok, true);
    assert.equal(result.significant, false);
  } finally {
    repo.done();
  }
});

test("gate: a repository without a map gets a notice, not a refusal", () => {
  const repo = gateRepo({ withMap: false });
  try {
    repo.touchFiles(SIGNIFICANT_FILES);
    repo.commit();
    const result = repo.gate();
    assert.equal(result.ok, true);
    assert.match(result.notices.join("\n"), /has no architecture map yet/);
  } finally {
    repo.done();
  }
});

test("gate: a part whose id changed is flagged (rule 6), and a bad --since is refused", () => {
  const repo = gateRepo();
  try {
    const ir = JSON.parse(repo.map("base", "orders: {}\nreports: {}\n"));
    ir.components.find((c) => c.id === "mail").id = "email-queue";
    ir.connections.find((c) => c.id === "orders-to-mail").to = "email-queue";
    repo.write(`${MAP_DIRECTORY}/shop.ir.json`, JSON.stringify(ir));
    repo.commit();
    const result = repo.gate();
    assert.equal(result.ok, true, "a warning, for the reviewer");
    assert.match(
      result.warnings.join("\n"),
      /"mail" looks renamed to "email-queue"\. Keep the old id \(rule 6\)/,
    );
    assert.throws(() => repo.gate({ since: "--output=x" }), /--since needs a branch or commit/);
    assert.throws(
      () => repo.gate({ since: "no-such-branch" }),
      /Cannot find where this branch left/,
    );
  } finally {
    repo.done();
  }
});

// R-C-J7-1 (CONTRACTS v1.14): the gate reads every map and cited source from one resolved commit. Uncommitted edits,
// to a source or to a map, cannot change its result for a fixed pair of commits.
test("gate: uncommitted edits to sources or maps never change the result for the same commits", () => {
  const repo = gateRepo();
  try {
    const oldSource = "orders: {}\nreports: {}\n",
      newSource = "orders: {}\nsearch: {}\n";
    // Committed: the source changed and the map was edited but still cites the OLD hash, so it is out of date.
    repo.write("services.yaml", newSource);
    const edited = JSON.parse(repo.map("head", oldSource));
    edited.meta.title = "Example shop, edited";
    repo.write(`${MAP_DIRECTORY}/shop.ir.json`, JSON.stringify(edited, null, 2));
    repo.commit();
    const summary = (r) => ({
      ok: r.ok,
      head: r.head,
      errors: r.errors,
      significant: r.significant,
      reasons: r.reasons,
      updatedMaps: r.updatedMaps,
      maps: r.maps,
    });
    const clean = repo.gate();
    assert.equal(clean.ok, false);
    assert.match(clean.errors.join("\n"), /shop\.ir\.json is out of date: services\.yaml changed/);
    // Restore the old source bytes without committing: reading the disk would now make the stale map pass.
    repo.write("services.yaml", oldSource);
    const dirtySource = repo.gate();
    assert.deepEqual(summary(dirtySource), summary(clean));
    assert.match(
      dirtySource.warnings.join("\n"),
      /uncommitted changes; they were not checked\. The gate read commit [0-9a-f]{12} only/,
    );
    // And a dirty map that cites the right hash, or drops the qualifier, is not what the gate reads either.
    repo.write("services.yaml", newSource);
    repo.write(
      `${MAP_DIRECTORY}/shop.ir.json`,
      repo.map("head", newSource).replace("manually mapped", "drawn"),
    );
    assert.deepEqual(summary(repo.gate()), summary(clean));
    // Committing the edits is what changes the answer.
    repo.write(`${MAP_DIRECTORY}/shop.ir.json`, repo.map("head", newSource));
    repo.commit();
    const fixed = repo.gate();
    assert.equal(fixed.ok, true);
    assert.notEqual(fixed.head, clean.head);
  } finally {
    repo.done();
  }
});
