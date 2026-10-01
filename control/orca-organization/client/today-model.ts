// Fulcra › Today, as a pure function of reads the Command Centre already makes (work map, per-project fleet,
// project briefs, inbox, recovery). No new server method and no write: each source may be missing, and the page
// then says which part it could not read instead of going blank. Everything shown is plain words; operator terms
// (seat, generation, capability, ack, prime, orchestrator) never reach the page, and ids stay behind actions.
import type { WorkMapOverview } from "../shared/work-map";
import type { Fleet } from "../shared/fleet";
import type { ContractOutput } from "../shared/rpc-contract";
import type { projectBriefRpc } from "../shared/cc/brief";
import type { inboxRpc } from "../shared/cc/decision";
import { latestRestart } from "../shared/recovery-view.mjs";

export type BriefRead = ContractOutput<typeof projectBriefRpc>;
export type InboxRead = ContractOutput<typeof inboxRpc>;
type Node = Fleet["nodes"][number];
export type TodayAction =
  | { kind: "decision"; id: string }
  | { kind: "held"; channelId: string; messageId: string }
  | { kind: "held-list" }
  | { kind: "session"; agentId: string }
  | { kind: "project"; projectId: string }
  | { kind: "recovery" };
// Update-7: what a running session runs on -- model, effort and its pool account, as far as its host reports them.
export function runsOn(n: { model?: string | null; effort?: string | null; account?: { name: string } | null }) {
  const model = typeof n.model === "string" && n.model ? n.model.replace(/^[a-z]+\//, "") : null;
  return [model, n.effort ? `${n.effort} effort` : null, n.account ? `account ${n.account.name}` : null].filter(Boolean).join(" · ") || null;
}
export type TodayItem = { key: string; projectId: string | null; project: string | null; text: string; detail: string | null; at: string | null; action: TodayAction | null };
export type TodayStory = { written: boolean; health: "on-track" | "at-risk" | "blocked" | "idle"; headline: string; now: string; next: string[]; byline: string };
export type TodayProject = { projectId: string; name: string; lead: string; running: TodayItem[]; waiting: TodayItem[]; done: TodayItem[]; blocked: TodayItem[]; needs: TodayItem[]; story: TodayStory };
export type Today = { since: string; firstLook: boolean; done: TodayItem[]; needs: TodayItem[]; blocked: TodayItem[]; projects: TodayProject[]; gaps: string[] };
export type TodayInputs = {
  now: number; since: number | null;
  map: WorkMapOverview | undefined;
  fleets: Record<string, Fleet | undefined>;
  briefs: Record<string, BriefRead | undefined>;
  inbox: InboxRead | undefined; inboxFailed: boolean;
  recovery: unknown;
  timeZone?: string;
};

const DAY = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[], max = 3) => xs.length <= max ? xs.join(xs.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, " and $1") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;
const at = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : null; };
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);

/** Operator words → plain words, for titles and notes written by agents. */
export function plain(text: string): string {
  return text
    .replace(/\bproject orchestrators?\b/gi, m => /s$/i.test(m) ? "project leads" : "project lead")
    .replace(/\borchestrators?\b/gi, m => /s$/i.test(m) ? "leads" : "lead")
    .replace(/\bprimes?\b/gi, m => /s$/i.test(m) ? "leads" : "lead")
    .replace(/\bseats?\b/gi, m => /s$/i.test(m) ? "roles" : "role")
    .replace(/\bgenerations?\b/gi, m => /s$/i.test(m) ? "restarts" : "restart")
    .replace(/\bcapabilit(?:y|ies)\b/gi, m => /ies$/i.test(m) ? "permissions" : "permission")
    .replace(/\backs?\b/gi, m => /s$/i.test(m) ? "receipts" : "receipt")
    .replace(/\s{2,}/g, " ").trim();
}
/** A session title without its tracking code: "CC R-V11B: adversarial review …" → "Adversarial review …". */
export function plainTitle(title: string): string {
  const stripped = title.replace(/^(?:CC\s+)?(?:(?=[A-Z0-9-]*\d)[A-Z][A-Za-z0-9.-]{0,15}|[A-Z]{2,5})(?:\s*\([^)]{0,40}\))?:\s+/, "");
  const t = plain(stripped.length >= 8 ? stripped : title);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export function ago(iso: string | null, now: number): string {
  const t = at(iso); if (t === null) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
export function clock(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone }).replace(":00", "").replace(/\s/g, "").toLowerCase();
}
/** "You've hit your weekly limit · resets 8am (Australia/Brisbane)" → "weekly usage limit" and "8am". */
export function limitWords(line: string | null | undefined, resetAt: string | null, now: number, timeZone?: string) {
  const kind = /\b(weekly|daily|monthly|session|5-hour|hourly)\b/i.exec(line ?? "")?.[1]?.toLowerCase();
  const what = `${kind ? kind + " " : ""}usage limit`;
  const said = /resets\s+([^(·]+?)\s*(?:\(|$)/i.exec(line ?? "")?.[1]?.trim();
  const reset = at(resetAt);
  const when = said ?? (resetAt ? clock(resetAt, timeZone) : null);
  if (reset !== null && reset <= now) return `hit its ${what}; that reset${when ? ` at ${when}` : ""}, so it can carry on when you say`;
  return `hit its ${what}${when ? `, resets ${when}` : ""}`;
}

type Stop = { sessionId: string; line: string | null; resetAt: string | null; stoppedAt: string | null; state: string };
type Recovery = { items: any[]; usage: Stop[]; provider: { sessionId: string; error: string; state: string; at: string | null }[]; interrupted: { sessionId: string; since: string | null }[] };
// A session on another computer that cannot be observed right now is not stuck; it is only out of sight.
const UNSEEN = /observation unavailable/i;
const CLOSED = new Set(["resumed", "recovered", "dismissed", "done", "cancelled", "completed", "sent"]);
function readRecovery(value: unknown): Recovery {
  const r = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  const stops = Array.isArray(r.usageLimits?.stops) ? r.usageLimits.stops : [];
  const recoveries = Array.isArray(r.providerRecovery?.recoveries) ? r.providerRecovery.recoveries : [];
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    items,
    usage: stops.filter((s: any) => isId(s?.sessionId) && typeof s.state === "string").map((s: any) => ({ sessionId: s.sessionId, line: typeof s.line === "string" ? s.line : null, resetAt: typeof s.resetAt === "string" ? s.resetAt : null, stoppedAt: typeof s.stoppedAt === "string" ? s.stoppedAt : null, state: s.state })),
    provider: recoveries.filter((s: any) => isId(s?.sessionId) && typeof s.state === "string").map((s: any) => ({ sessionId: s.sessionId, error: typeof s.error === "string" ? s.error : "", state: s.state, at: typeof s.at === "string" ? s.at : null })),
    interrupted: items.filter((s: any) => isId(s?.sessionId) && (s.state === "interrupted-turn" || s.state === "needs-reconcile")).map((s: any) => ({ sessionId: s.sessionId, since: typeof s.since === "string" ? s.since : null })),
  };
}
const providerWords = (error: string) => {
  const retry = /try again (?:at|after)\s+([^.]+)/i.exec(error)?.[1];
  return `waiting for the AI provider (usage limit)${retry ? `; it can retry ${retry.trim()}` : ""}`;
};

/** Why a session is stuck, in plain words, or null when it is not. The newest cause wins. */
function blockedReason(node: Node, rec: Recovery, now: number, timeZone?: string): { text: string; at: string | null } | null {
  if (node.pending) return { text: `waiting for your permission (${plural(node.pending, "request")})`, at: node.updatedAt };
  const moved = (iso: string | null) => (at(node.updatedAt) ?? 0) > (at(iso) ?? 0) + 120_000;
  const stop = rec.usage.filter(s => s.sessionId === node.id && !CLOSED.has(s.state) && now - (at(s.stoppedAt) ?? 0) < 3 * DAY)
    .sort((a, b) => (at(b.stoppedAt) ?? 0) - (at(a.stoppedAt) ?? 0))[0];
  if (stop && !moved(stop.stoppedAt)) return { text: limitWords(stop.line, stop.resetAt, now, timeZone), at: stop.stoppedAt };
  const provider = rec.provider.find(p => p.sessionId === node.id && !CLOSED.has(p.state));
  if (provider && !moved(provider.at)) return { text: providerWords(provider.error), at: provider.at };
  if (node.quotaWait) return { text: node.quotaWait.state === "attention" ? "paused; its saved instruction needs a check before it continues" : `waiting for usage to free up${node.quotaWait.nextCheckAt ? `; next check ${clock(node.quotaWait.nextCheckAt, timeZone)}` : ""}`, at: node.quotaWait.since };
  if (node.error && !UNSEEN.test(node.error)) return { text: `stopped with an error: ${plain(node.error).slice(0, 140)}`, at: node.updatedAt };
  const cut = rec.interrupted.find(i => i.sessionId === node.id);
  if (cut && node.status !== "running") return { text: "stopped mid-task when the computer restarted", at: cut.since };
  return null;
}

const HEALTH_WORD = { "on-track": "On track", "at-risk": "At risk", blocked: "Stuck", idle: "Quiet" } as const;
export const healthWord = (h: TodayStory["health"]) => HEALTH_WORD[h];
const leadLine = (map: WorkMapOverview | undefined, projectId: string) => {
  const p = map?.projects.find(x => x.projectId === projectId);
  if (!p?.seat) return "No one is leading this yet";
  return p.seat.state === "assigned" ? "Has a project lead" : "Its lead's place is empty";
};

export function buildToday(i: TodayInputs): Today {
  const { now, map, timeZone } = i;
  const firstLook = i.since === null, since = i.since ?? now - DAY;
  const rec = readRecovery(i.recovery);
  const gaps: string[] = [];
  if (!map) gaps.push("Your projects could not be read just now; showing what could be read.");
  if (i.inboxFailed || i.inbox?.stale) gaps.push("Decisions and held messages could not be read just now, so some things that need you may be missing.");
  else if (i.inbox?.partial) gaps.push("Part of the inbox could not be read just now, so some things that need you may be missing."); // U5-D01
  const projects: TodayProject[] = [];
  const allNeeds: TodayItem[] = [], allDone: TodayItem[] = [], allBlocked: TodayItem[] = [];
  const inboxItems = i.inbox && !i.inbox.stale ? i.inbox.items : [];
  const seenSessions = new Set<string>();
  for (const p of map?.projects ?? []) {
    const name = plain(p.name ?? "A project"), projectId = p.projectId;
    const fleet = i.fleets[projectId], brief = i.briefs[projectId];
    const item = (key: string, text: string, detail: string | null, when: string | null, action: TodayAction | null): TodayItem => ({ key, projectId, project: name, text, detail, at: when, action });
    const nodes = (fleet?.nodes ?? []).filter(n => !seenSessions.has(n.id));
    nodes.forEach(n => seenSessions.add(n.id));
    const running: TodayItem[] = [], waiting: TodayItem[] = [], done: TodayItem[] = [], blocked: TodayItem[] = [], needs: TodayItem[] = [];
    for (const n of [...nodes].sort((a, b) => (at(b.updatedAt) ?? 0) - (at(a.updatedAt) ?? 0))) {
      const title = plainTitle(n.title), open = n.agentId ? { kind: "session" as const, agentId: n.agentId } : null;
      const why = blockedReason(n, rec, now, timeZone);
      if (n.pending) { needs.push(item(`permission-${n.id}`, `${title}: needs you`, `${plural(n.pending, "permission request")} waiting for your answer`, n.updatedAt, open)); continue; }
      if (why) { blocked.push(item(`blocked-${n.id}`, `${title}: ${why.text}`, why.at ? `Since ${ago(why.at, now)}` : null, why.at, open)); continue; }
      const t = at(n.updatedAt);
      if (n.status === "running") running.push(item(`running-${n.id}`, title, [`Working · last active ${ago(n.updatedAt, now)}`, runsOn(n)].filter(Boolean).join(" · "), n.updatedAt, open));
      else if (t !== null && t > since && t <= now + 60000) done.push(item(`done-${n.id}`, title, n.status === "closed" ? `Finished and closed ${ago(n.updatedAt, now)}` : `Finished its latest step ${ago(n.updatedAt, now)}; waiting for what's next`, n.updatedAt, open));
      else if (n.status === "idle" && t !== null && now - t < 2 * DAY) waiting.push(item(`waiting-${n.id}`, title, `Waiting for its next step · last active ${ago(n.updatedAt, now)}`, n.updatedAt, open));
    }
    const b = brief?.brief ?? null;
    if (b) for (const [k, s] of b.shipped.entries()) if ((at(b.writtenAt) ?? 0) > since) done.unshift(item(`shipped-${projectId}-${k}`, plain(s.text), `Reported by the project lead ${ago(b.writtenAt, now)}`, b.writtenAt, null));
    // Needs you: decisions and held messages from the inbox when it answers; otherwise the project's own counts.
    for (const x of inboxItems.filter(x => x.projectId === projectId)) {
      if (x.source === "decision" || x.source === "outcome") needs.push(item(`decision-${x.key}`, plain(x.title), plain(x.summary), x.createdAt, x.source === "decision" && x.ref?.startsWith("decision:") ? { kind: "decision", id: x.ref.slice(9) } : { kind: "project", projectId }));
      else if (x.source === "held") { const [, channelId, messageId] = /^held-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(x.key) ?? []; if (channelId) needs.push(item(`held-${x.key}`, plain(x.title), plain(x.summary.split(" Open it to")[0]), x.createdAt, { kind: "held", channelId, messageId })); }
    }
    const o = brief?.observed;
    const inboxHeld = inboxItems.some(x => x.projectId === projectId && x.source === "held");
    if (o && o.heldMessages > 0 && !inboxHeld) needs.push(item(`held-count-${projectId}`, `${plural(o.heldMessages, "message")} waiting for you to read or pass on`, "Messages between leads that were held for you to see first.", null, { kind: "held-list" }));
    if (o && o.openDecisions > 0 && !inboxItems.some(x => x.projectId === projectId && x.source === "decision")) needs.push(item(`decision-count-${projectId}`, `${plural(o.openDecisions, "decision")} waiting for your answer`, "Open them in the Inbox to see the options and choose.", null, { kind: "held-list" }));
    if (b) for (const [k, n] of b.needsYou.entries()) if (!n.decision || !needs.some(x => x.action?.kind === "decision" && x.action.id === n.decision)) needs.push(item(`brief-need-${projectId}-${k}`, plain(n.text), "From the project lead's update.", b.writtenAt, n.decision ? { kind: "decision", id: n.decision } : null));
    const noLead = !p.seat;
    if (noLead && (p.sessions > 0 || running.length)) needs.push(item(`no-lead-${projectId}`, `${name} has work but no one leading it`, "Choose a lead so it has someone planning and checking the work.", null, { kind: "project", projectId }));
    // The story: the lead's own update when there is one, otherwise written here from what the sessions show.
    const lastDone = done.find(d => d.action?.kind === "session");
    let story: TodayStory;
    if (b) story = { written: true, health: b.health, headline: plain(b.headline), now: plain(b.now), next: b.next.map(n => plain(n.text)), byline: `Written by the project lead ${ago(b.writtenAt, now)}${brief?.stale ? " · may be out of date" : ""}` };
    else {
      const health: TodayStory["health"] = blocked.length ? (running.length ? "at-risk" : "blocked") : running.length || done.length ? "on-track" : "idle";
      const headline = blocked.length ? `${plural(blocked.length, "piece")} of work ${blocked.length === 1 ? "is" : "are"} stuck${running.length ? `; ${running.length} still going` : ""}`
        : running.length ? `${plural(running.length, "piece")} of work going now` : done.length ? `Quiet now; ${done.length} finished since you last looked` : nodes.length ? "Nothing running right now" : "No work has started here yet";
      const nowLine = [running.length ? `Working now: ${list(running.map(r => r.text), 2)}.` : "Nothing is running.",
        blocked.length ? `${plural(blocked.length, "piece")} of work ${blocked.length === 1 ? "is" : "are"} stuck; the reasons are under Needs you.` : "",
        lastDone ? `Most recently finished: ${lastDone.text} (${ago(lastDone.at, now)}).` : ""].filter(Boolean).join(" ");
      const next = [...needs.map(n => `You: ${n.text.charAt(0).toLowerCase()}${n.text.slice(1)}`), ...waiting.slice(0, 3).map(w => `${w.text} is waiting for its next step`)];
      story = { written: false, health, headline, now: nowLine, next, byline: "Summarised by Fulcra from live activity. The project lead hasn't written an update yet." };
    }
    projects.push({ projectId, name, lead: leadLine(map, projectId), running, waiting, done, blocked, needs, story });
    allNeeds.push(...needs); allDone.push(...done); allBlocked.push(...blocked);
  }
  // Decisions that belong to no project still need you.
  for (const x of inboxItems.filter(x => !x.projectId && (x.source === "decision" || x.source === "held"))) {
    const [, channelId, messageId] = /^held-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(x.key) ?? [];
    allNeeds.push({ key: `inbox-${x.key}`, projectId: null, project: null, text: plain(x.title), detail: plain(x.summary.split(" Open it to")[0]), at: x.createdAt,
      action: x.source === "decision" && x.ref?.startsWith("decision:") ? { kind: "decision", id: x.ref.slice(9) } : channelId ? { kind: "held", channelId, messageId } : null });
  }
  const unseen = Object.values(i.fleets).flatMap(f => f?.nodes ?? []).filter(n => n.error && UNSEEN.test(n.error)).length;
  if (unseen) gaps.push(`${plural(unseen, "session")} on another computer can't be seen from here right now.`);
  const restart = latestRestart(rec.items.filter(x => typeof x?.since === "string" && typeof x?.cause === "string"));
  if (restart && now - (at(restart.since) ?? 0) < 7 * DAY) {
    const n = restart.items.length, back = restart.items.filter((x: any) => x.resumable === true).length;
    allNeeds.unshift({ key: `restart-${restart.since}`, projectId: null, project: null, at: restart.since, action: { kind: "recovery" },
      text: `The computer restarted ${ago(restart.since, now)} and ${plural(n, "session")} stopped`,
      detail: back ? `${back} can pick up where ${back === 1 ? "it" : "they"} left off if you say so. The rest need starting again.` : "None can pick up on their own; start again the ones you still need." });
  }
  const weight = (p: TodayProject) => p.blocked.length * 100 + p.needs.length * 10 + p.running.length * 5 + p.done.length;
  projects.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
  const newest = (a: TodayItem, b: TodayItem) => (at(b.at) ?? 0) - (at(a.at) ?? 0);
  return { since: new Date(since).toISOString(), firstLook, done: allDone.sort(newest), needs: allNeeds, blocked: allBlocked.sort(newest), projects, gaps };
}
