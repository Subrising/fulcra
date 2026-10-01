// Fictional Command Centre data for the component-render screenshots (verify-screens.mjs). Every name here is
// invented for the picture; no id, path, host or person refers to a real installation. Unknown reads are refused
// and recorded, so a screenshot never silently shows a read it did not have.
import { createSessionSteps } from "../server/session-steps";
import { CLAUDE_ENTRIES, CODEX_ENTRIES, FIXTURE_CWD, fakeHost } from "./session-fixtures";
const uuid = n => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const PRIME = uuid(1), TALLY_LEAD = uuid(2), TALLY_BUILDER = uuid(3), CC_LEAD = uuid(4), CC_WORKER = uuid(5), REVIEWER = uuid(6), STRAY = uuid(7);
const TALLY = uuid(20), CC = uuid(21), SITE = uuid(22), W_TALLY = uuid(30), W_CC = uuid(31), W_SITE = uuid(32);

const seat = (role, id, session, mode, extra = {}) => ({ role, seat: id, projectId: role === "prime" ? null : id, state: session ? "assigned" : "vacant", revision: 3,
  task: session ? W_TALLY : null, sessionId: session, session: session ? { id: session, task: W_TALLY, mode, generation: 2 } : null, note: null, at: at(90), membershipAt: at(90),
  sessionPresent: !!session, sessionGenerationChanged: false, sessionTaskMatches: true, dispatch: session ? { host: "mini", supported: true, reason: null } : null, hold: null, ...extra });
const runtime = (title, status, provider = "claude") => ({ title, provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-6-sol", host: "mini", status, pending: 0, error: null, updatedAt: at(3) });

export const overview = () => ({
  observedAt: at(0), available: true, unavailable: null,
  primes: [seat("prime", "delivery", PRIME, "delegated")],
  projects: [
    { projectId: TALLY, name: "Tally", status: "in_progress", seat: seat("project-orchestrator", TALLY, TALLY_LEAD, "delegated", { sessionGenerationChanged: true }), channels: [{ primeSeat: "delivery", state: "open", open: true }], workstreams: 1, sessions: 2, running: 1 },
    { projectId: CC, name: "Command Centre", status: "in_progress", seat: seat("project-orchestrator", CC, CC_LEAD, "delegated"), channels: [{ primeSeat: "delivery", state: "open", open: true }], workstreams: 1, sessions: 3, running: 1 },
    { projectId: SITE, name: "Website refresh", status: "planned", seat: null, channels: [], workstreams: 1, sessions: 0, running: 0 },
  ],
  unplaced: [{ sessionId: STRAY, taskId: uuid(99), mode: "human", runtime: runtime("Morning notes", "idle") }],
  attention: [
    { kind: "generation-changed", detail: "Tally: this orchestrator was restarted since it was assigned.", projectId: TALLY, taskId: null, sessionId: TALLY_LEAD },
    { kind: "no-project-orchestrator", detail: "Website refresh needs an orchestrator.", projectId: SITE, taskId: null, sessionId: null },
  ],
  sources: { seats: true, channels: true, projects: { available: true, partial: false, note: "" }, fleet: { available: true, partial: false, observedAt: at(0) } },
  note: "A seat records who is accountable. Nothing on this map starts, sends or takes over work.",
});
const session = (sessionId, taskId, title, status, extra = {}) => ({ sessionId, taskId, mode: "delegated", generation: 2, ownership: "recorded", seat: null, seatRole: null, parentSession: null, adoptedUnder: null, leaderChanged: false, runtime: runtime(title, status), ...extra });
export const project = projectId => ({
  observedAt: at(0), available: true, unavailable: null, projectId,
  name: projectId === TALLY ? "Tally" : projectId === CC ? "Command Centre" : "Website refresh", status: projectId === SITE ? "planned" : "in_progress",
  membership: { known: true, partial: false, truncated: false, memberTaskCount: 1, note: "" }, leader: null,
  workstreams: projectId === TALLY ? [{ taskId: W_TALLY, recorded: 2, unresolved: 0, truncated: false, sessions: [
    session(TALLY_LEAD, W_TALLY, "Tally orchestrator", "idle", { seat: TALLY, seatRole: "project-orchestrator" }),
    session(TALLY_BUILDER, W_TALLY, "Tally builder", "running", { parentSession: TALLY_LEAD }),
  ] }] : projectId === CC ? [{ taskId: W_CC, recorded: 3, unresolved: 0, truncated: false, sessions: [
    session(CC_LEAD, W_CC, "Command Centre orchestrator", "idle", { seat: CC, seatRole: "project-orchestrator" }),
    session(CC_WORKER, W_CC, "Foundation worker", "running", { parentSession: CC_LEAD }),
    session(REVIEWER, W_CC, "Independent reviewer", "idle", { ownership: "adopted", adoptedUnder: CC_LEAD }),
  ] }] : [],
  needed: [], blockers: [],
  issues: { observedAt: at(0), truncated: false, providers: [{ source: "board", available: true, note: "" }], issues: [] },
  note: "",
});

const node = (id, task, title, status, provider = "claude", extra = {}) => ({ id, task, host: "mini", agentId: id, title, provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-6-sol", mode: "delegated", status, pending: 0, observedAt: at(0), updatedAt: at(2), error: null, ...extra });
export const fleet = () => ({
  observedAt: at(0), total: 6, partial: false, note: "Saved sessions on this Mac.", supervisionAvailable: true, supervisors: [],
  nodes: [
    node(TALLY_LEAD, W_TALLY, "Tally orchestrator", "idle"), node(TALLY_BUILDER, W_TALLY, "Tally builder", "running", "codex"),
    node(CC_LEAD, W_CC, "Command Centre orchestrator", "idle"), node(CC_WORKER, W_CC, "Foundation worker", "running"),
    node(REVIEWER, W_CC, "Independent reviewer", "idle", "codex", { pending: 1 }), node(STRAY, uuid(99), "Morning notes", "idle", "claude", { mode: "human" }),
  ],
  tasks: [{ id: W_TALLY, title: "Build Tally v1 end to end", identifier: "TAL-1" }, { id: W_CC, title: "Command Centre foundation", identifier: "CC-0" }, { id: uuid(99), title: "Morning notes", identifier: "NOTE-1" }],
  edges: [{ from: TALLY_LEAD, to: TALLY_BUILDER, active: true }, { from: CC_LEAD, to: CC_WORKER, active: true }],
});
// MH2: the two-host picture. The Tally builder runs on a second host ("Workshop") that the controller cannot reach
// right now, while this app still can; the app's live read is answered by screens/shims/plugin-client.mjs.
export const WORKSHOP_SERVER_ID = "srv_fixture_workshop";
export const WORKSHOP_AGENT_ID = TALLY_BUILDER;
export const multihost = () => globalThis.__FIXTURE_MULTIHOST === true;
const onTwoHosts = base => !multihost() ? base : {
  ...base, hosts: ["mini", "Workshop"],
  nodes: base.nodes.map(n => n.id !== TALLY_BUILDER ? n : { ...n, host: "Workshop", serverId: WORKSHOP_SERVER_ID, status: "unavailable", observedAt: null, error: "Remote observation unavailable; current state unavailable" }),
};
// C2: the quiet orchestrator is the hundredth saved session, outside the first page.
const pagedFleet = (input = {}) => {
  const base = onTwoHosts(fleet()), quiet = base.nodes[0];
  const all = [...base.nodes.slice(1), ...Array.from({ length: 94 }, (_, i) => node(uuid(100 + i), W_CC, `Fixture worker ${i + 1}`, "idle")), quiet];
  const directory = projects(), search = (input.search ?? "").toLowerCase();
  const matching = all.filter(n => (!input.host || input.host === "all" || input.host === n.host)
    && (!input.projectId || directory.membership.some(m => m.taskId === n.task && m.projectId === input.projectId))
    && (!search || `${n.title} ${n.provider}`.toLowerCase().includes(search)));
  const offset = input.offset ?? 0;
  return { ...base, total: all.length, matching: matching.length, nodes: matching.slice(offset, offset + 64), nextOffset: offset + 64 < matching.length ? offset + 64 : null };
};
export const projects = () => ({
  observedAt: at(0), available: true, partial: false, note: "",
  projects: [{ id: TALLY, name: "Tally", description: "A small habit tracker, built end to end by Fulcra.", status: "in_progress" },
    { id: CC, name: "Command Centre", description: "One place to see and steer the work.", status: "in_progress" },
    { id: SITE, name: "Website refresh", description: null, status: "planned" }],
  membership: [{ taskId: W_TALLY, projectId: TALLY }, { taskId: W_CC, projectId: CC }, { taskId: W_SITE, projectId: SITE }],
});

const mapping = { projectId: TALLY, tracker: "github", auth: "keychain", site: "github.com", remoteId: "424242", remoteName: "acme/tally", state: "mapped", revision: 1, validatedAt: null, note: "", at: at(600) };
export const trackerDirectory = () => ({ available: true, partial: false, note: "",
  projects: [{ id: TALLY, name: "Tally", mapping, tasks: [W_TALLY], sessions: [{ id: TALLY_BUILDER, task: W_TALLY }] }, { id: CC, name: "Command Centre", mapping: null, tasks: [W_CC], sessions: [] }] });
const item = (n, title, state, labels = []) => ({ key: `github:424242:${n}`, projectId: TALLY, ref: `#${n}`, title, state, labels, url: `https://github.com/acme/tally/issues/${n}`, updatedAt: at(n * 30), stale: false, fromPreviousMapping: false });
export const trackerView = () => ({ version: 1, observedAt: at(0), partial: false,
  projects: [{ projectId: TALLY, tracker: "github", remoteName: "acme/tally", mappingRevision: 1, status: "ok", retryAt: null, observedAt: at(0) }],
  items: [item(12, "Weekly view shows the wrong first day", "open", ["bug"]), item(9, "Import streaks from a spreadsheet", "in-progress", ["feature"]), item(4, "Dark mode for the chart", "closed")],
  links: [{ id: uuid(80), itemKey: "github:424242:12", subject: { kind: "session", id: TALLY_BUILDER }, revision: 1 }] });

// J6 step-through: the Tally orchestrator (Claude) and the Tally builder (Codex) replay the fictional sessions in
// session-fixtures.ts, shaped by the real plugin server code, in an invented project folder.
const stepHosts = { [TALLY_LEAD]: fakeHost({ entries: CLAUDE_ENTRIES }), [TALLY_BUILDER]: fakeHost({ entries: CODEX_ENTRIES }) };
const sessionSteps = createSessionSteps({
  call: async () => [], bounded: work => work,
  enrollment: async () => [TALLY_LEAD, TALLY_BUILDER].map(id => ({ id, task: W_TALLY, host: "mini", cwd: FIXTURE_CWD })),
  projects: async () => ({ membership: [{ taskId: W_TALLY, projectId: TALLY }] }),
});
const stepPaseo = { agents: { ref: id => ({ timeline: stepHosts[id] }) } };
const activityHistory = input => ({ observedAt: at(0), sessionId: input.sessionId, taskId: input.taskId, note: "", receipts: [], activity: [], cursor: null, messages: [] });

export const changeWorkspaces = [{ id: "fixture-shop", workspaceKind: "local_checkout", gitRuntime: { remoteUrl: "https://github.com/example/shop.git" } }];
const changesView = input => {
  const row = (number, title, state, days) => ({
    item: { key: `pr:github:example/shop#${number}`, connector: "github", kind: "pr", ref: `#${number}`, title, state, url: `https://github.com/example/shop/pull/${number}`, updatedAt: at(days * 1440), assignee: null, labels: [] },
    stale: false, observedAt: at(0), links: [], trail: state === "merged" ? [{ kind: "state", ref: null, label: "merged", at: at(days * 1440), provenance: null, confidence: null }] : [],
  });
  return { version: 1, observedAt: at(0), partial: false, trackers: [], items: input.projectId === TALLY ? [row(17, "Make checkout easier to follow", "open", 1), row(16, "Show delivery progress on the order page", "merged", 3), row(12, "An older change", "merged", 20)] : [] };
};
export const requested = new Set(), refused = new Set();
export function fixture(name, input) {
  requested.add(name);
  const answer = {
    "organization.work-map": overview, "organization.work-map-project": () => project(input.projectId),
    // MH4: in the two-host picture the Command Centre can't read Workshop (its receiver is unreachable).
    "organization.fleet": () => multihost() && input.host === "Workshop" ? Promise.reject(Error("Observation timed out")) : pagedFleet(input),
    "organization.fleet-hosts": () => ({ local: "mini", hosts: [{ name: "mini", serverId: null }, ...(multihost() ? [{ name: "Workshop", serverId: WORKSHOP_SERVER_ID }] : [])] }),
    "organization.projects": projects,
    // C1: the Organisation tab opens on J1's organisation view, which also reads the remits (none recorded here).
    "organization.remits": () => ({ version: 1, observedAt: at(0), partial: false, stale: false, error: null, primes: [], remits: [], domains: [], projects: [], history: [] }),
    "organization.tracker-view": () => changesView(input),
    "organization.trackers.directory": trackerDirectory, "organization.trackers": trackerView,
    "organization.outcome": () => ({ observedAt: at(0), status: "missing", message: "No decision record has been published for this task.", recordSha256: null, record: null, artifacts: [], reviews: [] }),
    "organization.recovery": () => ({ status: "observed", observedAt: at(0), recovery: { items: [], unsettled: [], error: null, note: "" } }),
    "organization.activity-history": () => activityHistory(input),
    "organization.session-turns": () => sessionSteps.turns(input, stepPaseo),
    "organization.session-step": () => sessionSteps.step(input, stepPaseo),
    "organization.session-file-history": () => sessionSteps.fileHistory(input, stepPaseo),
  }[name];
  if (!answer) { refused.add(name); return Promise.reject(new Error(`No screenshot fixture for ${name}`)); }
  return Promise.resolve(answer());
}
