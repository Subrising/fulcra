// H7-REPORT.md mutation run (BRIEF-H7-SELF-DRIVING items 1-6, control side). Not a test file (no .test. in the name).
//
//   node src/control/h7.mutations.mjs [ID...]
//
// Same contract as h6.mutations.mjs: apply exact-anchor edits, run the named suite, require the named test to FAIL,
// restore the original bytes in a finally. An anchor that is not exactly once aborts the run.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  at = (f) => path.join(here, f);
const UL = at("usage-limits.mjs"),
  UT = at("usage-limits.test.mjs"),
  NA = at("native.mjs"),
  SID = at("session-id.test.mjs");
const CT = at("controller.mjs"),
  CA = at("carry.mjs"),
  CAT = at("carry.test.mjs"),
  WK = at("wakes.mjs"),
  WT = at("wakes.test.mjs");
const GU = at("admission-guard.mjs"),
  QU = at("questions.mjs"),
  QT = at("questions.test.mjs"),
  PM = at("permissions.mjs");
const PR = at("provider-recovery.mjs"),
  PT = at("provider-recovery.test.mjs"),
  SW = at("seat-sweep.mjs"),
  BR = at("boot-reestablishment.mjs"),
  ST = at("sweep-team.test.mjs");
const M = [
  // item 3: the real weekly line
  {
    id: "H7a",
    why: 'weekly "at" form rejected again',
    suite: UT,
    expect: "H7: the real weekly line",
    edits: [
      [
        UL,
        "resets ((?:[A-Z][a-z]{2} \\d{1,2}(?:,| at) )?",
        "resets ((?:[A-Z][a-z]{2} \\d{1,2}, )?",
      ],
    ],
  },
  // item 5: SESSION-ID
  {
    id: "H7b",
    why: "SESSION-ID written through whatever is planted there",
    suite: SID,
    expect: "a planted symlink, FIFO or HARD LINK",
    edits: [
      [NA, "fd = fs.openSync(temporary,", "fd = fs.openSync(target,"],
      [
        NA,
        "fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW",
        "fs.constants.O_CREAT | fs.constants.O_TRUNC",
      ],
      [NA, "fs.renameSync(temporary, target);", ""],
    ],
  },
  // item 4: carry-forward (G18)
  {
    id: "H7c1",
    why: "handback carries nothing",
    suite: CAT,
    expect: "G18: after a restart",
    edits: [
      [
        CT,
        "try { grant.carried = this.store.atomic(() => carryAuthority(this.store.db, id)); }",
        "try { grant.carried = { from: null }; }",
      ],
    ],
  },
  {
    id: "H7c2",
    why: "an older generation is revived",
    suite: CAT,
    expect: "only the generation it was last delegated at",
    edits: [
      [CA, "if (grant && grant.generation === from) {", "if (grant && grant.generation <= from) {"],
      [
        CA,
        "'UPDATE manager_grants SET generation=? WHERE supervisor=? AND epoch=? AND generation=?').run(to, id, grant.epoch, from)",
        "'UPDATE manager_grants SET generation=? WHERE supervisor=? AND epoch=?').run(to, id, grant.epoch)",
      ],
    ],
  },
  {
    id: "H7c3",
    why: "a released seat’s grant is carried",
    suite: CAT,
    expect: "only the generation it was last delegated at",
    edits: [[CA, "const seatHeld = !seat || Boolean(", "const seatHeld = true || Boolean("]],
  },
  {
    id: "H7c4",
    why: "a revoked routine grant is carried",
    suite: CAT,
    expect: "only the generation it was last delegated at",
    edits: [
      [CA, "WHERE session=? AND revoked=0 AND generation=?", "WHERE session=? AND generation=?"],
    ],
  },
  {
    id: "H7c5",
    why: "a worker of a re-issued manager epoch is carried",
    suite: CAT,
    expect: "a worker whose manager started a new epoch",
    edits: [
      [
        CA,
        "const sameManager = !owned || Boolean(manager && owned.epoch === manager.epoch && owned.generation === from);",
        "const sameManager = true;",
      ],
    ],
  },
  {
    id: "H7c6",
    why: "links follow a grant that was not carried",
    suite: CAT,
    expect: "only the generation it was last delegated at",
    edits: [[CA, "(out.managerGrant || (!grant && !team))", "true"]],
  },
  // items 1-2: wakes and heartbeat
  {
    id: "H7w1",
    why: "a wake reaches a human-held seat",
    suite: WT,
    expect: "never to a human-held seat",
    edits: [[WK, "      if (h.mode !== 'delegated') continue;\n", ""]],
  },
  {
    id: "H7w2",
    why: "a running turn is reported as ended",
    suite: WT,
    expect: "a role session that ends its turn",
    edits: [[WK, "if (c?.ended) this.enqueue(", "if (c) this.enqueue("]],
  },
  {
    id: "H7w3",
    why: "a replaced holder is woken for its old sessions",
    suite: WT,
    expect: "never to a human-held seat",
    edits: [[WK, " AND b.session=o.parentSession", ""]],
  },
  {
    id: "H7w4",
    why: "the heartbeat repeats within one idle stretch",
    suite: WT,
    expect: "the heartbeat nudges an idle seat",
    edits: [[WK, "['heartbeat', new Date(since).toISOString()]", "['heartbeat', this.now()]"]],
  },
  {
    id: "H7w5",
    why: "the heartbeat fires with no active work",
    suite: WT,
    expect: "the heartbeat nudges an idle seat",
    edits: [[WK, "        if (!active.length) continue;\n", ""]],
  },
  {
    id: "H7w6",
    why: "a busy seat is retried forever",
    suite: WT,
    expect: "bounded: changes are batched",
    edits: [
      [WK, "if (attempts >= MAX_WAKE_ATTEMPTS) mark('failed');", "if (false) mark('failed');"],
    ],
  },
  // item 5: questions
  {
    id: "H7q1",
    why: "the guard answers a tool permission",
    suite: QT,
    expect: "the guard admits exactly the journaled answer",
    edits: [[GU, "request.kind !== 'question' || ", ""]],
  },
  {
    id: "H7q2",
    why: "the guard admits a response other than the journaled one",
    suite: QT,
    expect: "the guard admits exactly the journaled answer",
    edits: [[GU, "canonicalPermission(response) !== body.response || ", ""]],
  },
  {
    id: "H7q3",
    why: "a question on a human turn is answered",
    suite: QT,
    expect: "the controller refuses",
    edits: [
      [
        QU,
        "if (origin?.kind !== 'send' || origin.session !== sessionId || origin.state !== 'delivered') throw",
        "if (false) throw",
      ],
    ],
  },
  {
    id: "H7q4",
    why: "the routine verifier reads question intents",
    suite: QT,
    expect: "never read by the routine-permission paths",
    edits: [
      [
        PM,
        "WHERE state IN ('acknowledged','uncertain') AND pool NOT LIKE 'question:%'\")",
        "WHERE state IN ('acknowledged','uncertain')\")",
      ],
    ],
  },
  {
    id: "H7q5",
    why: "question intents become routine uncertain on restart",
    suite: QT,
    expect: "never read by the routine-permission paths",
    edits: [
      [PM, "WHERE state='intent' AND pool NOT LIKE 'question:%'\")", "WHERE state='intent'\")"],
    ],
  },
  // items 3-4: provider recovery
  {
    id: "H7r1",
    why: "a human-held session is restarted",
    suite: PT,
    expect: "never a human’s session",
    edits: [
      [
        PR,
        "if (s.mode !== 'delegated') return this.finish(r.id, 'held', 'Under human control; the controller does not restart it');",
        "",
      ],
      [PR, "s.mode === 'delegated' ? 'waiting' : 'held'", "'waiting'"],
      [
        PR,
        "if (Number(inserted.changes) && s.mode !== 'delegated') this.finish",
        "if (false) this.finish",
      ],
    ],
  },
  {
    id: "H7r2",
    why: "a Codex quota stop restarts without permission to use",
    suite: PT,
    expect: "a Codex usage limit waits",
    edits: [[PR, "if (decision.state !== 'ready') {", "if (false) {"]],
  },
  {
    id: "H7r3",
    why: "B2: a failure is recovered once per session, ever",
    suite: PT,
    expect: "review H7 B2",
    edits: [
      [
        PR,
        "if (prior && (prior.state === 'waiting' || !prior.cleared)) return prior;",
        "if (prior) return prior;",
      ],
    ],
  },
  {
    id: "H7r4",
    why: "a refusing host is retried forever",
    suite: PT,
    expect: "bounded: a refusing host",
    edits: [
      [
        PR,
        "if (attempts >= MAX_ATTEMPTS) return this.finish(r.id, 'failed'",
        "if (false) return this.finish(r.id, 'failed'",
      ],
    ],
  },
  {
    id: "H7r5",
    why: "human input before the restart is ignored",
    suite: PT,
    expect: "never a human’s session",
    edits: [
      [
        PR,
        "if (observed.archivedAt || (observed.boot ?? null) !== cur.boot || observed.humanAt >= cur.grantedAt || this.control.promptIdentityChanged(observed, cur)) {",
        "if (false) {",
      ],
    ],
  },
  {
    id: "H7r6",
    why: "the daily bound is gone",
    suite: PT,
    expect: "bounded: a refusing host",
    edits: [[PR, "if (today >= MAX_RECOVERIES_PER_DAY) return", "if (false) return"]],
  },
  // item 4: the team sweep
  {
    id: "H7s1",
    why: "the sweep takes any stale session",
    suite: ST,
    expect: "sweep candidates",
    edits: [
      [SW, "stale.filter(r => !r.seated && ownedBySeat(db, r.id))", "stale.filter(r => !r.seated)"],
    ],
  },
  {
    id: "H7s2",
    why: "R7 no longer admits the team",
    suite: ST,
    expect: "R7 admits",
    edits: [[BR, "if (!facts.seated && !facts.owned)", "if (!facts.seated)"]],
  },
  // review fixes
  {
    id: "H7r7",
    why: "B2: leaving the error never clears the episode",
    suite: PT,
    expect: "review H7 B2",
    edits: [
      [
        PR,
        "    this.db.prepare(\"UPDATE provider_recoveries SET cleared=1 WHERE session=? AND cleared=0 AND state!='waiting'\").run(a.id);\n",
        "",
      ],
    ],
  },
  {
    id: "H7w7",
    why: "M1: a busy seat spends attempts",
    suite: WT,
    expect: "bounded: changes are batched",
    edits: [
      [
        WK,
        "      if (!['idle', 'closed'].includes(hs?.status) || (hs?.pendingPermissions?.length ?? 0) > 0) continue;\n",
        "",
      ],
      [WK, "        if (e instanceof RecipientBusy) continue;", ""],
    ],
  },
  {
    id: "H7w8",
    why: "queued wakes never expire",
    suite: WT,
    expect: "never to a human-held seat",
    edits: [[WK, "SET state='expired' WHERE", "SET state=state WHERE"]],
  },
  {
    id: "H7q6",
    why: "B1: a delivered id is re-routed to an answer",
    suite: QT,
    expect: "review H7 B1",
    edits: [[QU, "    if (this.store.delivery(messageId)) return false;\n", ""]],
  },
  {
    id: "H7q7",
    why: "B1: an answered id is re-routed to a send",
    suite: QT,
    expect: "review H7 B1",
    edits: [
      [
        QU,
        "    if (intent) { if (intent.session !== sessionId || JSON.parse(intent.body).kind !== 'question-answer') throw Error('Answer identity conflict'); return true; }\n",
        "",
      ],
    ],
  },
  {
    id: "H7q8",
    why: "M2: a question is answered without bound",
    suite: QT,
    expect: "review H7 M2",
    edits: [
      [
        QU,
        "get(pool, request.id).n >= MAX_ANSWERS_PER_QUESTION) throw",
        "get(pool, request.id).n >= Infinity) throw",
      ],
    ],
  },
  {
    id: "H7c7",
    why: "M3: a routine grant is carried past the live bound",
    suite: CAT,
    expect: "review H7 M3",
    edits: [[CA, "if (live < LIVE_GRANT_LIMIT) out.routineGrant", "if (true) out.routineGrant"]],
  },
  {
    id: "H7s3",
    why: "a human-held seat’s team is swept",
    suite: ST,
    expect: "sweep candidates",
    edits: [[SW, "      JOIN sessions h ON h.id=o.parentSession AND h.mode='delegated'\n", ""]],
  },
];
export { M };

function failing(suite) {
  let out;
  try {
    out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", suite], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1]);
}
const only = process.argv.slice(2);
let bad = 0;
for (const m of M.filter((x) => !only.length || only.includes(x.id))) {
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      const text = originals.get(file) ?? fs.readFileSync(file, "utf8");
      originals.set(file, text);
      const current = fs.readFileSync(file, "utf8");
      if (current.split(from).length !== 2)
        throw Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(
        file,
        current.replace(from, () => to),
      );
    }
    const failed = failing(m.suite),
      killed = failed.some((name) => name.includes(m.expect));
    if (!killed) bad++;
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"} ${m.id.padEnd(5)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.length ? failed.map((n) => n.slice(0, 40)).join(" | ") : "none"}`,
    );
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(bad ? `${bad} mutation(s) SURVIVED` : "all mutations killed");
process.exitCode = bad ? 1 : 0;
