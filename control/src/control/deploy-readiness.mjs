import { localJson } from "../local-machine.mjs";
// Go/no-go for deploying the admission guard and controller, measured now rather than read.
//
//   node src/control/deploy-readiness.mjs
//
// Every precondition here is taken from DEPLOYMENT-DECISION.md. None is invented, and none is left out
// for being awkward to measure -- the two that cannot be measured from this repository are printed as
// decisions someone still has to make, not quietly dropped.
//
// That packet exists because its own numbers decay faster than the decision they support: it has carried
// a boot-disk figure wrong by an order of magnitude and a quiescence table that was true in the morning
// and false by the afternoon. Its text now says "Measure it; do not read it", which nobody does, because
// measuring means running eight commands and knowing which. This runs them and prints each one, so the
// reader can re-run a single line instead of trusting this tool. It must not become the next stale
// number.
//
// It does not deploy, restart, take over, send or write anything.
//
// It used to. Quiescence was measured with the controller's `observe` RPC, which is controller.inspect(),
// which takes over a delegated session whose last prompt is not the one it expects -- and a session that
// has simply FINISHED THE TURN YOU SENT IT met that condition, so the check ended the delegations it was
// reporting on. Three of four delegated seats were taken over by it in one sequence.
//
// The measurement now asks the DAEMON instead, which answers status and pending without any takeover:
// `paseo inspect <id> --json`, or the same read through the client SDK, authenticated with the daemon
// home's controller.secret. The controller is still asked which sessions are delegated, because `list`
// is a plain journal read and takes nothing over. That warning is gone from the note below because it
// stopped being true, not because it stopped being inconvenient.
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { controlHome, operatorSecret, reader } from "./control-read.mjs";
import { portable } from "../portable-config.mjs";
import { releasePaths } from "./release-paths.mjs";
import { createPaseoApi, DaemonClient } from "./client-sdk.mjs";

// The controller is asked only which sessions are delegated. `list` is a journal read: it projects rows
// and takes nothing over. `observe` is deliberately NOT here -- see the header.
export const READS = ["list"];
export const DAEMON_URL = portable?.url ?? "ws://127.0.0.1:6791/ws";
export const DAEMON_SECRET = portable
  ? portable.daemonHome + "/controller.secret"
  : releasePaths().daemonSecret;
// DEPLOYMENT-DECISION.md §2: "Window A needs roughly 360 MB transiently to install a 180 MB image."
export const BOOT_DISK_MB = 360;
export const GUARD_PATH = "src/control/admission-guard.mjs";
// Where the released modules actually live: the same `base` deploy-admission.mjs uses (release-paths.mjs).
export const ADMISSION_BASE_DIR = releasePaths().admissionBase;
export const GO = "GO",
  NOGO = "NO-GO";

// The recurring defect in this mission is an unknown reported as a definite. So a check has three
// possible inputs and only two possible verdicts: ok true is GO, ok false is NO-GO, and ok null -- could
// not measure -- is also NO-GO. There is deliberately no path from "I could not look" to GO.
export const check = ({ id, title, ok, measured, command, consequence, note = null }) => ({
  id,
  title,
  command,
  consequence,
  note,
  measured: ok === null ? `could not measure: ${measured}` : measured,
  verdict: ok === true ? GO : NOGO,
  certainty: ok === null ? "unmeasured" : "measured",
});

// DEPLOYMENT-DECISION.md §1. Green requires every delegated session idle with pending 0. An in-flight
// turn is the case the hold exists to prevent: unlike a takeover while idle, in-flight work is LOST
// rather than merely re-delegated.
export function quiescence(sessions, observations) {
  const delegated = (sessions ?? []).filter((s) => s.mode === "delegated");
  const common = {
    id: "quiescence",
    title: "Session quiescence -- all delegated sessions idle, pending 0",
    command: "paseo inspect <id> --json   # per delegated id from the controller's list",
    consequence:
      "Restarting over an in-flight turn loses that work outright; a takeover while idle only re-delegates it.",
  };
  if (!Array.isArray(sessions))
    return check({ ...common, ok: null, measured: "the session list did not answer" });
  // Zero delegated sessions is not proof of quiet. The packet expects four, so an empty result is more
  // likely a read that went wrong than a fleet that went idle, and it is reported as unknown.
  if (!delegated.length)
    return check({
      ...common,
      ok: null,
      measured: "no delegated sessions found, and the packet expects four",
    });
  const seen = delegated.map((s) => ({ id: s.id, o: observations?.[s.id] }));
  const unreadable = seen.filter(({ o }) => !o || o.__error || o.error || !o.observed);
  if (unreadable.length)
    return check({
      ...common,
      ok: null,
      measured: `${unreadable.length} of ${delegated.length} delegated session(s) could not be observed: ${unreadable.map((u) => `${short(u.id)} (${u.o?.__error ?? u.o?.error ?? "no observation"})`).join(", ")}`,
    });
  const busy = seen.filter(
    ({ o }) => o.observed.status !== "idle" || (o.observed.pending ?? 0) > 0,
  );
  return check({
    ...common,
    ok: !busy.length,
    measured: busy.length
      ? `${busy.length} of ${delegated.length} not quiet: ${busy.map((b) => `${short(b.id)} status=${b.o.observed.status} pending=${b.o.observed.pending ?? 0}`).join(", ")}`
      : `all ${delegated.length} delegated session(s) idle, pending 0`,
    note: "A snapshot of a moving thing: sessions go idle between turns and are dispatched again. Re-measure immediately before the restart, not once. Measuring it is now free: the daemon answers status and pending without taking the session over.",
  });
}

// Opens a plain read connection to the daemon: no permission channel, no agent watch, and no
// verifyActivation, because none of those is needed to read a status and none of them is free. The
// connector is injectable so an unreachable daemon is a tested path rather than an assumed one.
export async function connectDaemon({ url = DAEMON_URL, secretFile = DAEMON_SECRET } = {}) {
  const password = fs.readFileSync(secretFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error("Invalid controller credential");
  const daemon = new DaemonClient({
    clientId: "orca-deploy-readiness-" + randomUUID(),
    clientType: "cli",
    url,
    password,
    connectTimeoutMs: 10000,
  });
  await daemon.connect();
  const client = createPaseoApi(daemon);
  return {
    // The same three fields `paseo inspect <id> --json` prints: Status, Mode, PendingPermissions.
    status: async (id) => {
      const agent = client.agents.ref(id);
      await agent.refresh();
      const snapshot = agent.current();
      if (!snapshot) throw new Error("no daemon snapshot for this agent");
      return { status: snapshot.status, pending: snapshot.pendingPermissions?.length ?? 0 };
    },
    close: async () => {
      try {
        await client.dispose();
      } finally {
        await daemon.close();
      }
    },
  };
}

// Reads quiescence for the delegated ids. A daemon that cannot be reached leaves every id unreadable,
// which quiescence() reports as "could not measure" -- NO-GO. There is still no path from not looking
// to GO.
export async function daemonObservations(ids, { connect = connectDaemon } = {}) {
  if (!ids.length) return {};
  let session;
  try {
    session = await connect();
  } catch (e) {
    return Object.fromEntries(
      ids.map((id) => [id, { __error: `daemon unreachable: ${e.message}` }]),
    );
  }
  try {
    const out = {};
    for (const id of ids) {
      try {
        out[id] = { observed: await session.status(id) };
      } catch (e) {
        out[id] = { __error: e.message };
      }
    }
    return out;
  } finally {
    await session.close().catch(() => {});
  }
}

// DEPLOYMENT-DECISION.md §2, whose own history is the argument for measuring: a "3.7 GiB" claim, then a
// "304 MiB at 98%" claim, both wrong by the time they were read.
export function bootDisk(dfText, needMb = BOOT_DISK_MB) {
  const common = {
    id: "boot-disk",
    title: `Boot-disk headroom -- ${needMb} MB needed transiently to install a 180 MB image`,
    command: "df -m /",
    consequence:
      "The install fails part-way with the image unpacked and the old one already replaced.",
  };
  const row = String(dfText ?? "")
    .trim()
    .split("\n")
    .slice(1)
    .find((l) => l.trim());
  const available = Number(row?.trim().split(/\s+/)[3]);
  if (!Number.isFinite(available))
    return check({ ...common, ok: null, measured: "df produced no parseable row" });
  return check({
    ...common,
    ok: available >= needMb,
    measured: `${available} MB available on /, ${needMb} MB needed`,
  });
}

// DEPLOYMENT-DECISION.md §4. The pin is a stopgap for a live system, not the intended state.
export function guardPin(dirtyPaths) {
  const common = {
    id: "guard-pin",
    title: "Admission-guard working-tree pin restored from HEAD",
    command: `git diff --name-only HEAD -- ${GUARD_PATH}`,
    consequence:
      "Deploying the pinned file ships the pre-fix guard, which is the bug this deployment exists to fix.",
  };
  if (dirtyPaths === null || dirtyPaths === undefined)
    return check({ ...common, ok: null, measured: "git did not answer" });
  const pinned = String(dirtyPaths)
    .split("\n")
    .some((l) => l.trim() === GUARD_PATH);
  return check({
    ...common,
    ok: !pinned,
    measured: pinned
      ? `${GUARD_PATH} still differs from HEAD (pinned)`
      : `${GUARD_PATH} matches HEAD`,
    // Both halves are true at once and the reader needs both, so neither is left to inference.
    note: pinned
      ? "This is a NO-GO for deploying AND the correct state for not having deployed yet: the pin is what keeps the RUNNING controller’s activation check passing. Restore it with `git checkout HEAD -- " +
        GUARD_PATH +
        "` as the first step of deployment, not before."
      : "The pin is not in place. If the controller has not been restarted yet, its activation check is reading this file from the working tree.",
  });
}

// The check that would have prevented the 2026-09-22 outage, and it costs nothing.
//
// `deploy-admission.mjs` with NO arguments validates the whole deployment and never calls
// assertStopped(): it compares each released module against admission-base.json, applies every patch in
// memory, syntax-checks the result, and writes runtime/admission-preview/manifest.json -- the very file
// --rollback needs. The outage happened because a script went straight to --apply, which skipped the
// validation AND failed to create its own safety net. One omission, two failures.
//
// So this reproduces the digest half here, where it is free: if the released source has drifted from
// the recorded baseline, no deployment can succeed in any ordering, and nothing needs to be stopped to
// find that out.
// A module differing from admission-base.json has two opposite meanings, and reporting the wrong one
// sends a reader to the wrong work. The baseline records PRISTINE digests, so:
//
//   differs AND imports the guard  -> already patched. The deployment is LIVE. Nothing is wrong.
//   differs AND does not import it -> upstream genuinely moved. Patches need re-anchoring.
//
// This distinction cost real time on 2026-09-22: the digests were compared, every module differed, and
// "drifted" was reported when in fact the guard had been deployed and was working. The digest alone
// cannot tell the two apart -- only looking for the guard can.
export function sourceDrift(current, expected, patched = {}) {
  const common = {
    id: "source-drift",
    title: "Released modules are pristine or patched -- not drifted out from under the patches",
    command:
      "node src/control/deploy-admission.mjs        # no arguments: validates, stops nothing",
    consequence:
      "A module that moved upstream without carrying the guard can no longer be patched: the anchors do not match the shipped source, in any ordering.",
  };
  if (!current || !expected)
    return check({
      ...common,
      ok: null,
      measured: "could not read the released modules or the baseline",
    });
  const names = Object.keys(expected);
  if (!names.length)
    return check({
      ...common,
      ok: null,
      measured: "baseline lists no modules -- the parse is wrong, not the product",
    });
  const differing = names.filter((n) => current[n] !== expected[n]);
  const deployed = differing.filter((n) => patched[n]);
  const drifted = differing.filter((n) => !patched[n]);
  // Everything differing because it carries the guard is the deployed state, which is a GO.
  if (deployed.length && !drifted.length)
    return check({
      ...common,
      ok: true,
      measured: `all ${names.length} module(s) differ from the baseline because the guard is DEPLOYED in them`,
      note: "Not drift. admission-base.json records pristine digests, so a patched module is expected to differ. Compare the guard hash the modules import against the guard at HEAD to see whether the deployed build is current.",
    });
  return check({
    ...common,
    ok: !drifted.length,
    measured: drifted.length
      ? `${drifted.length} of ${names.length} module(s) changed upstream and do NOT carry the guard: ${drifted.join(", ")}` +
        (deployed.length ? ` (${deployed.length} other(s) are patched and fine)` : "")
      : `all ${names.length} module(s) match the baseline`,
    note: drifted.length
      ? "Re-anchor before scheduling anything: confirm every patch anchor still appears exactly once in the changed modules. This is engineering, not scheduling."
      : undefined,
  });
}

// Tracking status is the wrong instrument here: four branches in this repository report [ahead N] while
// being fully pushed, because their upstreams point at release/* refs. Containment is the question that
// was actually meant -- is this tip reachable from any remote branch.
export function unpushedWork({ count, branches } = {}) {
  const common = {
    id: "unpushed",
    title: "No unpushed commits, by containment rather than tracking status",
    command:
      "git rev-list --count HEAD --not --remotes   # and: git branch -r --contains <tip> per local branch",
    consequence:
      "Deploying from a tree whose commits exist nowhere else means the deployed code cannot be recovered or reviewed.",
  };
  if (!Number.isFinite(count) || !Array.isArray(branches))
    return check({ ...common, ok: null, measured: "git did not answer" });
  // A tip that does not look like a tip means the enumeration is wrong, not that work is unpushed.
  // Reporting a parse fault as a finding is the same error as reporting an unknown as a definite.
  // Not "sha must be hex" -- that would also reject the fixtures this module is tested with. The real
  // shape is git's synthetic row: a name that is not a ref name at all, or a tip with no sha.
  const malformed = branches.filter((b) => !b.sha || /^[(]/.test(b.name ?? ""));
  if (malformed.length)
    return check({
      ...common,
      ok: null,
      measured: `branch enumeration returned ${malformed.length} unparsable row(s): ${malformed.map((b) => `${b.name} (${b.sha})`).join(", ")}`,
    });
  const loose = branches.filter((b) => !b.contained);
  return check({
    ...common,
    ok: count === 0 && !loose.length,
    measured:
      count === 0 && !loose.length
        ? `0 unreachable commits; all ${branches.length} local branch tip(s) contained in a remote branch`
        : [
            count > 0 ? `${count} commit(s) on HEAD are on no remote` : null,
            loose.length
              ? `${loose.length} branch tip(s) contained in no remote branch: ${loose.map((b) => `${b.name} (${b.sha})`).join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("; "),
  });
}

// Not measurements, and deliberately not dressed up as checks that were performed. Printing an ordering
// rule as a tick would be a lie about what this tool did.
export const CONSTRAINTS = [
  {
    id: "order",
    title: "The guard ships WITH or BEFORE the controller. Never the reverse.",
    detail:
      "New guard + old controller fails closed, which is safe. New controller + old guard admits role-channel messages with NO re-derivation at all -- strictly worse than today. Order: admission guard, then controller, then restart.",
  },
  {
    id: "window",
    title: "An explicitly agreed restart window (DEPLOYMENT-DECISION.md, Recommendation 3).",
    detail:
      "The restart takes over every delegated session. That is a human decision and nothing here can measure whether it was made.",
  },
  {
    id: "plugin",
    title: "The staged plugin installed and the built app relaunched (Recommendation 5).",
    detail:
      "Outside this repository, so it is listed rather than checked. Not measuring it is not the same as it being done.",
  },
];

const short = (id) =>
  typeof id === "string" && id.length > 12 ? id.slice(0, 8) : String(id ?? "-");
// Worst first, and an unmeasured check outranks a measured failure: a known blocker has an owner and a
// fix, while "could not measure" means nobody yet knows which of the two it is.
const RANK = (r) => (r.verdict === GO ? 2 : r.certainty === "unmeasured" ? 0 : 1);
export const order = (results) => [...results].sort((a, b) => RANK(a) - RANK(b));

export function render(results, constraints = CONSTRAINTS, now = new Date()) {
  const ranked = order(results),
    blocking = ranked.filter((r) => r.verdict !== GO);
  return (
    [
      `DEPLOY READINESS  ${now.toISOString()}`,
      blocking.length
        ? `NO-GO -- ${blocking.length} of ${ranked.length} precondition(s) not satisfied${blocking.some((b) => b.certainty === "unmeasured") ? `, ${blocking.filter((b) => b.certainty === "unmeasured").length} because they could not be measured` : ""}.`
        : `All ${ranked.length} measurable precondition(s) satisfied. The constraints below are still yours to satisfy.`,
      "",
      ...ranked.flatMap((r) => [
        `${r.verdict.padEnd(6)} ${r.certainty === "unmeasured" ? "(UNMEASURED) " : ""}${r.title}`,
        `       measured: ${r.measured}`,
        `       command:  ${r.command}`,
        `       if ignored: ${r.consequence}`,
        ...(r.note ? [`       note: ${r.note}`] : []),
        "",
      ]),
      "CONSTRAINTS -- not checked, because they are not measurements",
      ...constraints.flatMap((c) => [`  - ${c.title}`, `      ${c.detail}`]),
      "",
      "Read-only. This checked nothing into place, started nothing and changed nothing.",
    ].join("\n") + "\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = controlHome(),
    operator = operatorSecret(home),
    ask = reader({ home, reads: READS });
  const git = (args) => {
    try {
      return execFileSync("git", args, { encoding: "utf8" });
    } catch {
      return null;
    }
  };
  const sessions = await ask("list", operator);
  const live = Array.isArray(sessions) ? sessions : null;
  const observations = await daemonObservations(
    (live ?? []).filter((s) => s.mode === "delegated").map((s) => s.id),
  );
  const df = (() => {
    try {
      return execFileSync("df", ["-m", "/"], { encoding: "utf8" });
    } catch {
      return null;
    }
  })();
  // for-each-ref refs/heads, NOT `git branch`: in a detached worktree `git branch` emits a synthetic
  // "(HEAD detached at ...)" row, which parsed as a branch named "(no" with sha "branch)" and was then
  // reported as an unpushed tip -- a NO-GO invented by the tool's own enumeration.
  const tips = (
    git(["for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)"]) ?? ""
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split(" ");
      return {
        name,
        sha: sha.slice(0, 8),
        contained: Boolean(git(["branch", "-r", "--contains", sha])?.trim()),
      };
    });
  const countText = git(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  // Read both sides of the drift comparison here, so the pure function above stays testable.
  const baseline = (() => {
    try {
      return localJson("admission-base.json");
    } catch {
      return null;
    }
  })();
  const carriesGuard = {};
  const released = (() => {
    if (!baseline) return null;
    const out = {};
    for (const name of Object.keys(baseline)) {
      try {
        const bytes = fs.readFileSync(ADMISSION_BASE_DIR + name);
        out[name] = createHash("sha256").update(bytes).digest("hex");
        carriesGuard[name] = bytes.includes("orcaAdmissionGuard");
      } catch {
        out[name] = null;
      }
    }
    return out;
  })();
  console.log(
    render([
      sourceDrift(released, baseline, carriesGuard),
      quiescence(live, observations),
      guardPin(git(["diff", "--name-only", "HEAD", "--", GUARD_PATH])),
      unpushedWork({
        count: countText === null ? null : Number(countText.trim()),
        branches: tips.length ? tips : null,
      }),
      bootDisk(df),
    ]),
  );
}
