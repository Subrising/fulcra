import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountsSurface } from "./accounts";
import { SwitchAccountPanel, registerAccountSwitch, SWITCH_PANEL } from "./switch-account";
import { setHandler, calls } from "./ui-test-adapters.mjs";
const dom = new JSDOM("<html><body></body></html>", { url: "http://component.test" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#ccc",
    border: "#888",
    surface0: "#111",
    surface1: "#222",
    statusSuccess: "#0f0",
    statusWarning: "#fa0",
  },
};
const A = "11111111-1111-4111-8111-000000000001",
  B = "11111111-1111-4111-8111-000000000002";
const sel = (model, thinkingOptionId) => ({ model, thinkingOptionId });
const view = (over = {}) => ({
  policy: "priority",
  accounts: [
    {
      id: A,
      provider: "claude",
      name: "Work",
      enabled: true,
      priority: 1,
      status: { state: "limited", until: "2026-10-01T05:00:00.000Z" },
      limitNote: null,
      sessions: ["s1", "s2"],
      lastUsedAt: null,
    },
    {
      id: B,
      provider: "claude",
      name: "Personal",
      enabled: true,
      priority: 2,
      status: { state: "ok" },
      limitNote: null,
      sessions: [],
      lastUsedAt: null,
    },
  ],
  allLimited: { claude: null },
  defaultAccounts: { claude: null, codex: null },
  rotations: [
    {
      at: "2026-10-01T01:00:00.000Z",
      session: "s1",
      provider: "claude",
      from: "Work",
      to: "Personal",
      resetAt: "2026-10-01T05:00:00.000Z",
      earliestReset: null,
    },
  ],
  defaults: {
    roles: Object.fromEntries(
      ["orchestration", "planning", "review", "implementation", "research"].map((r) => [
        r,
        {
          provider: "claude",
          claude: sel(
            r === "implementation" ? "claude/claude-sonnet-5-5" : "claude/claude-opus-5-5",
            r === "implementation" ? "medium" : "high",
          ),
          codex: sel(null, "high"),
        },
      ]),
    ),
    orchestrationGuard: false,
    modes: { claude: "auto", codex: "full-access" },
    modeChoices: {
      claude: ["auto", "acceptEdits", "default", "plan"],
      codex: ["full-access", "auto-review", "auto"],
    },
  },
  catalog: {
    claude: [
      {
        id: "claude/claude-opus-5-5",
        label: "Opus 5.5",
        efforts: ["low", "medium", "high", "max"],
      },
      { id: "claude/claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
    ],
    codex: null,
  },
  ...over,
});
function setup(v = view()) {
  const writes = [];
  setHandler((name, input) => {
    if (name === "organization.accounts") return v;
    if (
      [
        "organization.accounts.add",
        "organization.accounts.update",
        "organization.accounts.settings",
      ].includes(name)
    ) {
      writes.push({ name, input });
      return { ok: true, message: "Saved." };
    }
    throw Error("Unexpected " + name);
  });
  render(
    React.createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 },
          },
        }),
      },
      React.createElement(AccountsSurface, {
        theme,
        host: { id: "host-test", label: "Test host" },
        layout: { compact: false },
      }),
    ),
  );
  return writes;
}
afterEach(() => {
  cleanup();
});
test("accounts show their order, status, sessions and the recent move; no credential anywhere", async () => {
  setup();
  assert.ok(await screen.findByText("1. Work"));
  assert.ok(screen.getByText(/^Limited until/));
  assert.ok(screen.getByText("Ready"));
  assert.ok(screen.getByText(/^2 sessions using it now/));
  assert.ok(screen.getByText(/Recent moves: .* from Work to Personal/));
  assert.equal(
    /token|sk-ant|secret/i.test(
      document.body.textContent.replace(
        /`claude setup-token`|Token from|token it prints|Save token|its token/g,
        "",
      ),
    ),
    false,
  );
});
test("every account limited: a clear state with the earliest reset", async () => {
  setup(view({ allLimited: { claude: "2026-10-01T05:00:00.000Z" } }));
  assert.match(
    (await screen.findByTestId("accounts-all-limited-claude")).textContent,
    /Every Claude account is limited\. The first one resets/,
  );
});
test("adding a Claude account sends the name and the token once, and the field is cleared", async () => {
  const writes = setup();
  fireEvent.change(await screen.findByLabelText("Claude account name"), {
    target: { value: "Third" },
  });
  fireEvent.change(screen.getByLabelText("Claude account token"), {
    target: { value: "sk-ant-oat01-" + "z".repeat(40) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Claude account" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.deepEqual(writes[0], {
    name: "organization.accounts.add",
    input: { provider: "claude", name: "Third", token: "sk-ant-oat01-" + "z".repeat(40) },
  });
  assert.equal(screen.getByLabelText("Claude account token").value, "");
});
test("policy and role defaults: only the efforts the chosen model offers; a model change drops an effort it does not offer", async () => {
  const writes = setup();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Spread: the ready account with the fewest sessions",
    }),
  );
  await waitFor(() =>
    assert.deepEqual(writes.at(-1), {
      name: "organization.accounts.settings",
      input: { policy: "spread" },
    }),
  );
  const lead = screen.getByTestId("role-defaults-orchestration");
  assert.ok(lead.textContent.includes("max")); // Opus offers max
  fireEvent.click(
    screen.getByRole("button", { name: "Main assistant and project leads model Sonnet 5.5" }),
  );
  await waitFor(() => assert.equal(writes.at(-1).input.role, "orchestration"));
  assert.deepEqual(writes.at(-1).input.defaults.claude, {
    model: "claude/claude-sonnet-5-5",
    thinkingOptionId: "high",
  });
  assert.equal(
    screen.getByTestId("role-defaults-implementation").textContent.includes("max"),
    false,
  ); // Sonnet offers no max
});
test("the orchestration guard is one switch", async () => {
  const writes = setup();
  fireEvent.click(await screen.findByRole("button", { name: /Leads must start sessions/ }));
  await waitFor(() =>
    assert.deepEqual(writes.at(-1), {
      name: "organization.accounts.settings",
      input: { orchestrationGuard: true },
    }),
  );
  void calls;
});

test("W3: Settings shows the default permission mode per provider and saves a change", async () => {
  const writes = setup();
  const codex = await screen.findByTestId("default-mode-codex"),
    claude = screen.getByTestId("default-mode-claude");
  assert.ok(codex.textContent.includes("Full access"));
  assert.ok(
    codex.textContent.includes(
      "Codex Full Access runs commands without approval prompts. Fulcra cannot pre-check credential access, destructive Git actions or publishing in this mode.",
    ),
  );
  assert.ok(
    claude.textContent.includes("Claude reviews risky actions itself; no routine prompts."),
  );
  assert.equal(claude.textContent.includes("Fulcra cannot pre-check"), false);
  assert.ok(claude.textContent.includes("Auto"));
  assert.equal(
    screen
      .getByRole("button", { name: "Codex permission mode Full access" })
      .getAttribute("aria-selected"),
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Codex permission mode Auto-review" }));
  await waitFor(() =>
    assert.deepEqual(writes.at(-1), {
      name: "organization.accounts.settings",
      input: { mode: { provider: "codex", modeId: "auto-review" } },
    }),
  );
  assert.equal(screen.queryByRole("button", { name: /bypass/i }), null);
});
// ---- W1: Switch account… (a session's menu and /account in its chat) and the default account for new sessions
const session = (over = {}) => ({
  provider: "claude",
  current: A,
  accounts: [
    { id: A, name: "Work", status: { state: "ok" }, isDefault: false },
    { id: B, name: "Personal", status: { state: "ok" }, isDefault: true },
    {
      id: "11111111-1111-4111-8111-000000000003",
      name: "Spare",
      status: { state: "limited", until: "2026-10-01T05:00:00.000Z" },
      isDefault: false,
    },
  ],
  ...over,
});
function setupPanel(
  v = session(),
  reply = { ok: true, message: "Continued on Personal with its history." },
) {
  const writes = [];
  setHandler((name, input) => {
    if (name === "organization.accounts.session") {
      assert.deepEqual(input, { agentId: "agent-1" });
      return v;
    }
    if (name === "organization.accounts.switch") {
      writes.push(input);
      return reply;
    }
    throw Error("Unexpected " + name);
  });
  render(
    React.createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 },
          },
        }),
      },
      React.createElement(SwitchAccountPanel, {
        theme,
        layout: { compact: false },
        host: { id: "h", label: "h" },
        context: "agent",
        workspaceId: "w",
        agentId: "agent-1",
      }),
    ),
  );
  return writes;
}
test("the Switch account… menu lists the session’s provider’s accounts with their state; a limited one is shown limited and cannot be chosen", async () => {
  setupPanel();
  assert.ok(await screen.findByText("Claude accounts for this session"));
  assert.ok(screen.getByText("Work"));
  assert.ok(screen.getByText("Personal"));
  assert.ok(screen.getByText("Spare"));
  assert.ok(screen.getByText("In use"));
  assert.ok(screen.getByText("Default for new sessions"));
  assert.match(
    screen.getByTestId("switch-account-status-11111111-1111-4111-8111-000000000003").textContent,
    /^Limited until/,
  );
  assert.equal(screen.getByRole("button", { name: "Use Spare for this session" }).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Use Work for this session" }).disabled, true); // already in use
});
test("choosing an account switches only this session and says what happened", async () => {
  const writes = setupPanel();
  fireEvent.click(await screen.findByRole("button", { name: "Use Personal for this session" }));
  await waitFor(() => assert.deepEqual(writes, [{ agentId: "agent-1", account: B }]));
  assert.ok(await screen.findByText("Continued on Personal with its history."));
});
test("a session with no account pool says so plainly", async () => {
  setupPanel(session({ provider: null, current: null, accounts: [] }));
  assert.ok(
    await screen.findByText(
      "This session’s provider has no account pool. Add accounts in Settings › Accounts & models.",
    ),
  );
});
test('registration: "Switch account…" in the session menu, and /account lists (opens the menu) or switches by name', async () => {
  const got = { panels: [], items: [], slash: [] },
    opened = [],
    rpcs = [];
  const client = {
    addWorkspacePanel: (p) => {
      got.panels.push(p);
      return () => {};
    },
    addCommandCenterItem: (c) => {
      got.items.push(c);
      return () => {};
    },
    addSlashCommand: (c) => {
      got.slash.push(c);
      return () => {};
    },
  };
  const dispose = registerAccountSwitch(client);
  assert.deepEqual(
    got.panels.map((p) => [p.id, p.title, p.context]),
    [[SWITCH_PANEL, "Switch account…", "agent"]],
  );
  assert.deepEqual(
    got.items.map((c) => [c.title, c.context]),
    [["Switch account…", "agent"]],
  );
  assert.deepEqual(
    got.slash.map((c) => [c.name, c.context]),
    [["account", "agent"]],
  );
  const ctx = (args) => ({
    args,
    agent: { id: "agent-1", provider: "claude" },
    openPanel: (id, o) => opened.push([id, o ?? null]),
    rpc: async (contract, input) => {
      rpcs.push([contract.name, input]);
      return { ok: false, message: "Spare is limited until 2026-10-01T05:00:00.000Z." };
    },
  });
  got.items[0].onSelect(ctx(""));
  await got.slash[0].onSubmit(ctx("  "));
  await got.slash[0].onSubmit(ctx(" list "));
  assert.deepEqual(rpcs, []); // /account alone only lists
  await got.slash[0].onSubmit(ctx(" Spare "));
  assert.deepEqual(rpcs, [
    ["organization.accounts.switch", { agentId: "agent-1", account: "Spare" }],
  ]);
  assert.deepEqual(
    opened.map((x) => x[0]),
    [SWITCH_PANEL, SWITCH_PANEL, SWITCH_PANEL, SWITCH_PANEL],
  );
  // the outcome of a typed switch shows in the menu it opens
  setupPanel();
  assert.ok(await screen.findByText("Spare is limited until 2026-10-01T05:00:00.000Z."));
  dispose();
});
test("a host without slash commands or panels still gets what it supports", () => {
  const items = [];
  const dispose = registerAccountSwitch({
    addCommandCenterItem: (c) => {
      items.push(c);
      return () => {};
    },
  });
  assert.equal(items.length, 0); // no panel to open: the menu item is not offered
  dispose();
});
test("Settings: the default account for new sessions, per provider", async () => {
  const writes = setup(view({ defaultAccounts: { claude: B, codex: null } }));
  const row = await screen.findByTestId("default-account-claude");
  assert.match(row.textContent, /New Claude sessions use/);
  assert.equal(
    screen
      .getByRole("button", { name: "New Claude sessions use Personal" })
      .getAttribute("aria-selected"),
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "New Claude sessions use Work" }));
  await waitFor(() =>
    assert.deepEqual(writes.at(-1), {
      name: "organization.accounts.settings",
      input: { defaultAccount: { provider: "claude", id: A } },
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "New Claude sessions use the first ready account" }),
  );
  await waitFor(() =>
    assert.deepEqual(writes.at(-1), {
      name: "organization.accounts.settings",
      input: { defaultAccount: { provider: "claude", id: null } },
    }),
  );
});

// ---- COORD hazard: a Fulcra-initiated switch is never human input and never revokes a delegation. The controller counts
// a session's human activity from prompts sent to it (the provider's input sequence); so no step of a switch -- the menu,
// /account (the composer intercepts plugin slash commands before anything is sent), the server handler -- may send,
// run or answer anything in the session, and the only controller call is the injected takeover seam (W2's, fenced).
const { createAccountHandlers } = await import("../server/accounts-rpc");
const pool = await import("../server/accounts.mjs");
const nodeFs = await import("node:fs"),
  nodeOs = await import("node:os"),
  nodePath = await import("node:path");
// Account RPCs run inside the host's management invocation; these older tests act as this Mac's owner.
const { withManagementInvocation: withOwnerInvocation } =
  await import("../server/management-context.mjs");
const asOwner = (run) =>
  withOwnerInvocation(
    {
      management: {
        invoke: async () => ({}),
        principal: {
          id: "owner",
          authentication: "daemon-password",
          permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
        },
        accountsManage: true,
        recordAccountAction: async () => ({ recorded: false }),
      },
    },
    false,
    run,
  );
function spyAgent(input) {
  const touch =
    (name) =>
    (...args) => {
      input.push([name, ...args]);
      return Promise.resolve();
    };
  return {
    refresh: async () => null,
    current: () => ({ provider: "claude" }),
    send: touch("send"),
    run: touch("run"),
    respondToPermission: touch("respondToPermission"),
    refreshMcp: touch("refreshMcp"),
  };
}
test("hazard: /account and the menu never send input to the session", async () => {
  const input = [],
    opened = [],
    rpcs = [],
    slash = [];
  registerAccountSwitch({
    addWorkspacePanel: () => () => {},
    addCommandCenterItem: () => () => {},
    addSlashCommand: (c) => {
      slash.push(c);
      return () => {};
    },
  });
  const ctx = (args) => ({
    args,
    agent: { id: "agent-1", provider: "claude" },
    paseo: { agents: { ref: () => spyAgent(input) } },
    openPanel: (id) => opened.push(id),
    rpc: async (c, i) => {
      rpcs.push(c.name);
      return { ok: true, message: null };
    },
  });
  await slash[0].onSubmit(ctx(""));
  await slash[0].onSubmit(ctx("Personal"));
  assert.deepEqual(input, []);
  assert.deepEqual(rpcs, ["organization.accounts.switch"]);
});
test("hazard: the server switch reads the session, never writes to it, and reaches the controller only through the takeover seam", async () => {
  const root = nodeFs.realpathSync(
    nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "fulcra-w1-hazard-")),
  );
  await pool.addAccount(
    root,
    { provider: "claude", name: "Work" },
    Date.parse("2026-10-01T00:00:00Z"),
  );
  const b = await pool.addAccount(
    root,
    { provider: "claude", name: "Personal" },
    Date.parse("2026-10-01T00:00:01Z"),
  );
  await pool.assign(root, "agent-1", "claude", Date.parse("2026-10-01T00:00:02Z"));
  const input = [],
    seam = [];
  const handlers = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    keychain: { get: async () => null, put: async () => {}, remove: async () => {} },
    now: () => Date.parse("2026-10-01T00:01:00Z"),
    takeOver: async (id, account) => {
      seam.push([id, account.id]);
      return { ok: true, message: null };
    },
  });
  const paseo = { agents: { ref: () => spyAgent(input) } };
  const r = await asOwner(() =>
    handlers.switch({ agentId: "agent-1", account: "Personal" }, paseo),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(seam, [["agent-1", b.id]]); // one call, the fenced seam
  assert.deepEqual(input, []); // nothing typed, run or answered in the session
  await asOwner(() => handlers.session({ agentId: "agent-1" }, paseo));
  assert.deepEqual(input, []);
});

// ---- the controller path (COORD decision): takeOver = localCall("session-takeover", { session, accountId })
const { controllerTakeOver } = await import("../server/accounts-rpc");
test("integration: switch -> the controller takeover is called with the session, account id and reason; a refusal leaves the session on its old account", async () => {
  const root = nodeFs.realpathSync(
    nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "fulcra-w1-takeover-")),
  );
  const a = await pool.addAccount(
    root,
    { provider: "claude", name: "Work" },
    Date.parse("2026-10-01T00:00:00Z"),
  );
  const b = await pool.addAccount(
    root,
    { provider: "claude", name: "Personal" },
    Date.parse("2026-10-01T00:00:01Z"),
  );
  await pool.assign(root, "agent-1", "claude", Date.parse("2026-10-01T00:00:02Z"));
  const records = () => pool.readAccounts(root).rotations.length,
    n = records();
  const ipc = [];
  let reply = {
    ok: false,
    outcome: "refused",
    message: "A turn is running in this session. Stop it, then switch.",
  };
  const call = async (method, input) => {
    ipc.push([method, input]);
    return reply;
  };
  const handlers = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    now: () => Date.parse("2026-10-01T00:01:00Z"),
    takeOver: controllerTakeOver(call),
  });
  const paseo = { agents: { ref: () => spyAgent([]) } };
  const no = await asOwner(() =>
    handlers.switch({ agentId: "agent-1", account: "Personal" }, paseo),
  );
  assert.deepEqual(ipc, [
    ["session-takeover", { session: "agent-1", accountId: b.id, reason: "manual" }],
  ]);
  assert.deepEqual(no, {
    ok: false,
    message: "A turn is running in this session. Stop it, then switch.",
  });
  assert.equal(pool.accountOf(pool.readAccounts(root), "agent-1").id, a.id); // still on Work
  assert.equal(records(), n); // no record of a move that did not happen
  reply = { ok: true, outcome: "continued", message: "Continued on Personal with its history." };
  const yes = await asOwner(() =>
    handlers.switch({ agentId: "agent-1", account: "Personal" }, paseo),
  );
  assert.deepEqual(yes, { ok: true, message: "Continued on Personal with its history." });
  assert.equal(pool.accountOf(pool.readAccounts(root), "agent-1").id, a.id); // the controller owns the write, not the plugin
  assert.equal(records(), n);
  reply = undefined; // a controller without the command
  const gone = await asOwner(() =>
    handlers.switch({ agentId: "agent-1", account: "Personal" }, paseo),
  );
  assert.deepEqual(gone, {
    ok: false,
    message: "The session could not switch to Personal. It stays on Work.",
  });
  const ipcError = await asOwner(() =>
    createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      takeOver: controllerTakeOver(async () => {
        throw Error("Unknown method session-takeover at /path/to/private-control");
      }),
    }).switch({ agentId: "agent-1", account: "Personal" }, paseo),
  );
  assert.deepEqual(ipcError, {
    ok: false,
    message: "The session could not switch to Personal. It stays on Work.",
  });
  assert.equal(pool.accountOf(pool.readAccounts(root), "agent-1").id, a.id);
});

// R1 re-check 3: a manual move is W2's one pool row (reason "manual", keyed by its switchId); Recent moves labels it.
test("Recent moves labels the owner’s own switch, and leaves a usage-limit move unlabelled", async () => {
  setup(
    view({
      rotations: [
        {
          at: "2026-10-01T01:00:00.000Z",
          session: "s1",
          provider: "claude",
          from: "Work",
          to: "Personal",
          resetAt: "2026-10-01T05:00:00.000Z",
          earliestReset: null,
        },
        {
          at: "2026-10-01T02:00:00.000Z",
          session: "s2",
          provider: "claude",
          from: "Personal",
          to: "Work",
          resetAt: null,
          earliestReset: null,
          reason: "manual",
        },
      ],
    }),
  );
  const line = (await screen.findByText(/^Recent moves:/)).textContent;
  assert.match(line, /\(your switch\) from Personal to Work/);
  assert.match(line, /[0-9] from Work to Personal/);
  assert.equal((line.match(/your switch/g) ?? []).length, 1);
});

// ---- U7 accounts.manage (W1-REMOTE-ACCOUNTS, control side): the plugin's account RPCs run inside the host's
// management invocation; only the host's `accountsManage` lets a remote device manage accounts.
const { withManagementInvocation } = await import("../server/management-context.mjs");
const OWNER = {
  id: "owner",
  authentication: "daemon-password",
  permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
};
const DEVICE = (extra = []) => ({
  id: "iphone",
  authentication: "paired-device",
  deviceId: "dev_ABCDEFGHIJKLMNOP",
  permissions: ["command-centre.manage", "daemon.manage", ...extra],
});
const TOKEN = "sk-ant-oat01-" + "R".repeat(60);
async function remoteWorld() {
  const root = nodeFs.realpathSync(
    nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "fulcra-w1-remote-")),
  );
  const work = await pool.addAccount(
    root,
    { provider: "claude", name: "Work" },
    Date.parse("2026-10-01T00:00:00Z"),
  );
  const personal = await pool.addAccount(
    root,
    { provider: "claude", name: "Personal" },
    Date.parse("2026-10-01T00:00:01Z"),
  );
  await pool.assign(root, "agent-1", "claude", Date.parse("2026-10-01T00:00:02Z"));
  const kept = new Map(),
    audit = [],
    events = [];
  // A stand-in for the host Keychain item with the real put's shape check (accounts.mjs createKeychain); no `security` runs.
  const keychain = {
    put: async (id, t) => {
      if (!/^[A-Za-z0-9._~+/=-]{20,1024}$/.test(t ?? ""))
        throw Error("That does not look like a token from `claude setup-token`");
      kept.set(id, t);
    },
    get: async (id) => kept.get(id) ?? null,
    remove: async (id) => {
      kept.delete(id);
    },
  };
  const handlers = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    keychain,
    host: () => "Mac mini",
    now: () => Date.parse("2026-10-01T00:01:00Z"),
    takeOver: async (id, account) => {
      events.push(["takeover", id, account]);
      return { ok: true, message: `Continued on account "${account.name}"` };
    },
  });
  const paseo = { agents: { ref: () => spyAgent([]) } };
  const ctx = (m) => ({
    management: {
      invoke: async () => {
        throw Error("no controller in this test");
      },
      ...m,
    },
  });
  const as = (m, run) => withManagementInvocation(ctx(m), false, run);
  const record = (entry) => {
    audit.push(entry);
    return Promise.resolve({ recorded: true });
  };
  const granted = {
    principal: DEVICE(["accounts.manage"]),
    accountsManage: true,
    recordAccountAction: record,
  };
  return {
    root,
    work,
    personal,
    kept,
    audit,
    events,
    handlers,
    paseo,
    as,
    granted,
    record,
    account: () => pool.accountOf(pool.readAccounts(root), "agent-1")?.name,
  };
}
test("paired device with a legacy grant cannot administer accounts or switch without a view", async () => {
  const w = await remoteWorld();
  for (const run of [
    () => w.handlers.add({ provider: "claude", name: "Third", token: TOKEN }),
    () => w.handlers.update({ id: w.work.id, remove: true }),
    () => w.handlers.update({ id: w.work.id, token: TOKEN }),
    () => w.handlers.settings({ policy: "spread" }),
    () => w.handlers.settings({ defaultAccount: { provider: "claude", id: w.personal.id } }),
    () => w.handlers.takeover({ agentId: "agent-1", account: "Personal" }, w.paseo),
    () => w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
  ])
    assert.equal((await w.as(w.granted, run)).ok, false);
  await assert.rejects(() => w.as(w.granted, () => w.handlers.read(null)));
  assert.deepEqual(w.events, []);
  assert.deepEqual(w.audit, []);
  assert.equal(w.kept.size, 0);
  assert.equal(pool.readAccounts(w.root).accounts.length, 2);
});

test("normal phone lists and switches its bound session without credentials or pool settings", async () => {
  const w = await remoteWorld();
  const phone = {
    principal: { ...DEVICE(), accountSessionId: "agent-1" },
    recordAccountAction: w.record,
  };
  const view = await w.as(phone, () => w.handlers.session({ agentId: "agent-1" }, w.paseo));
  assert.deepEqual(view.accounts.map(Object.keys), [
    ["id", "name", "status"],
    ["id", "name", "status"],
  ]);
  assert.equal(
    (
      await w.as(phone, () =>
        w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
      )
    ).ok,
    true,
  );
  assert.deepEqual(w.audit, [], "the host owns scoped switch audits");
  assert.equal(
    (await w.as(phone, () => w.handlers.switch({ agentId: "other", account: "Personal" }, w.paseo)))
      .ok,
    false,
  );
  assert.equal(
    (
      await w.as({ ...phone, readOnly: true }, () =>
        w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
      )
    ).ok,
    false,
  );
  assert.equal(JSON.stringify([view, w.audit, w.events]).includes(TOKEN), false);
});

test("local owner keeps account administration and explicit continuation", async () => {
  const w = await remoteWorld();
  const owner = { principal: OWNER, accountsManage: true };
  assert.equal(
    (await w.as(owner, () => w.handlers.add({ provider: "claude", name: "Third", token: TOKEN })))
      .ok,
    true,
  );
  assert.equal((await w.as(owner, () => w.handlers.settings({ policy: "spread" }))).ok, true);
  assert.equal(
    (
      await w.as(owner, () =>
        w.handlers.takeover({ agentId: "agent-1", account: "Personal" }, w.paseo),
      )
    ).ok,
    true,
  );
  assert.equal((await w.as(owner, () => w.handlers.read(null))).accounts.length, 3);
  assert.deepEqual(w.audit, []);
});
