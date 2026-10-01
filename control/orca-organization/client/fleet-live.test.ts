import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  allHostsLabel,
  appHostName,
  appLinkTargets,
  describeLiveState,
  displayHostName,
  FLEET_AUTO_RETRY_LIMIT,
  fleetReadState,
  isWorkingForDisplay,
  matchLiveEntries,
  planLiveReads,
  plainNodeError,
  readAppLinkSections,
  readLiveOverlay,
  type AppHost,
} from "./fleet-live-model";

// Fictional hosts. The controller calls its own host "Desk" and the other "Workshop"; the app knows the other
// host by its own label.
const DESK = "srv_fixture_desk",
  WORKSHOP = "srv_fixture_workshop",
  ANNEX = "srv_fixture_annex";
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const task = id(99);
const node = (
  n: number,
  host: string,
  serverId: string | null,
  agentId: string | null = id(n + 100),
) => ({
  id: id(n),
  task,
  host,
  serverId,
  agentId,
  title: "Remote conversation",
  provider: "codex",
  model: null,
  mode: "delegated",
  status: "unavailable",
  pending: null,
  observedAt: null,
  updatedAt: null,
  error: "Remote observation unavailable",
  quotaWait: null,
});
const hosts: AppHost[] = [
  { serverId: DESK, label: "Desk", status: "online" },
  { serverId: WORKSHOP, label: "Workshop", status: "online" },
  { serverId: ANNEX, label: ANNEX, status: "offline" },
];
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

test("reads only other hosts this app has online, for rows with a bound host and agent", () => {
  const nodes = [
    node(1, "Desk", DESK),
    node(2, "Workshop", WORKSHOP),
    node(3, "Workshop", WORKSHOP),
    node(4, "Workshop", WORKSHOP, null),
    node(5, "Workshop", null),
    node(6, "Annex", ANNEX),
    node(7, "Workshop", WORKSHOP, id(102)),
  ];
  const plan = planLiveReads(nodes, hosts, "Desk");
  assert.deepEqual([...plan], [[WORKSHOP, [id(102), id(103)]]]);
  assert.equal(
    planLiveReads(nodes, [], "Desk").size,
    0,
    "an app without the host API reads nothing",
  );
});

test("joins each host's report to its rows, by the host's name and never its id", async () => {
  const nodes = deepFreeze([node(1, "Desk", DESK), node(2, "Workshop", WORKSHOP)]);
  const calls: string[] = [];
  const client = (serverId: string) => ({
    agents: {
      list: async () => {
        calls.push(serverId);
        return {
          entries: [
            {
              agent: {
                id: id(102),
                status: "idle",
                title: "Tally builder",
                updatedAt: "2026-09-27T09:00:00.000Z",
                backgroundWork: { count: 1 },
              },
            },
            { agent: { id: id(900), status: "running" } },
          ],
        };
      },
    },
  });
  const overlay = await readLiveOverlay(nodes, hosts, "Desk", client);
  assert.deepEqual(calls, [WORKSHOP]);
  const state = overlay.byNode.get(id(2))!;
  assert.deepEqual(state, {
    status: "idle",
    pending: 0,
    title: "Tally builder",
    backgroundWorkCount: 1,
    updatedAt: "2026-09-27T09:00:00.000Z",
    via: "Workshop",
  });
  assert.equal(
    overlay.byNode.has(id(1)),
    false,
    "the controller's own host keeps its own live state",
  );
  assert.equal(
    describeLiveState(state),
    "Live from this app's link to Workshop: Idle · 1 background job",
  );
  assert.doesNotMatch(JSON.stringify([...overlay.byNode]), /srv_/);
});

test("one host failing or hanging costs only that host's overlay, within the budget", async () => {
  const both: AppHost[] = hosts.map((h) =>
    h.serverId === ANNEX ? { ...h, label: "Annex", status: "online" } : h,
  );
  const nodes = [node(2, "Workshop", WORKSHOP), node(6, "Annex", ANNEX)];
  const client = (serverId: string) => ({
    agents: {
      list: () =>
        serverId === ANNEX
          ? new Promise(() => {})
          : Promise.resolve({ entries: [{ agent: { id: id(102), status: "running" } }] }),
    },
  });
  const started = Date.now();
  const overlay = await readLiveOverlay(nodes, both, "Desk", client, 50);
  assert(Date.now() - started < 2000, "a hung host is bounded");
  assert.deepEqual(overlay.unavailable, ["Annex"]);
  assert.equal(overlay.byNode.get(id(2))?.status, "running");
  const throwing = await readLiveOverlay(
    nodes,
    both,
    "Desk",
    (serverId: string) => ({
      agents: {
        list: async () => {
          if (serverId === WORKSHOP) throw Error("offline");
          return { entries: "not a list" };
        },
      },
    }),
    50,
  );
  assert.deepEqual(throwing.unavailable, ["Workshop"]);
  assert.equal(throwing.byNode.size, 0);
});

test("a host without a real name reads as 'Unnamed host'", () => {
  assert.equal(appHostName({ serverId: WORKSHOP, label: "  ", status: "online" }), "Unnamed host");
  assert.equal(
    appHostName({ serverId: WORKSHOP, label: WORKSHOP, status: "online" }),
    "Unnamed host",
  );
  const byNode = matchLiveEntries(
    [node(2, "Workshop", WORKSHOP)],
    new Map([[WORKSHOP, [{ id: id(102), status: "running", backgroundWork: { count: "2" } }]]]),
    new Map(),
  );
  assert.deepEqual(byNode.get(id(2)), {
    status: "running",
    pending: 0,
    title: null,
    backgroundWorkCount: 0,
    updatedAt: null,
    via: "Unnamed host",
  });
});

test("'Working now' counts live running, background jobs, or the recorded state, for display", () => {
  const n = node(2, "Workshop", WORKSHOP);
  const live = {
    status: "idle",
    title: null,
    backgroundWorkCount: 0,
    updatedAt: null,
    via: "Workshop",
  };
  assert.equal(isWorkingForDisplay(n, live), false);
  assert.equal(isWorkingForDisplay(n, { ...live, backgroundWorkCount: 2 }), true);
  assert.equal(isWorkingForDisplay(n, { ...live, status: "running" }), true);
  assert.equal(isWorkingForDisplay({ ...n, status: "running" }, undefined), true);
  assert.equal(
    isWorkingForDisplay(
      { ...n, status: "idle", backgroundWork: { count: 1 } } as typeof n,
      undefined,
    ),
    true,
  );
});

// The overlay is display-only: it may reach text and the "Working now" count, and nothing an action receives.
// Every use of it in the Sessions page is listed here; anything else (a button, a link, the step-through, a
// selection, the controller's node objects) fails this test.
test("liveOverlayIsDisplayOnly: overlay values reach only display text and the display count", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "client/fleet.tsx"), "utf8");
  const allowed = [
    'import { useLiveHostOverlay, describeLiveState, isWorkingForDisplay, useAppHostList, displayHostName, plainNodeError, useAppLinkSections, allHostsLabel, appLinkTargets, fleetReadState } from "./fleet-live";',
    'import { AppLinkSections } from "./fleet-app-link";',
    'import { FLEET_AUTO_RETRY_LIMIT } from "./fleet-live-model";',
    "const appLink = useAppLinkSections(useMemo(() => appLinkTargets(hostList.data?.hosts ?? [], localHost, host), [hostList.data, localHost, host]), enrolledAgentIds, frozen);",
    "{appLink.length > 0 && <Text style={muted}>Below is what this app can see of your other Macs.</Text>}",
    "<AppLinkSections sections={appLink} theme={props.theme} />",
    "liveLine = null, hostLabel, errorText }",
    "/** Display only: never an input to an action below. */ liveLine?: string | null;",
    "hasLiveLine: !!liveLineFor(n.id) });",
    '{liveLine && <Text testID="fleet-live-line" style={muted}>{liveLine}</Text>}',
    "const live = useLiveHostOverlay(shown, d?.hosts?.[0] ?? null, frozen);",
    "const liveLineFor = (id: string) => { const state = live.byNode.get(id); return state ? describeLiveState(state) : null; };",
    "liveLine={liveLineFor(chosen.id)}",
    '["Working now", d.nodes.filter(n => isWorkingForDisplay(n, live.byNode.get(n.id))).length]',
    "(live.byNode.get(n.id)?.pending ?? n.pending ?? 0)",
    '{live.unavailable.length > 0 && <Text style={muted}>Live state unavailable from this app: {live.unavailable.join(", ")}</Text>}',
    "{liveLineFor(n.id) && <Text style={muted}>{liveLineFor(n.id)}</Text>}",
  ];
  let rest = source;
  for (const fragment of allowed) {
    assert(rest.includes(fragment), `expected display use is missing or changed: ${fragment}`);
    rest = rest.split(fragment).join("");
  }
  const stray = [
    ...rest.matchAll(
      /\b(live|liveLine|liveLineFor|useLiveHostOverlay|describeLiveState|isWorkingForDisplay|appLink|AppLinkSections|useAppLinkSections|appLinkTargets)\b/g,
    ),
  ].map((m) => rest.slice(Math.max(0, m.index! - 60), m.index! + 60));
  assert.deepEqual(stray, [], "overlay reached something other than display text");
  // The rows every action receives are the controller's, untouched.
  assert(
    source.includes(
      "<Activity key={[props.host?.id,chosen.task,chosen.id].join(':')} node={chosen} fleet={d}",
    ),
  );
});

test("reading the overlay never changes the controller's rows", async () => {
  const nodes = deepFreeze([node(2, "Workshop", WORKSHOP)]);
  const before = JSON.stringify(nodes);
  const overlay = await readLiveOverlay(nodes, hosts, "Desk", () => ({
    agents: {
      list: async () => ({
        entries: [{ agent: { id: id(102), status: "running", backgroundWork: { count: 3 } } }],
      }),
    },
  }));
  assert.equal(JSON.stringify(nodes), before);
  assert.notEqual(overlay.byNode.get(id(2)) as unknown, nodes[0] as unknown);
  assert.equal(nodes[0].status, "unavailable");
});

test("host chips and rows use a real name: the app's label, else the configured name capitalised (L8)", () => {
  assert.equal(displayHostName("mini", null, hosts), "Mini");
  assert.equal(displayHostName("workshop", WORKSHOP, hosts), "Workshop");
  assert.equal(
    displayHostName("book", ANNEX, hosts),
    "Book",
    "an app label that only repeats the id is not a name",
  );
  assert.equal(displayHostName("  ", null, hosts), "Unnamed host");
  assert.equal(
    displayHostName("Studio", DESK, [{ serverId: DESK, label: "Desk", status: "online" }]),
    "Desk",
  );
});

test("'can't reach' errors on another host read in plain words; other errors pass through (L8)", () => {
  const base = { remote: true, hostName: "Workshop", hasLiveLine: true };
  for (const error of [
    "Remote observation unavailable; current state unavailable",
    "Remote observation still in progress; current state unavailable",
    "Remote observation not started within this refresh budget; refresh or inspect this session",
    "Native observation unavailable; session retained",
  ]) {
    assert.equal(
      plainNodeError(error, base),
      "The Command Centre can't reach Workshop directly. The live line above comes from this app.",
    );
    assert.equal(
      plainNodeError(error, { ...base, hasLiveLine: false }),
      "The Command Centre can't reach Workshop directly. Refresh to try again.",
    );
  }
  assert.equal(
    plainNodeError("Native observation unavailable; session retained", { ...base, remote: false }),
    "Native observation unavailable; session retained",
    "the local host keeps its own wording",
  );
  assert.equal(
    plainNodeError(
      "Remote session route changed during observation; refresh to inspect current state",
      base,
    ),
    "Remote session route changed during observation; refresh to inspect current state",
  );
  assert.equal(plainNodeError(null, base), null);
});

// MH3 §6.3 on the Command Centre side: background work is display only here too. Only the Sessions display
// code may mention it; the trusted host half, management and the controller (src/control, when checked out
// beside the plugin) must not.
test("background work is referenced only by the Sessions display code", () => {
  const MENTION = /backgroundWork|background_work|BackgroundWork/;
  const root = process.cwd();
  const allowed = [
    "client/fleet-app-link.tsx",
    "client/fleet-live-model.ts",
    "server/fleet.ts",
    "shared/fleet.ts",
  ];
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        return ["node_modules", "runtime", "docs", "screens"].includes(entry.name)
          ? []
          : walk(full);
      return /\.(ts|tsx|mts|mjs|js)$/.test(entry.name) && !/\.test\.|\.ui\.test\./.test(entry.name)
        ? [full]
        : [];
    });
  const mentioning = walk(root)
    .filter((file) => MENTION.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(mentioning, allowed);
  assert(
    fs.existsSync(path.join(root, "index.host.js")) &&
      !MENTION.test(fs.readFileSync(path.join(root, "index.host.js"), "utf8")),
  );
  const controller = path.join(root, "../src/control");
  if (fs.existsSync(controller))
    assert.deepEqual(
      walk(controller).filter((file) => MENTION.test(fs.readFileSync(file, "utf8"))),
      [],
    );
});

// MH4: the app-link list of other Macs' sessions is display only: its component has no buttons, links, handlers,
// navigation or RPC access at all.
test("the app-link section is reading only: no actions, navigation or RPC in its component", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "client/fleet-app-link.tsx"), "utf8");
  for (const forbidden of [
    /Pressable/,
    /onPress/,
    /WorkButton/,
    /navigation/,
    /useRpc/,
    /useContract/,
    /openAgent/,
    /Linking/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

// ---- MH4 (J15): Book selected while the Command Centre can't reach it ------------------------------------------

test("an unreadable Mac gets a bounded error state, never an endless 'retrying' (h2)", () => {
  const base = { hasData: false, isError: true, hostName: "Book", reason: "Observation timed out" };
  const first = fleetReadState({ ...base, failures: 1 });
  assert.equal(first.kind, "retrying");
  assert.equal(first.autoRetry, true);
  assert.match(
    first.message!,
    /can't read sessions on Book right now \(attempt 1 of 3\); trying again\. Reason: Observation timed out\./,
  );
  const stopped = fleetReadState({ ...base, failures: FLEET_AUTO_RETRY_LIMIT });
  assert.deepEqual(
    [stopped.kind, stopped.autoRetry],
    ["failed", false],
    "retries stop after the limit",
  );
  assert.match(stopped.message!, /stopped retrying after 3 attempts/);
  for (const failures of [1, 2, 3, 10])
    assert.doesNotMatch(fleetReadState({ ...base, failures }).message!, /not answering yet/);
  assert.equal(
    fleetReadState({ ...base, failures: 50, hasData: true }).kind,
    "ok",
    "a view with data keeps its own stale notice",
  );
  assert.equal(
    fleetReadState({ ...base, isError: false, failures: 0 }).message,
    "Reading sessions on Book…",
  );
  assert.match(
    fleetReadState({ ...base, hostName: null, failures: 3 }).message!,
    /can't read your sessions/,
  );
});

test("the everything chip reads 'Both Macs' for two Macs", () => {
  assert.equal(allHostsLabel(2), "Both Macs");
  assert.equal(allHostsLabel(3), "All hosts");
  assert.equal(allHostsLabel(1), "All hosts");
});

const configured = [
  { name: "Mini", serverId: DESK },
  { name: "Book", serverId: WORKSHOP },
  { name: "Spare", serverId: null },
];

test("other bound Macs are listed from the app link, in 'Both Macs' and in their own view", () => {
  assert.deepEqual(
    appLinkTargets(configured, "Mini", "all").map((h) => h.name),
    ["Book"],
  );
  assert.deepEqual(
    appLinkTargets(configured, "Mini", "Book").map((h) => h.name),
    ["Book"],
  );
  assert.deepEqual(appLinkTargets(configured, "Mini", "Mini"), []);
});

test("Book's sessions from the app link: titles not ids, newest first, enrolled ones left to the task list", async () => {
  const ID = "00000000-0000-4c69-ab90-000000002011";
  const agents = [
    {
      id: id(301),
      title: "CC REPAIR (MacBook): visible re-pair path",
      status: "idle",
      provider: "codex",
      updatedAt: "2026-09-27T02:00:00.000Z",
    },
    {
      id: id(302),
      title: ID,
      status: "closed",
      provider: "codex",
      updatedAt: "2026-09-27T01:00:00.000Z",
    },
    {
      id: id(303),
      title: "MacBook parity check worker",
      status: "running",
      provider: "claude",
      updatedAt: "2026-09-27T03:00:00.000Z",
      backgroundWork: { count: 1 },
    },
    {
      id: id(304),
      title: "Enrolled worker",
      status: "idle",
      provider: "codex",
      updatedAt: "2026-09-27T04:00:00.000Z",
    },
  ];
  const book = [{ serverId: WORKSHOP, label: "MacBook-Pro.local", status: "online" }];
  const [section] = await readAppLinkSections(
    [configured[1]!],
    book,
    () => ({ agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })) }) } }),
    new Set([id(304)]),
  );
  assert.equal(section!.state, "ok");
  assert.equal(section!.hostName, "MacBook-Pro.local");
  assert.deepEqual(
    section!.sessions.map((s) => [s.title, s.status, s.backgroundWorkCount]),
    [
      ["MacBook parity check worker", "Working", 1],
      ["CC REPAIR (MacBook): visible re-pair path", "Idle", 0],
      ["Untitled session", "Closed", 0],
    ],
  );
  assert.doesNotMatch(JSON.stringify(section), /2b642082|srv_/);
});

test("no live link, or a failing one, says so plainly and lists nothing", async () => {
  const offline = await readAppLinkSections(
    [configured[1]!],
    [{ serverId: WORKSHOP, label: "Book", status: "offline" }],
    () => ({ agents: { list: async () => ({ entries: [] }) } }),
    new Set(),
  );
  assert.equal(offline[0]!.state, "not-linked");
  assert.match(offline[0]!.note, /no live link to Book/);
  const failing = await readAppLinkSections(
    [configured[1]!],
    [{ serverId: WORKSHOP, label: "Book", status: "online" }],
    () => ({ agents: { list: () => new Promise(() => {}) } }),
    new Set(),
    50,
  );
  assert.equal(failing[0]!.state, "unavailable");
  const noApi = await readAppLinkSections([configured[1]!], [], undefined, new Set());
  assert.equal(noApi[0]!.state, "not-linked");
});

test("U7 pending permission beats running in live Sessions and app-link rows", async () => {
  const n = { ...node(1, "Workshop", WORKSHOP), status: "running", pending: 1 };
  assert.equal(isWorkingForDisplay(n as any, undefined), false);
  const overlay = matchLiveEntries(
    [n] as any,
    new Map([
      [
        WORKSHOP,
        [{ agent: { id: n.agentId, status: "running", pendingPermissions: [{ id: "p" }] } }],
      ],
    ]),
    new Map([[WORKSHOP, "Workshop"]]),
  );
  const live = overlay.get(n.id)!;
  const missing = matchLiveEntries(
    [n] as any,
    new Map([[WORKSHOP, [{ agent: { id: n.agentId, status: "running" } }]]]),
    new Map([[WORKSHOP, "Workshop"]]),
  );
  assert.match(
    describeLiveState(missing.get(n.id)!),
    /Needs you/,
    "missing live permissions cannot erase a recorded wait",
  );
  assert.match(describeLiveState(live), /Needs you/);
  assert.equal(isWorkingForDisplay(n as any, live), false);
  const sections = await readAppLinkSections(
    [{ name: "Workshop", serverId: WORKSHOP }],
    hosts,
    () => ({
      agents: {
        list: async () => ({
          entries: [
            { agent: { id: "other", status: "running", pendingPermissions: [{ id: "p" }] } },
          ],
        }),
      },
    }),
    new Set(),
  );
  assert.equal(sections[0].sessions[0].status, "Needs you");
});

test("remote Sessions live line shows the current account and clears it when no pool label is reported", () => {
  const n = node(1, "Workshop", WORKSHOP);
  for (const name of ["Alpha", "Beta", "Alpha", null]) {
    const overlay = matchLiveEntries(
      [n],
      new Map([
        [
          WORKSHOP,
          [
            {
              agent: {
                id: n.agentId,
                status: "idle",
                labels: name ? { "fulcra.account-name": name } : {},
              },
            },
          ],
        ],
      ]),
      new Map([[WORKSHOP, "Workshop"]]),
    );
    const line = describeLiveState(overlay.get(n.id)!);
    if (name) assert.match(line, new RegExp(`account ${name}`));
    else assert.doesNotMatch(line, /account/);
  }
});
