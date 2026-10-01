import { managerDisplayName } from "../shared/manager-display";
import type { MapRuntime, MapSeat, MapSession, WorkMapOverview, WorkMapProject } from "../shared/work-map";
import type { LinkedIssue } from "../shared/linked-issues";

/**
 * The work map as data: one ordered outline that both the accessible list and the graph render.
 *
 * Pure and deterministic. The same input always yields the same rows in the same order, so a
 * poll that changes one session's status never moves any node. Nothing here reads a clock except
 * `freshness`, which takes `now` as an argument.
 */

export const LIMITS = { rows: 400, childrenPerWorkstream: 6, depth: 3, expandedProjects: 8, edges: 642 } as const;
export const STALE_AFTER_MS = 45000, FUTURE_SKEW_MS = 5000;

export type Filter = "all" | "attention" | "delegated" | "human";
export type RowKind = "prime" | "project" | "workstream" | "session" | "more" | "unplaced" | "notice";
export type LinkKind = "membership" | "parent" | "adopted" | "channel" | "escalation";
export type Row = {
  id: string;
  kind: RowKind;
  depth: number;
  parent: string | null;
  title: string;
  detail: string;
  glyph: string;
  /** Spoken label: kind, name, status, mode and parent in words. */
  label: string;
  expandable: boolean;
  expanded: boolean;
  attention: number;
  link: LinkKind | null;
  target: { projectId?: string; taskId?: string; sessionId?: string };
};
export type Freshness = "live" | "stale" | "frozen";

export function freshness(observedAt: string | undefined, now: number, isError: boolean, frozen: boolean): Freshness {
  if (frozen) return "frozen";
  const at = Date.parse(observedAt ?? "");
  if (isError || !Number.isFinite(at) || now - at > STALE_AFTER_MS || at - now > FUTURE_SKEW_MS) return "stale";
  return "live";
}

export function ageText(observedAt: string | undefined, now: number) {
  const at = Date.parse(observedAt ?? "");
  if (!Number.isFinite(at)) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

/** Runtime status: text plus a glyph, never colour alone. Idle is explicitly not done. */
export function statusOf(runtime: MapRuntime | null): { glyph: string; text: string } {
  if (!runtime) return { glyph: "?", text: "runtime unavailable" };
  if ((runtime.pending ?? 0) > 0) return { glyph: "◐", text: "waiting for permission" };
  if (runtime.error) return { glyph: "✕", text: "error" };
  switch (runtime.status) {
    case "running": return { glyph: "●", text: "running" };
    case "idle": return { glyph: "○", text: "idle — not done" };
    case "unavailable": return { glyph: "?", text: "runtime unavailable" };
    default: return { glyph: "○", text: runtime.status };
  }
}

/** A stale view draws hollow glyphs, so a retained "running" cannot pass for a live one. */
const HOLLOW: Record<string, string> = { "●": "⊙", "◐": "◌", "✕": "⊗", "◆": "◇", "▣": "□", "▤": "▭" };
export const displayGlyph = (glyph: string, fresh: Freshness) => (fresh === "stale" ? HOLLOW[glyph] ?? glyph : glyph);

// J0 plain language: who is driving the session, in words. The controller's mode names stay in the data.
export function modeText(mode: string) {
  if (mode === "delegated") return "run by Fulcra";
  if (mode === "human") return "run by you";
  if (["revoking", "delegating", "resuming"].includes(mode)) return "changing hands";
  return "not recorded";
}
const OWNERSHIP_TEXT: Record<string, string> = { recorded: "owner recorded", adopted: "adopted", declared: "no leader recorded", managed: "Managed worker; role-session: n/a", unknown: "Owner not recorded" };
export const ownershipText = (ownership: string) => OWNERSHIP_TEXT[ownership] ?? OWNERSHIP_TEXT.unknown;
const SEAT_ROLE_TEXT: Record<string, string> = { prime: "prime orchestrator", "project-orchestrator": "project orchestrator" };

/** The seat's state in words. Human-held needs both the effective hold and a human-mode holder. */
export function seatText(seat: MapSeat | null): string {
  if (!seat || seat.state !== "assigned") return "No orchestrator yet";
  if (seat.hold === "effective" && seat.session?.mode === "human") return "Held by you";
  if (!seat.sessionPresent) return "Its orchestrator session is gone";
  if (seat.sessionGenerationChanged) return "This orchestrator was restarted since it was assigned";
  if (!seat.sessionTaskMatches) return "Its orchestrator moved to other work";
  if (seat.hold === "declared") return "Assigned · a hold was asked for but is not in force";
  return "Assigned";
}

const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// J0: a missing title is said in words; the id itself is one tap away under "Details".
export const sessionName = (s: { sessionId: string; runtime: MapRuntime | null }) => s.runtime?.title || "Untitled session";

function workstreamName(taskId: string, issues: LinkedIssue[]) {
  const own = issues.find(i => i.relation === "is" && i.linkedTo.scope === "workstream" && i.linkedTo.scopeId === taskId);
  return own ? `${own.key} · ${own.title}` : "Untitled workstream";
}

export function toggleExpanded(expanded: readonly string[], id: string, cap: number = LIMITS.expandedProjects): string[] {
  if (expanded.includes(id)) return expanded.filter(x => x !== id);
  const next = [...expanded, id];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Projects opened on first view: those with attention items, then nothing else, capped. */
export function initialExpanded(overview: WorkMapOverview | undefined): string[] {
  if (!overview) return [];
  const ids = overview.projects.filter(p => overview.attention.some(a => a.projectId === p.projectId)).map(p => p.projectId);
  return ids.slice(0, LIMITS.expandedProjects);
}

type Input = {
  overview: WorkMapOverview;
  projects: Record<string, WorkMapProject | undefined>;
  expanded: readonly string[];
  /** `${taskId}` of workstreams whose "+N more" was opened. */
  moreOpen?: readonly string[];
  filter?: Filter;
  search?: string;
};

export function buildOutline({ overview, projects, expanded, moreOpen = [], filter = "all", search = "" }: Input): { rows: Row[]; truncated: number; hidden: number } {
  const rows: Row[] = [];
  const needle = search.trim().toLowerCase();
  const matches = (...parts: (string | null | undefined)[]) => !needle || parts.some(p => p?.toLowerCase().includes(needle));
  const modeOk = (mode: string) => filter === "delegated" ? mode === "delegated" : filter === "human" ? mode === "human" : true;
  let hidden = 0;
  const attentionFor = (projectId: string) => overview.attention.filter(a => a.projectId === projectId).length
    + (projects[projectId]?.needed.length ?? 0) + (projects[projectId]?.blockers.length ?? 0);

  for (const prime of overview.primes) {
    const text = seatText(prime);
    if (!matches(prime.seat, text)) { hidden++; continue; }
    rows.push({ id: `prime:${prime.seat}`, kind: "prime", depth: 0, parent: null, title: `Prime · ${prime.seat}`, detail: `${text} · ${prime.session ? modeText(prime.session.mode) : "no orchestrator"}`,
      glyph: "◆", label: `Prime seat ${prime.seat}, ${text}`, expandable: false, expanded: false, attention: 0, link: null, target: { sessionId: prime.sessionId ?? undefined } });
  }
  const assignedPrimes = overview.primes.filter(p => p.state === "assigned");

  for (const p of overview.projects) {
    const detail = projects[p.projectId];
    const attention = attentionFor(p.projectId);
    if (filter === "attention" && attention === 0) { hidden++; continue; }
    const name = p.name ?? detail?.name ?? "Untitled project";
    const issues = detail?.issues.issues ?? [];
    // With a search, a project shows when it or anything loaded beneath it matches, and opens to show the match.
    const childHit = needle && detail ? detail.workstreams.some(w => matches(workstreamName(w.taskId, issues), ...w.sessions.map(sessionName))) : false;
    if (needle && !matches(name, p.seat?.seat) && !childHit) { hidden++; continue; }
    const open = expanded.includes(p.projectId) || Boolean(childHit);
    const leader = seatText(p.seat);
    const channel = p.channels.find(c => c.open);
    rows.push({ id: `project:${p.projectId}`, kind: "project", depth: 1, parent: null, title: name,
      detail: `${leader} · ${p.workstreams === null || p.workstreams === undefined ? "workstreams not known" : plural(p.workstreams, "workstream")} · ${plural(p.sessions, "session")} (${p.running} running)${attention ? ` · ⚠ ${attention}` : ""}`,
      glyph: "▣", label: `Project ${name}, ${leader}, ${attention} needing attention, ${open ? "expanded" : "collapsed"}`,
      expandable: true, expanded: open, attention, link: channel ? "channel" : assignedPrimes.length ? "escalation" : null, target: { projectId: p.projectId } });
    if (!open) continue;
    if (!detail) { rows.push(notice(`project:${p.projectId}`, "Reading this project…")); continue; }
    if (!detail.available) { rows.push(notice(`project:${p.projectId}`, `Project unreadable: ${detail.unavailable ?? "unknown"}. Its workstreams are unknown, not absent.`)); continue; }
    if (detail.membership?.truncated) rows.push(notice(`project:${p.projectId}`, `Showing ${detail.workstreams.length} of ${detail.membership.memberTaskCount} workstreams — the controller truncates membership.`));
    for (const unavailable of detail.issues.providers.filter(x => !x.available)) rows.push(notice(`project:${p.projectId}`, `Issues unavailable from ${unavailable.source}: ${unavailable.note}`));

    for (const w of detail.workstreams) {
      const wName = workstreamName(w.taskId, issues);
      const sessions = w.sessions.filter(s => modeOk(s.mode));
      const sessionHit = sessions.some(s => matches(sessionName(s)));
      if (needle && !matches(wName) && !sessionHit) { hidden++; continue; }
      if (filter !== "all" && filter !== "attention" && sessions.length === 0) { hidden++; continue; }
      const own = issues.find(i => i.relation === "is" && i.linkedTo.scopeId === w.taskId);
      const others = issues.filter(i => i.relation === "links" && i.linkedTo.scopeId === w.taskId);
      const wid = `workstream:${p.projectId}:${w.taskId}`;
      rows.push({ id: wid, kind: "workstream", depth: 2, parent: `project:${p.projectId}`, title: wName,
        detail: `${own ? `${own.source}: ${own.state.replace("_", " ")}` : "no linked issue"}${others.length ? ` · ${others.map(o => `${o.key} (${o.state.replace("_", " ")})`).join(", ")}` : ""} · ${w.sessions.length} sessions · ${w.unresolved} unresolved${w.truncated ? " · truncated" : ""}`,
        glyph: "▤", label: `Workstream ${wName}, ${w.sessions.length} sessions`, expandable: false, expanded: true, attention: 0, link: "membership", target: { projectId: p.projectId, taskId: w.taskId } });
      pushSessions(rows, wid, w.taskId, sessions, detail, moreOpen.includes(w.taskId), needle ? (s => matches(sessionName(s))) : null);
    }
  }

  const unplaced = overview.unplaced.filter(u => modeOk(u.mode) && matches(sessionName(u)));
  if (unplaced.length && filter !== "attention") {
    rows.push({ id: "unplaced", kind: "unplaced", depth: 1, parent: null, title: "Unplaced sessions", detail: `${unplaced.length} on no known project's workstream`, glyph: "◌",
      label: `Unplaced sessions, ${unplaced.length}`, expandable: false, expanded: true, attention: 0, link: null, target: {} });
    for (const u of unplaced) {
      const st = statusOf(u.runtime);
      rows.push({ id: `unplaced:${u.sessionId}`, kind: "session", depth: 2, parent: "unplaced", title: sessionName(u), detail: `${modeText(u.mode)} · ${st.text}`, glyph: st.glyph,
        label: `Session ${sessionName(u)}, ${modeText(u.mode)}, ${st.text}, not placed in a project`, expandable: false, expanded: false, attention: 0, link: null, target: { sessionId: u.sessionId, taskId: u.taskId } });
    }
  }

  const truncated = Math.max(0, rows.length - LIMITS.rows);
  const out = rows.slice(0, LIMITS.rows);
  if (truncated) out.push(notice(null, `${truncated} more rows not shown. Collapse projects or filter to see them.`));
  return { rows: out, truncated, hidden };
}

function notice(parent: string | null, text: string): Row {
  return { id: `notice:${parent ?? "root"}:${text.slice(0, 48)}`, kind: "notice", depth: parent ? 2 : 0, parent, title: text, detail: "", glyph: "ℹ", label: text, expandable: false, expanded: false, attention: 0, link: null, target: {} };
}

/** Nest a workstream's sessions by recorded parent (solid) or adoption (dashed); cap width and depth. */
function pushSessions(rows: Row[], workstreamId: string, taskId: string, sessions: MapSession[], project: WorkMapProject, showAll: boolean, hit: ((s: MapSession) => boolean) | null) {
  const here = new Map(sessions.map(s => [s.sessionId, s]));
  const parentOf = (s: MapSession) => (s.parentSession && here.has(s.parentSession) ? s.parentSession : s.adoptedUnder && here.has(s.adoptedUnder) ? s.adoptedUnder : null);
  const children = new Map<string | null, MapSession[]>();
  const seen = new Set<string>();
  // Cycle guard: a session whose ancestry loops back is placed at the root.
  const rooted = (s: MapSession) => { const path = new Set<string>(); let at: string | null = s.sessionId; while (at) { if (path.has(at)) return false; path.add(at); const cur = here.get(at); at = cur ? parentOf(cur) : null; } return true; };
  for (const s of sessions) { const parent = rooted(s) ? parentOf(s) : null; children.set(parent, [...(children.get(parent) ?? []), s]); }
  const alsoIn = (sessionId: string) => project.workstreams.filter(w => w.taskId !== taskId && w.sessions.some(s => s.sessionId === sessionId)).map(w => w.taskId.slice(0, 8));
  const roots = children.get(null) ?? [];
  const visibleRoots = showAll || hit ? roots : roots.slice(0, LIMITS.childrenPerWorkstream);
  const walk = (s: MapSession, parentRow: string, depth: number, link: LinkKind) => {
    if (seen.has(s.sessionId)) return;
    seen.add(s.sessionId);
    const st = statusOf(s.runtime), name = sessionName(s), also = alsoIn(s.sessionId);
    const parentName = s.parentSession && here.has(s.parentSession) ? sessionName(here.get(s.parentSession)!) : null;
    const manager = s.ownership === "managed" && s.managedBy ? here.get(s.managedBy) : null;
    const association = s.ownership === "managed" && s.managedBy ? `Managed by ${managerDisplayName(manager?.runtime?.title)}; role-session: n/a` : ownershipText(s.ownership);
    const id = `session:${taskId}:${s.sessionId}`;
    rows.push({ id, kind: "session", depth, parent: parentRow, title: name,
      detail: `${modeText(s.mode)} · ${st.text}${s.seatRole ? ` · ${SEAT_ROLE_TEXT[s.seatRole] ?? "holds a seat"}` : ""} · ${association}${s.leaderChanged ? " · its leader changed since it started" : ""}${also.length ? ` · also in ${also.length} other workstream${also.length === 1 ? "" : "s"}` : ""}`,
      glyph: st.glyph, label: `Session ${name}, ${modeText(s.mode)}, ${st.text}${parentName ? `, child of ${parentName}` : link === "adopted" ? ", adopted by an operator" : ""}`,
      expandable: false, expanded: false, attention: (s.runtime?.pending ?? 0) > 0 || s.runtime?.error ? 1 : 0, link, target: { sessionId: s.sessionId, taskId } });
    const kids = children.get(s.sessionId) ?? [];
    if (!kids.length) return;
    if (depth - 3 + 1 >= LIMITS.depth) {
      rows.push(notice(id, `… ${countDescendants(s.sessionId, children)} more in deeper levels`));
      return;
    }
    for (const k of kids) walk(k, id, depth + 1, k.parentSession === s.sessionId ? "parent" : "adopted");
  };
  for (const r of visibleRoots) walk(r, workstreamId, 3, "membership");
  if (visibleRoots.length < roots.length) {
    rows.push({ id: `more:${taskId}`, kind: "more", depth: 3, parent: workstreamId, title: `+${roots.length - visibleRoots.length} more`, detail: "Show every session on this workstream", glyph: "…",
      label: `${roots.length - visibleRoots.length} more sessions, collapsed`, expandable: true, expanded: false, attention: 0, link: "membership", target: { taskId } });
  }
}

function countDescendants(id: string, children: Map<string | null, MapSession[]>): number {
  let n = 0; const stack = [...(children.get(id) ?? [])]; const seen = new Set<string>();
  while (stack.length) { const s = stack.pop()!; if (seen.has(s.sessionId)) continue; seen.add(s.sessionId); n++; stack.push(...(children.get(s.sessionId) ?? [])); }
  return n;
}

// ---------- graph layout ----------

export const CARD = { width: 240, height: 84, gapY: 20, gapX: 56 } as const;
export type MapNode = { id: string; row: Row; x: number; y: number };
export type MapEdge = { id: string; from: string; to: string; kind: LinkKind };

const column = (row: Row) => row.kind === "prime" ? 0 : row.kind === "project" || row.kind === "unplaced" ? 1 : row.kind === "workstream" ? 2 : row.kind === "notice" ? Math.max(1, row.depth) : Math.min(6, row.depth);

/** Deterministic columns: prime | project | workstream | session (+ nesting). No force layout. */
export function layoutMap(rows: Row[]) {
  const nodes: MapNode[] = [], edges: MapEdge[] = [];
  let primeY = 24, y = 24;
  for (const row of rows) {
    const x = 24 + column(row) * (CARD.width + CARD.gapX);
    if (row.kind === "prime") { nodes.push({ id: row.id, row, x, y: primeY }); primeY += CARD.height + CARD.gapY; continue; }
    nodes.push({ id: row.id, row, x, y }); y += CARD.height + CARD.gapY;
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const add = (from: string, to: string, kind: LinkKind) => { if (edges.length < LIMITS.edges && byId.has(from) && byId.has(to)) edges.push({ id: `${from}>${to}`, from, to, kind }); };
  const primes = nodes.filter(n => n.row.kind === "prime");
  for (const n of nodes) {
    if (n.row.kind === "project") for (const p of primes) add(p.id, n.id, n.row.link === "channel" ? "channel" : "escalation");
    else if (n.row.parent && n.row.link) add(n.row.parent, n.id, n.row.link);
  }
  const width = Math.max(640, ...nodes.map(n => n.x + CARD.width + 24));
  const height = Math.max(320, ...nodes.map(n => n.y + CARD.height + 24));
  return { nodes, edges, width, height };
}

/** Line style per link kind; the legend reads from the same table. */
export const LINK_STYLE: Record<LinkKind, { dashed: boolean; weight: number; words: string }> = {
  channel: { dashed: false, weight: 3, words: "open prime–project channel" },
  escalation: { dashed: true, weight: 1, words: "escalation address only" },
  membership: { dashed: false, weight: 1, words: "member of" },
  parent: { dashed: false, weight: 2, words: "recorded parent" },
  adopted: { dashed: true, weight: 2, words: "adopted by an operator" },
};

/** One polite announcement per poll, and only when something changed. */
export function changeAnnouncement(before: Row[] | undefined, after: Row[]): string | null {
  if (!before) return null;
  const was = new Map(before.filter(r => r.kind === "session").map(r => [r.id, r.glyph]));
  const changed = after.filter(r => r.kind === "session" && was.has(r.id) && was.get(r.id) !== r.glyph).length;
  return changed ? `${changed} session${changed === 1 ? "" : "s"} changed status` : null;
}
