import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { changeDigest, changeEvidence, trailerRefs } from "./change-evidence.mjs";
import { parseRef, plainLanguageCheck } from "../orca-organization/shared/cc/refs.mjs";
import { canonicalJson } from "../orca-organization/shared/cc/decision-rules.mjs";

const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/changes/${name}.ir.json`, import.meta.url), "utf8");
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const PR = "pr:github:example/shop#17";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "j7-evidence-"));
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
  const commit = (message, trailers = []) => {
    git("add", "-A");
    git("commit", "-q", "-m", [message, "", ...trailers].join("\n"));
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  return {
    root,
    git,
    write,
    commit,
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("a PR that changes the map: before/after refs, sessions and task from trailers, one plain sentence", async () => {
  const repo = repository();
  try {
    repo.write("src/orders.js", "export const orders = 1;\n");
    repo.write("src/orders.test.js", "import './orders.js';\n");
    repo.write(".fulcra/architecture/shop.ir.json", fixture("base"));
    repo.commit("start");
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("src/orders.js", "export const orders = 2;\n");
    repo.write("src/search.js", "export const search = 1;\n");
    repo.commit("add search", [`Fulcra-Task: ${TASK}`, `Fulcra-Session: ${SESSION_A}`]);
    repo.write(".fulcra/architecture/shop.ir.json", fixture("head"));
    const head = repo.commit("map search", [
      `Fulcra-Task: ${TASK}`,
      `Fulcra-Session: ${SESSION_B}`,
      "Fulcra-Session: not-a-uuid",
    ]);
    repo.git("checkout", "-q", "main");
    repo.write("unrelated.md", "later work on main\n");
    const mainTip = repo.commit("main moved on");

    const e = await changeEvidence({ root: repo.root, prRef: PR, base: "main", head: "feature" });
    const base = repo.git("merge-base", mainTip, head);
    assert.equal(e.head, head);
    assert.equal(e.base, base, "the PR is measured from where it left main, not main's newer tip");
    assert.deepEqual(e.evidence, [
      { ref: PR, label: "The pull request" },
      {
        ref: `archmap:github:example/shop@${base}:shop`,
        label: "The system map before this change (shop)",
      },
      {
        ref: `archmap:github:example/shop@${head}:shop`,
        label: "The system map after this change (shop)",
      },
      { ref: `session:${SESSION_A}`, label: "A work session that made this change" },
      { ref: `session:${SESSION_B}`, label: "A work session that made this change" },
      { ref: `task:${TASK}`, label: "The task this change was made for" },
    ]);
    for (const { ref } of e.evidence)
      assert.ok(parseRef(ref), `${ref} parses with the shared parser`);
    assert.equal(
      e.summary,
      "Touches 3 parts of the system and 3 files; 1 of the 2 code files are covered by tests. 1 other part depends on the parts that changed.",
    );
    assert.deepEqual(plainLanguageCheck(e.summary), [], "fit for a level-1 packet");
    assert.equal(e.outOfDate, false);
    assert.equal(e.blastRadius, `archmap:github:example/shop@${head}:shop`);
    assert.deepEqual(e.action, { type: "change", prRef: PR, digest: changeDigest(head) });
  } finally {
    repo.done();
  }
});

test("the action digest is what the decision store recomputes for a binder returning the head sha", () => {
  const head = "a".repeat(40);
  assert.equal(changeDigest(head), createHash("sha256").update(canonicalJson(head)).digest("hex"));
  assert.equal(changeDigest(head), createHash("sha256").update(JSON.stringify(head)).digest("hex"));
});

test("a significant change that left the map alone says the picture may be out of date", async () => {
  const repo = repository();
  try {
    repo.write("services.yaml", "orders: {}\n");
    const cited = JSON.parse(fixture("base"));
    cited.cards[0].items[0] = `services.yaml SHA256 ${createHash("sha256").update("orders: {}\n").digest("hex").slice(0, 8)}`;
    repo.write(".fulcra/architecture/shop.ir.json", JSON.stringify(cited));
    const base = repo.commit("start");
    repo.write("services.yaml", "orders: {}\nsearch: {}\n");
    const head = repo.commit("add search to the definitions only");
    const e = await changeEvidence({ root: repo.root, prRef: PR, base, head });
    assert.equal(e.outOfDate, true, "a cited source changed and no map did");
    assert.match(
      e.summary,
      /Touches 1 file and no part of the system; it is not code that tests could cover\. The system map was not updated with this work, so its picture may be out of date\./,
    );
    assert.deepEqual(plainLanguageCheck(e.summary), []);
  } finally {
    repo.done();
  }
});

test("no map, an unlinkable map name, and a bad PR ref", async () => {
  const repo = repository();
  try {
    repo.write("a.js", "export {}\n");
    const base = repo.commit("start");
    repo.write("a.js", "export const a = 1;\n");
    const head = repo.commit("change");
    const none = await changeEvidence({ root: repo.root, prRef: PR, base, head });
    assert.match(
      none.summary,
      /^Touches 1 file; it is not covered by tests\. This project has no system map yet/,
    );
    assert.equal(none.blastRadius, null);
    assert.deepEqual(none.evidence, [{ ref: PR, label: "The pull request" }]);

    // A name the shared grammar refuses (it must start with a letter or digit) is compared but not linked.
    repo.write(".fulcra/architecture/_draft.ir.json", fixture("head"));
    const withOddName = repo.commit("odd name");
    const odd = await changeEvidence({ root: repo.root, prRef: PR, base: head, head: withOddName });
    assert.match(odd.warnings.join("\n"), /"_draft" cannot be linked/);
    assert.equal(odd.evidence.filter((x) => x.ref.startsWith("archmap:")).length, 0);

    await assert.rejects(
      changeEvidence({ root: repo.root, prRef: "issue:github:example/shop:#1", base, head }),
      /pull request ref/,
    );
  } finally {
    repo.done();
  }
});

// R-C-J7-3 (CONTRACTS §2.1 v1.9): archmap refs come from the one shared parser, so every name its grammar allows is
// linked, including capitals, dots and underscores. This branch's shared refs.mjs predates v1.9 (J0 owns that repair),
// so the second test waits, as a todo, until the merged shared parser accepts these names; it then runs for real.
const V19_NAMES = ["Shop_Map", "Core.map"];
const sharedAcceptsV19 = V19_NAMES.every(
  (name) => parseRef(`archmap:github:example/shop@${"a".repeat(40)}:${name}`)?.kind === "archmap",
);
async function evidenceFor(name) {
  const repo = repository();
  try {
    repo.write(`.fulcra/architecture/${name}.ir.json`, fixture("base"));
    const base = repo.commit("start");
    repo.write(`.fulcra/architecture/${name}.ir.json`, fixture("head"));
    const head = repo.commit("change the map");
    return { head, base, e: await changeEvidence({ root: repo.root, prRef: PR, base, head }) };
  } finally {
    repo.done();
  }
}
test("archmap refs are exactly what the shared parser accepts, never a local grammar", async () => {
  for (const name of ["shop", ...V19_NAMES]) {
    const { e } = await evidenceFor(name);
    const accepted =
      parseRef(`archmap:github:example/shop@${"a".repeat(40)}:${name}`)?.kind === "archmap";
    const refs = e.evidence.filter((x) => x.ref.startsWith("archmap:")).map((x) => x.ref);
    assert.equal(refs.length, accepted ? 2 : 0, name);
    for (const ref of refs) assert.equal(parseRef(ref)?.mapName, name);
  }
});
test(
  "v1.9 map names such as Shop_Map and Core.map are linked",
  { todo: sharedAcceptsV19 ? false : "waits for the v1.9 shared refs.mjs (J0) to merge" },
  async () => {
    for (const name of V19_NAMES) {
      const { e, base, head } = await evidenceFor(name);
      assert.deepEqual(
        e.evidence.filter((x) => x.ref.startsWith("archmap:")).map((x) => x.ref),
        [
          `archmap:github:example/shop@${base}:${name}`,
          `archmap:github:example/shop@${head}:${name}`,
        ],
      );
      assert.equal(e.blastRadius, `archmap:github:example/shop@${head}:${name}`);
      assert.equal(e.warnings.filter((w) => /cannot be linked/.test(w)).length, 0);
    }
  },
);

test("trailers: uuids only, oldest first, each once", () => {
  const log = [`${SESSION_B}\t${TASK}`, `${SESSION_A} ${SESSION_B}\t`, "nonsense\tnot-a-task"].join(
    "\n",
  );
  assert.deepEqual(trailerRefs(log), { sessions: [SESSION_A, SESSION_B], tasks: [TASK] });
});
