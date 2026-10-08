// client/team-tree.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// client/team-tree.ts
var STATE_ORDER = {
  waiting: 0,
  working: 1,
  paused: 2,
  idle: 3,
  offline: 4
};
var STATE_LABEL = {
  waiting: "Waiting for you",
  working: "Working",
  paused: "Paused",
  idle: "Idle",
  offline: "Offline"
};
var OFFLINE_STATUSES = /* @__PURE__ */ new Set(["unavailable", "unreachable", "offline", "disconnected"]);
var PROVIDERS = { claude: "Claude", codex: "Codex" };
var defaultTime = (iso) => new Date(iso).toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
function stateOf(node2, offlineHosts = /* @__PURE__ */ new Set()) {
  if ((node2.pending ?? 0) > 0) return "waiting";
  if (node2.quotaWait) return "paused";
  if (offlineHosts.has(node2.host) || OFFLINE_STATUSES.has(node2.status)) return "offline";
  if (node2.status === "running" || (node2.backgroundWork?.count ?? 0) > 0) return "working";
  return "idle";
}
function nowSentence(node2, state, formatTime) {
  const title = node2.title.trim() || "its task";
  switch (state) {
    case "waiting":
      return (node2.pending ?? 0) > 1 ? `Has ${node2.pending} questions for you about ${title}` : `Has a question for you about ${title}`;
    case "paused": {
      const wait = node2.quotaWait;
      const why = wait.reason === "verification" ? "account check" : "usage limit";
      return wait.nextCheckAt ? `Paused: ${why}, checks again at ${formatTime(wait.nextCheckAt)}` : `Paused: ${why}`;
    }
    case "offline":
      return `Its computer, ${node2.host}, can't be reached right now`;
    case "working": {
      const jobs = node2.backgroundWork?.count ?? 0;
      return node2.status === "running" ? `Working on ${title}` : `Running ${jobs} background job${jobs === 1 ? "" : "s"} for ${title}`;
    }
    default:
      return `Finished its last message on ${title}`;
  }
}
var CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
function modelLabel(model) {
  const m = CLAUDE_ID.exec(model);
  if (!m) return model;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
function runsLabel(node2) {
  const provider = PROVIDERS[node2.provider] ?? (node2.provider || null);
  if (!provider) return null;
  return node2.model ? `${provider} \xB7 ${modelLabel(node2.model)}` : provider;
}
function buildTeamTree(input) {
  const offlineHosts = input.offlineHosts ?? /* @__PURE__ */ new Set();
  const formatTime = input.formatTime ?? defaultTime;
  const byId = new Map(input.nodes.map((node2) => [node2.id, node2]));
  const parentOf = /* @__PURE__ */ new Map();
  const main = input.mainSessionId && byId.has(input.mainSessionId) ? input.mainSessionId : null;
  for (const node2 of input.nodes) {
    const line = node2.reportsTo === "role:main-assistant" ? main : node2.reportsTo?.split("@", 1)[0];
    if (line && byId.has(line) && line !== node2.id) parentOf.set(node2.id, line);
  }
  const recorded = (node2) => Boolean(node2.reportsTo || node2.parent);
  for (const node2 of input.nodes)
    if (!parentOf.has(node2.id) && node2.parent && byId.has(node2.parent) && node2.parent !== node2.id)
      parentOf.set(node2.id, node2.parent);
  for (const edge of input.edges ?? [])
    if (!parentOf.has(edge.to) && byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to)
      parentOf.set(edge.to, edge.from);
  for (const node2 of input.nodes) {
    if (parentOf.has(node2.id) || node2.id === main || input.mainSessionIds?.has(node2.id)) continue;
    if (input.leadSessionIds?.has(node2.id)) {
      if (main) parentOf.set(node2.id, main);
      continue;
    }
    const lead = node2.project ? input.leadByProject?.get(node2.project) : void 0;
    if (lead && lead !== node2.id && byId.has(lead)) parentOf.set(node2.id, lead);
  }
  const childrenOf = /* @__PURE__ */ new Map();
  for (const [child, parent] of parentOf)
    childrenOf.set(parent, [...childrenOf.get(parent) ?? [], child]);
  const roleOf = (node2) => {
    if (input.mainSessionIds?.has(node2.id) || node2.role === "prime") return "main";
    if (input.leadSessionIds?.has(node2.id) || node2.role === "project-orchestrator" || node2.role === "lead" || (childrenOf.get(node2.id)?.length ?? 0) > 0)
      return "lead";
    return "worker";
  };
  const roleLabel = (node2, role) => {
    if (role === "main") return "Main assistant";
    const project = node2.project ? input.projectNames?.get(node2.project) : void 0;
    const base = role === "lead" ? "Project lead" : "Worker";
    return project ? `${base} \xB7 ${project}` : base;
  };
  const counts = {
    waiting: 0,
    working: 0,
    paused: 0,
    idle: 0,
    offline: 0
  };
  const placed = /* @__PURE__ */ new Set();
  const card = (node2) => {
    placed.add(node2.id);
    const state = stateOf(node2, offlineHosts);
    counts[state] += 1;
    const role = roleOf(node2);
    const children = (childrenOf.get(node2.id) ?? []).filter((id) => !placed.has(id)).map((id) => card(byId.get(id)));
    return {
      id: node2.id,
      role,
      roleLabel: roleLabel(node2, role),
      title: node2.title,
      state,
      stateLabel: STATE_LABEL[state],
      now: nowSentence(node2, state, formatTime),
      host: node2.host,
      serverId: node2.serverId ?? null,
      agentId: node2.agentId,
      runs: runsLabel(node2),
      noLine: role !== "main" && !recorded(node2),
      directLink: node2.directLink ? byId.get(node2.directLink)?.title ?? "a chat" : null,
      sessions: 1,
      children: sortCards(children)
    };
  };
  const roots = input.nodes.filter((node2) => !parentOf.has(node2.id)).map(card);
  for (const node2 of input.nodes) if (!placed.has(node2.id)) roots.push(card(node2));
  return { roots: sortCards(mergeOfflineRoots(roots)), counts, summary: summarise(counts) };
}
function mergeOfflineRoots(roots) {
  const kept = [];
  const byHost = /* @__PURE__ */ new Map();
  for (const root of roots) {
    if (root.state === "offline" && root.children.length === 0)
      byHost.set(root.host, [...byHost.get(root.host) ?? [], root]);
    else kept.push(root);
  }
  for (const [host, cards] of byHost) {
    if (cards.length === 1) {
      kept.push(cards[0]);
      continue;
    }
    kept.push({
      ...cards[0],
      id: `offline:${host}`,
      roleLabel: "Offline computer",
      title: host,
      now: `${cards.length} sessions on ${host} can't be reached right now`,
      agentId: null,
      runs: null,
      sessions: cards.length
    });
  }
  return kept;
}
function sortCards(cards) {
  const roleRank = { main: 0, lead: 1, worker: 2 };
  return [...cards].sort(
    (a, b) => roleRank[a.role] - roleRank[b.role] || STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title)
  );
}
function summarise(counts) {
  const parts = [
    counts.working && `${counts.working} working`,
    counts.waiting && `${counts.waiting} waiting for you`,
    counts.paused && `${counts.paused} paused`,
    counts.offline && `${counts.offline} offline`,
    counts.idle && `${counts.idle} idle`
  ].filter(Boolean);
  return parts.length ? parts.join(" \xB7 ") : "No sessions yet";
}

// client/team-tree.test.ts
var n = 0;
var uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
var TASK = "10000000-0000-4000-8000-000000000001";
var PROJECT = "20000000-0000-4000-8000-000000000001";
var node = (over) => ({
  id: uuid(),
  task: TASK,
  host: "Studio Mac",
  agentId: null,
  title: "Session",
  provider: "claude",
  model: "Opus 5.5",
  mode: "default",
  status: "idle",
  pending: 0,
  observedAt: null,
  updatedAt: null,
  error: null,
  ...over
});
var shape = (card) => ({
  role: card.roleLabel,
  state: card.stateLabel,
  ...card.children.length ? { children: card.children.map(shape) } : {}
});
test("main assistant leads project leads, which run workers, each in plain words", () => {
  const main = node({ title: "Fulcra main", status: "running" });
  const lead = node({ title: "Forecast", parent: main.id, project: PROJECT, pending: 1 });
  const working = node({ title: "Table", parent: lead.id, status: "running" });
  const paused = node({
    title: "Units",
    parent: lead.id,
    quotaWait: {
      messageId: uuid(),
      sessionId: uuid(),
      taskId: TASK,
      state: "waiting",
      reason: "provider-limit",
      since: null,
      checkedAt: null,
      nextCheckAt: "2026-10-07T04:20:00.000Z"
    }
  });
  const tree = buildTeamTree({
    nodes: [paused, working, lead, main],
    mainSessionIds: /* @__PURE__ */ new Set([main.id]),
    projectNames: /* @__PURE__ */ new Map([[PROJECT, "weather-cli"]]),
    formatTime: () => "14:20"
  });
  assert.deepEqual(tree.roots.map(shape), [
    {
      role: "Main assistant",
      state: "Working",
      children: [
        {
          role: "Project lead \xB7 weather-cli",
          state: "Waiting for you",
          children: [
            { role: "Worker", state: "Working" },
            { role: "Worker", state: "Paused" }
          ]
        }
      ]
    }
  ]);
  const leadCard = tree.roots[0].children[0];
  assert.equal(leadCard.now, "Has a question for you about Forecast");
  assert.equal(leadCard.children[0].now, "Working on Table");
  assert.equal(leadCard.children[1].now, "Paused: usage limit, checks again at 14:20");
  assert.equal(tree.roots[0].runs, "Claude \xB7 Opus 5.5");
  assert.equal(tree.summary, "2 working \xB7 1 waiting for you \xB7 1 paused");
});
test("supervision edges place workers when the session has no parent label", () => {
  const lead = node({ title: "Lead", role: "project-orchestrator" });
  const worker = node({ title: "Worker one" });
  const tree = buildTeamTree({
    nodes: [worker, lead],
    edges: [{ from: lead.id, to: worker.id, active: true, state: "working", event: null }]
  });
  assert.deepEqual(tree.roots.map(shape), [
    { role: "Project lead", state: "Idle", children: [{ role: "Worker", state: "Idle" }] }
  ]);
  assert.equal(tree.roots[0].children[0].now, "Finished its last message on Worker one");
});
test("offline sessions on one computer show once", () => {
  const tree = buildTeamTree({
    nodes: [
      node({ host: "Book", title: "A" }),
      node({ host: "Book", title: "B", status: "unavailable" }),
      node({ host: "Book", title: "C" }),
      node({ host: "Mini", title: "D", status: "running" })
    ],
    offlineHosts: /* @__PURE__ */ new Set(["Book"])
  });
  assert.equal(tree.roots.length, 2);
  const offline = tree.roots.find((card) => card.state === "offline");
  assert.equal(offline.roleLabel, "Offline computer");
  assert.equal(offline.sessions, 3);
  assert.equal(offline.now, "3 sessions on Book can't be reached right now");
  assert.equal(tree.summary, "1 working \xB7 3 offline");
});
test("a recorded loop is cut and still shown; an empty fleet says so", () => {
  const a = node({ title: "A" });
  const b = node({ title: "B", parent: a.id });
  a.parent = b.id;
  const tree = buildTeamTree({ nodes: [a, b] });
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].children.length, 1);
  assert.equal(buildTeamTree({ nodes: [] }).summary, "No sessions yet");
});
test("Claude model ids read as people say them; other names stay as they are", () => {
  assert.equal(modelLabel("claude-haiku-4-5"), "Haiku 4.5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("claude-opus-5"), "Opus 5");
  assert.equal(modelLabel("Opus 5.5"), "Opus 5.5");
  assert.equal(modelLabel("gpt-6.1-sol"), "gpt-6.1-sol");
  const tree = buildTeamTree({ nodes: [node({ provider: "claude", model: "claude-haiku-4-5" })] });
  assert.equal(tree.roots[0].runs, "Claude \xB7 Haiku 4.5");
});
test("a team set up from existing chats shows the main assistant above every lead, and workers under their lead", () => {
  const main = node({ title: "Main assistant" });
  const lead = node({ title: "Fulcra thin fork", project: PROJECT });
  const worker = node({ title: "Review", project: PROJECT });
  const loose = node({ title: "Scratch" });
  const tree = buildTeamTree({
    nodes: [worker, loose, lead, main],
    mainSessionIds: /* @__PURE__ */ new Set([main.id]),
    mainSessionId: main.id,
    leadSessionIds: /* @__PURE__ */ new Set([lead.id]),
    leadByProject: /* @__PURE__ */ new Map([[PROJECT, lead.id]]),
    projectNames: /* @__PURE__ */ new Map([[PROJECT, "Fulcra"]])
  });
  assert.deepEqual(tree.roots.map(shape), [
    {
      role: "Main assistant",
      state: "Idle",
      children: [
        {
          role: "Project lead \xB7 Fulcra",
          state: "Idle",
          children: [{ role: "Worker \xB7 Fulcra", state: "Idle" }]
        }
      ]
    },
    { role: "Worker", state: "Idle" }
  ]);
});
test("reporting lines place chats, follow the main assistant role, and mark a chat with no line", () => {
  const main = node({ title: "Main assistant" });
  const lead = node({ title: "Mac ops", reportsTo: "role:main-assistant" });
  const worker = node({ title: "Installer", reportsTo: lead.id, directLink: main.id });
  const loose = node({ title: "Scratch" });
  const tree = buildTeamTree({
    nodes: [main, lead, worker, loose],
    mainSessionIds: /* @__PURE__ */ new Set([main.id]),
    mainSessionId: main.id
  });
  const top = tree.roots.find((c) => c.id === main.id);
  assert.equal(top.noLine, false);
  const leadCard = top.children.find((c) => c.id === lead.id);
  assert.equal(leadCard.noLine, false);
  const workerCard = leadCard.children.find((c) => c.id === worker.id);
  assert.equal(workerCard.noLine, false);
  assert.equal(workerCard.directLink, "Main assistant");
  const looseCard = tree.roots.find((c) => c.id === loose.id);
  assert.equal(looseCard.noLine, true);
});
