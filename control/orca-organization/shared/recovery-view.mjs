// DESIGN-R R2: the Recovery banner and panel, as pure functions of the controller's recovery-status payload.
// Dependency-free on purpose (like work-messages.mjs), so every rule the UI shows is testable with plain node.
//
// The panel states only what the controller said. It never infers completion ("resumed" is not "completed"),
// never presents the quoted brief as something it will send again, and never calls a local work-state read a
// verification of what a turn did.
import { plainReason } from "./plain-reason.mjs";
const STATES = new Set([
  "interrupted-turn",
  "busy-stale",
  "needs-reconcile",
  "idle-at-restart",
  "control-changed",
  "not-resumable",
]);
export const CHIPS = Object.freeze({
  "interrupted-turn": "Interrupted mid-turn",
  "busy-stale": "Host still reports running",
  "needs-reconcile": "Needs reconcile",
  "idle-at-restart": "Restarted idle",
  "control-changed": "Control changed since the restart",
  "not-resumable": "Not resumable",
});
const CAUSES = Object.freeze({
  boot: "host restart",
  "boot-mid-dispatch": "host restart during a Fulcra dispatch",
  "boot-human": "host restart with human input",
  "human-input": "human input",
  "prompt-identity": "a prompt Fulcra did not send",
  archived: "archived",
  other: "another control change",
});
// U5-D05: what a person reads first -- the cause in plain words, how long ago, and the safe next step. Ids, timestamps,
// the quoted last instruction and the working-tree lines stay available, collapsed, under the card's details.
const CAUSE_PLAIN = Object.freeze({
  boot: "Stopped when the computer or Fulcra restarted",
  "boot-mid-dispatch": "Stopped by a restart while Fulcra was sending it work",
  "boot-human": "Stopped by a restart, and someone typed into it afterwards",
  "human-input": "Paused because someone typed into it directly",
  "prompt-identity": "Paused because it received a message Fulcra did not send",
  archived: "Paused because it was archived",
  other: "Paused because its control changed",
});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "an unknown time");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.round(h / 24);
  return `${days} days ago`;
}
export function nextStep(x) {
  if (x.state === "busy-stale")
    return "Wait a minute and refresh: the host still says this session is running.";
  if (x.state === "needs-reconcile")
    return "Reconcile its unfinished delivery first, then decide whether to resume.";
  if (x.state === "control-changed")
    return "Someone took control after the restart. Open the conversation; nothing is needed here unless it is stuck.";
  if (x.resumable)
    return x.state === "idle-at-restart"
      ? "Nothing was in progress. Resume to hand it back to Fulcra, or dismiss this."
      : "Resume it. Fulcra will ask it to check its work before repeating anything.";
  return `Open the conversation and decide what to do: it cannot be resumed automatically${x.reason ? ` (${String(plainReason(x.reason)).replace(/\.$/, "")})` : ""}.`;
}
const TURNS = Object.freeze({
  interrupted: "The last turn was interrupted by the restart.",
  ended: "The last turn had ended before the restart.",
  unknown: "Whether the last turn finished is unknown.",
});
export const MAX_ITEMS = 64;
const id = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const str = (v, n = 2000) => typeof v === "string" && v.length <= n;
// Structural validation of the controller payload at the plugin boundary. Unknown states are refused rather
// than rendered as something they are not.
export function validateRecovery(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS
  )
    throw Error("Invalid recovery status");
  for (const x of value.items) {
    if (
      !x ||
      !id(x.interruptionId) ||
      !id(x.sessionId) ||
      !STATES.has(x.state) ||
      !Object.hasOwn(CAUSES, x.cause) ||
      !Object.hasOwn(TURNS, x.turn) ||
      typeof x.resumable !== "boolean" ||
      (x.reason !== null && !str(x.reason)) ||
      (x.generation !== null && !Number.isSafeInteger(x.generation))
    )
      throw Error("Invalid recovery item");
    if (x.doing?.brief != null && !str(x.doing.brief, 600)) throw Error("Invalid recovery brief");
  }
  if (!Array.isArray(value.unsettled ?? [])) throw Error("Invalid unsettled deliveries");
  return value;
}
export function repoLine(r) {
  if (r.error) return `${r.path}: could not read (${r.error})`;
  const where = `${r.branch ?? "detached"}${r.head ? " @ " + r.head.slice(0, 7) : ""}`;
  const sync = r.ahead != null ? ` · ↑${r.ahead} ↓${r.behind}` : r.upstream ? "" : " · no upstream";
  const tree = r.clean
    ? "clean"
    : [
        r.modified && `${r.modified} modified`,
        r.unmerged && `${r.unmerged} unmerged`,
        r.untracked && `${r.untracked} untracked`,
      ]
        .filter(Boolean)
        .join(", ");
  return `${r.path}: ${where}${sync} · ${tree}`;
}
// One card per interrupted session. Resume is enabled only when the controller's own dry-run gate allowed it
// AND the observation is fresh; everything the button would do is spelled out before it is pressed.
export function recoveryCard(
  x,
  { fresh = true, busy = false, titles = {}, now = Date.now() } = {},
) {
  const title = titles[x.sessionId] ?? `Session ${String(x.sessionId).slice(0, 8)}`;
  const repos = x.repo?.repos ?? [];
  const leader = Boolean(x.grants?.seated || x.grants?.permission?.root);
  const blocked = !fresh
    ? "The observation is stale; refresh before acting."
    : busy
      ? "Another action is in progress."
      : null;
  return {
    key: x.interruptionId,
    title,
    chip: CHIPS[x.state],
    state: x.state,
    leader,
    headline: `${CAUSE_PLAIN[x.cause]} ${ago(x.since, now)}.`,
    nextStep: nextStep(x),
    details: [
      `Taken over because of ${CAUSES[x.cause]}, at ${when(x.since)}.`,
      `Session ${x.sessionId}`,
      `Interruption ${x.interruptionId}`,
    ],
    cause: `Taken over because of ${CAUSES[x.cause]} · since ${when(x.since)}`,
    turn: TURNS[x.turn],
    doing: x.doing?.brief
      ? {
          text: x.doing.brief,
          label: "Last instruction, as sent by Fulcra (quoted, never re-sent)",
          messageId: x.doing.messageId,
        }
      : { text: null, label: "No Fulcra instruction recorded for this session", messageId: null },
    work: repos.length
      ? repos.map(repoLine)
      : [x.repo?.note ?? "No repository in the session directory"],
    workNote: "Local working-tree state now. It is not a verification of what the turn did.",
    why: x.resumable ? "Ready to resume." : (plainReason(x.reason) ?? "Not resumable."),
    actions: {
      resume: {
        enabled: x.resumable && !blocked,
        reason: blocked ?? (x.resumable ? null : x.reason),
      },
      reconcile: {
        enabled: x.state === "needs-reconcile" && !blocked,
        reason: x.state === "needs-reconcile" ? blocked : "Nothing to reconcile",
      },
      dismiss: { enabled: !blocked, reason: blocked },
    },
  };
}
// What the Resume confirmation shows. It restates what the controller will do; the continuation text itself is
// written by the controller, never by this client.
export function resumePreview(x, note) {
  return [
    "Hands this session back to Fulcra (a new control generation).",
    x.grants?.seat ? "Reissues its role capability (it still has its role)." : null,
    x.grants?.permission
      ? x.grants.permission.root
        ? "Re-confers its routine file grant, unless the operator revoked it."
        : "Re-inherits its routine file grant only if its leader is live."
      : null,
    "Sends ONE controller-written message: it quotes the last instruction, says the previous turn was " +
      { interrupted: "interrupted", ended: "ended", unknown: "of unknown outcome" }[x.turn] +
      ", and tells the session to verify before repeating any external action.",
    note?.trim() ? "Your note is appended, labelled as operator text." : null,
    "The original instruction is not sent again. Resumed does not mean completed.",
  ].filter(Boolean);
}
const ORDER = {
  "interrupted-turn": 0,
  "busy-stale": 1,
  "needs-reconcile": 2,
  "idle-at-restart": 3,
  "control-changed": 4,
  "not-resumable": 5,
};
export function orderItems(items) {
  // Leaders first, because a worker's inherited authority needs its leader live; then by how much attention.
  return [...items].sort(
    (a, b) =>
      Number(Boolean(b.grants?.seated || b.grants?.permission?.root)) -
        Number(Boolean(a.grants?.seated || a.grants?.permission?.root)) ||
      ORDER[a.state] - ORDER[b.state],
  );
}
// The one-line banner. Null when there is nothing to recover, so the surface shows nothing.
// J8 (J7 walkthrough): the headline took the EARLIEST `since` of every outstanding item, so after a second restart it
// named the older restart (H2, 23:32Z) above cards from the newer one (H4, 07:16Z) -- and a takeover by human input
// could stand in for a "host restart". The headline now describes the LATEST restart only: the restart-caused items
// grouped by the boot that observed them, the group whose newest takeover is latest, timed by its first takeover and
// counted on its own. Everything else still outstanding is one trailing count; severity still covers every item.
// J0: the cards follow the headline. recoverySections() puts exactly the headline's sessions first and everything
// else in a labelled trailing section, so no card from another restart sits under the headline. Items with no
// recorded boot never pool into one "unknown" restart spanning several (see RESTART_WINDOW_MS).
const RESTART_CAUSES = new Set(["boot", "boot-mid-dispatch", "boot-human"]);
// J0-7: how items with no recorded boot are grouped. One restart takes its sessions over within moments, so such
// items group by the boot they came from (previousBoot), or else by takeovers no more than this far apart. Items
// minutes apart are different restarts and are never pooled.
export const RESTART_WINDOW_MS = 2 * 60 * 1000;
export function latestRestart(items) {
  const groups = new Map(),
    loose = [];
  for (const x of items)
    if (RESTART_CAUSES.has(x.cause) && x.since) {
      if (!x.observedBoot && !x.previousBoot) {
        loose.push(x);
        continue;
      }
      const key = x.observedBoot ? "boot:" + x.observedBoot : "from:" + x.previousBoot,
        g = groups.get(key) ?? [];
      g.push(x);
      groups.set(key, g);
    }
  let window = null,
    last = -Infinity;
  for (const x of [...loose].sort((a, b) => a.since.localeCompare(b.since))) {
    const at = Date.parse(x.since);
    if (!window || !(at - last <= RESTART_WINDOW_MS)) {
      window = [];
      groups.set("window:" + x.since, window);
    }
    window.push(x);
    last = at;
  }
  let latest = null;
  for (const g of groups.values()) {
    const newest = g
      .map((x) => x.since)
      .sort()
      .at(-1);
    if (!latest || newest > latest.newest)
      latest = { items: g, newest, since: g.map((x) => x.since).sort()[0] };
  }
  return latest;
}
export const EARLIER = "Earlier restarts and other takeovers";
// The panel's card groups, in display order. The first has no title: it is the headline's own restart.
export function recoverySections(items) {
  const restart = latestRestart(items);
  if (!restart) return items.length ? [{ key: "all", title: null, items: orderItems(items) }] : [];
  const latest = new Set(restart.items),
    rest = items.filter((x) => !latest.has(x));
  return [
    { key: "latest", title: null, items: orderItems(restart.items) },
    ...(rest.length ? [{ key: "earlier", title: EARLIER, items: orderItems(rest) }] : []),
  ];
}
export function bannerSummary(status) {
  const all = status?.items ?? [],
    unsettled = (status?.unsettled ?? []).filter((d) => d.needsHuman);
  if (!all.length && !unsettled.length) return null;
  const restart = latestRestart(all),
    items = restart ? restart.items : all;
  const count = (s) => items.filter((x) => x.state === s).length;
  const resumable = items.filter((x) => x.resumable).length;
  const parts = [`${items.length} session${items.length === 1 ? "" : "s"} interrupted`];
  if (resumable) parts.push(`${resumable} resumable`);
  if (count("needs-reconcile")) parts.push(`${count("needs-reconcile")} need reconcile`);
  if (count("busy-stale")) parts.push(`${count("busy-stale")} still reported running by the host`);
  if (count("not-resumable") + count("control-changed"))
    parts.push(`${count("not-resumable") + count("control-changed")} not resumable`);
  const others = all.length - items.length;
  if (others) parts.push(`${others} more from earlier restarts or other takeovers`);
  if (unsettled.length)
    parts.push(
      `${unsettled.length} deliver${unsettled.length === 1 ? "y needs" : "ies need"} a human decision`,
    );
  const head = restart
    ? `Host restart at ${when(restart.since)}`
    : all.length
      ? "Sessions taken over"
      : "Host restart";
  return {
    text: `${head}: ` + parts.join(" · "),
    severity:
      all.some((x) => x.state === "interrupted-turn" || x.state === "busy-stale") ||
      unsettled.length
        ? "attention"
        : "info",
  };
}
// Team resume: the resumable members of one owner group, leaders first. The controller orders them again and
// gates each on its own; this only selects what the operator asked for.
export function teamItems(items) {
  return orderItems(items.filter((x) => x.resumable)).map((x) => ({
    sessionId: x.sessionId,
    interruptionId: x.interruptionId,
    expectedGeneration: x.generation,
  }));
}
