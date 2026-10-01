// G1 LaunchPad screenshots: fictional fixtures only (no real project, person, repo or path). Every read Today makes
// is answered here; anything else is recorded as refused and fails the capture.
export const requested = [], refused = [];
const P = "00000000-0000-46cd-9b65-000000002006", Q = "00000000-0000-46cd-9b65-000000002009", T = "00000000-0000-43b8-b458-000000002008";
const DEC = "11111111-1111-4111-8111-000000000001";
const sid = n => `4c111479-b424-43e5-bd1e-${String(n).padStart(12, "0")}`;
const iso = ms => new Date(Date.now() - ms).toISOString();
const H = 3600000, D = 24 * H;
const project = (projectId, name, sessions) => ({ projectId, name, status: "in_progress", seat: { role: "project", seat: projectId, state: "assigned", sessionId: sid(90), revision: 2, hold: null }, channels: [], workstreams: 2, sessions, running: 1 });
const map = { observedAt: iso(0), available: true, unavailable: null, primes: [], unplaced: [], attention: [], note: "", sources: { seats: true, channels: true, projects: { available: true, partial: false, note: "" }, fleet: { available: true, partial: false, observedAt: iso(0) } },
  projects: [project(P, "Checkout app", 2), project(Q, "Marketing site", 1)] };
const node = (n, status, title, updated) => ({ id: sid(n), task: T, host: "local", agentId: sid(70 + n), title, provider: "claude", model: null, mode: "delegated", status, pending: null, observedAt: null, updatedAt: iso(updated), error: null });
const fleets = { [P]: [node(1, "running", "Tidy the basket page", 5 * 60000), node(2, "idle", "Payment retry copy", 2 * H)], [Q]: [node(3, "running", "Pricing page refresh", 20 * 60000)] };
const fleet = projectId => ({ observedAt: iso(0), total: fleets[projectId]?.length ?? 0, partial: false, note: "", tasks: [], edges: [], nodes: fleets[projectId] ?? [] });
const brief = projectId => ({ version: 1, observedAt: iso(0), partial: false, error: null, projectId, brief: null, authorName: null, stale: false, observed: { sessionsRunning: 1, sessionsTotal: 2, openDecisions: projectId === P ? 1 : 0, heldMessages: 0, lastActivityAt: iso(0), observedAt: iso(0) } });
const inbox = { version: 1, observedAt: iso(0), partial: false, stale: false, error: null, counts: { now: 1, today: 0, fyi: 0, decisions: 1, approvals: 0, held: 0, digests: 0, total: 1 },
  items: [{ key: `decision-${DEC}`, source: "decision", ref: `decision:${DEC}`, title: "Which payment provider should checkout try first?", summary: "Two options, with the lead's recommendation.", projectId: P, urgency: "now", createdAt: iso(40 * 60000), unread: true }] };
const link = (n, to) => ({ id: sid(900 + n), from: `session:${sid(n)}`, to, relation: "worked-by", provenance: "reported", confidence: "high", evidence: "Opened by the session.", state: "active", revision: 1, createdAt: iso(0), by: "system:tracker" });
const it = (n, kind, state, assignee, ago, repo, title, links = []) => ({ item: { key: `${kind}:github:${repo}#${n}`, connector: "github", kind, ref: `#${n}`, title, state, url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}`, updatedAt: iso(ago), assignee, labels: [] }, stale: false, observedAt: iso(0), links, trail: [] });
const views = {
  [P]: [it(128, "pr", "open", "sam-lee", 2 * H, "acme/checkout", "Retry card payments once before showing an error", [link(1, "pr:github:acme/checkout#128")]),
    it(131, "issue", "open", "sam-lee", 20 * H, "acme/checkout", "Basket total is wrong when a coupon is removed"),
    it(119, "pr", "open", "alex-dev", 3 * D, "acme/checkout", "Move address lookup behind a feature flag"),
    it(97, "issue", "in-progress", null, 9 * D, "acme/checkout", "Checkout is slow on older phones"),
    it(126, "pr", "merged", "sam-lee", H, "acme/checkout", "Already merged, not waiting on anyone")],
  [Q]: [it(44, "pr", "open", "sam-lee", 5 * D, "acme/site", "New pricing table layout", [link(3, "pr:github:acme/site#44")]),
    it(51, "issue", "open", "jordan-k", 30 * 60000, "acme/site", "Footer links point at the old help centre"),
    it(38, "issue", "open", null, 12 * D, "acme/payments-sdk", "Document the sandbox card numbers")],
};
const view = projectId => ({ version: 1, observedAt: iso(0), partial: false, trackers: [], items: views[projectId] ?? [] });
const integrations = { version: 1, observedAt: iso(0), partial: false, hostApi: true, connectors: [], accounts: [{ version: 1, id: P, connector: "github", site: null, displayName: "sam-lee", method: "cli", scopes: [], state: "connected", expiresAt: null, lastCheckedAt: iso(0), createdAt: iso(0) }] };
export async function fixture(name, input) {
  requested.push(name);
  switch (name) {
    case "organization.work-map": return map;
    case "organization.fleet": return fleet(input?.projectId);
    case "organization.project-brief": return brief(input?.projectId);
    case "organization.inbox": return inbox;
    case "organization.recovery": return { status: "observed", observedAt: iso(0), recovery: { items: [] } };
    case "organization.tracker-view": return view(input?.projectId);
    case "organization.integrations": return integrations;
    default: refused.push(name); throw Error(`no fixture for ${name}`);
  }
}
