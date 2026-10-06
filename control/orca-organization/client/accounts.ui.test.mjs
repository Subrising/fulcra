import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountsSurface } from "./accounts";
import contribute from "../index.client";
import { SwitchAccountPanel, registerAccountSwitch, SWITCH_PANEL } from "./switch-account";
import { setHandler, setPaseo, calls } from "./ui-test-adapters.mjs";
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
  fireEvent.click(screen.getByRole("button", { name: "Prime and project leads model Sonnet 5.5" }));
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
      "This session’s provider has no account pool. Add accounts in Settings › Accounts & Defaults.",
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
    message: "The session could not continue on Personal. It stays on Work.",
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
    message: "The session could not continue on Personal. It stays on Work.",
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
const ASK = "Ask the owner to allow account management for this device on Mac mini";
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
test("accounts-manage: device WITH capability can switch / set default / take over", async () => {
  const w = await remoteWorld();
  assert.equal(
    (
      await w.as(w.granted, () =>
        w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
      )
    ).ok,
    true,
  );
  assert.deepEqual(
    w.events.map((e) => [e[0], e[2].name]),
    [["takeover", "Personal"]],
  );
  assert.equal(
    (
      await w.as(w.granted, () =>
        w.handlers.settings({ defaultAccount: { provider: "claude", id: w.personal.id } }),
      )
    ).ok,
    true,
  );
  assert.equal(pool.readAccounts(w.root).defaults.claude, w.personal.id);
  const view = await w.as(w.granted, () => w.handlers.read(null));
  assert.deepEqual(
    view.accounts.map((a) => a.name),
    ["Work", "Personal"],
  );
  assert.equal(
    (await w.as(w.granted, () => w.handlers.session({ agentId: "agent-1" }, w.paseo))).accounts
      .length,
    2,
  );
});
test("accounts-manage: same device after revoke is refused", async () => {
  const w = await remoteWorld();
  assert.equal(
    (
      await w.as(w.granted, () =>
        w.handlers.settings({ defaultAccount: { provider: "claude", id: w.work.id } }),
      )
    ).ok,
    true,
  );
  const revoked = { principal: DEVICE(), recordAccountAction: w.record }; // the owner revoked: the host no longer sets accountsManage
  assert.deepEqual(
    await w.as(revoked, () =>
      w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
    ),
    { ok: false, message: ASK },
  );
  assert.deepEqual(
    await w.as(revoked, () =>
      w.handlers.settings({ defaultAccount: { provider: "claude", id: w.personal.id } }),
    ),
    { ok: false, message: ASK },
  );
  await assert.rejects(() => w.as(revoked, () => w.handlers.read(null)), new RegExp(ASK));
  assert.equal(pool.readAccounts(w.root).defaults.claude, w.work.id);
  assert.equal(w.account(), "Work");
  assert.equal(w.events.length, 0);
});
test("accounts-manage: read-tier (D13) device is refused", async () => {
  const w = await remoteWorld(),
    readTier = {
      principal: { ...DEVICE(), permissions: ["daemon.read", "workspace.read"] },
      readOnly: true,
      recordAccountAction: w.record,
    };
  assert.deepEqual(
    await w.as(readTier, () =>
      w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
    ),
    { ok: false, message: ASK },
  );
  await assert.rejects(() => w.as(readTier, () => w.handlers.read(null)), new RegExp(ASK));
  await assert.rejects(
    () => w.as(readTier, () => w.handlers.session({ agentId: "agent-1" }, w.paseo)),
    new RegExp(ASK),
  );
  // Even a host that wrongly set both flags is refused: the read tier wins.
  assert.deepEqual(
    await w.as({ ...readTier, accountsManage: true }, () =>
      w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
    ),
    { ok: false, message: ASK },
  );
  assert.equal(w.account(), "Work");
});
test("accounts-manage: full-management device WITHOUT capability is refused", async () => {
  const w = await remoteWorld(),
    full = { principal: DEVICE(), recordAccountAction: w.record };
  for (const run of [
    () => w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
    () => w.handlers.settings({ policy: "spread" }),
    () => w.handlers.add({ provider: "claude", name: "Third", token: TOKEN }),
    () => w.handlers.update({ id: w.work.id, remove: true }),
  ])
    assert.deepEqual(await w.as(full, run), { ok: false, message: ASK });
  assert.equal(pool.readAccounts(w.root).accounts.length, 2);
  assert.equal(pool.readAccounts(w.root).policy, "priority");
  assert.equal(w.kept.size, 0);
});
test("accounts-manage: local owner still works", async () => {
  const w = await remoteWorld(),
    calls = [];
  const owner = {
    principal: OWNER,
    accountsManage: true,
    recordAccountAction: (e) => {
      calls.push(e);
      return Promise.resolve({ recorded: false });
    },
  };
  assert.equal(
    (
      await w.as(owner, () =>
        w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo),
      )
    ).ok,
    true,
  );
  assert.equal((await w.as(owner, () => w.handlers.settings({ policy: "spread" }))).ok, true);
  assert.deepEqual(calls, [], "the owner’s own actions are not remote actions");
  // A host that predates accounts.manage: its local owner keeps the old behaviour; a device there gets nothing.
  assert.equal(
    (await w.as({ principal: OWNER }, () => w.handlers.settings({ policy: "priority" }))).ok,
    true,
  );
  assert.deepEqual(
    await w.as({ principal: DEVICE(["accounts.manage"]) }, () =>
      w.handlers.settings({ policy: "spread" }),
    ),
    { ok: false, message: ASK },
  );
});
test("accounts-manage: every remote action is audited (device, action, label, time)", async () => {
  const w = await remoteWorld();
  const run = (f) => w.as(w.granted, f);
  await run(() => w.handlers.switch({ agentId: "agent-1", account: "Personal" }, w.paseo));
  await run(() => w.handlers.settings({ defaultAccount: { provider: "claude", id: w.work.id } }));
  await run(() => w.handlers.settings({ defaultAccount: { provider: "claude", id: null } }));
  await run(() => w.handlers.settings({ policy: "spread" }));
  await run(() => w.handlers.add({ provider: "claude", name: "Third", token: TOKEN }));
  await run(() => w.handlers.update({ id: w.work.id, name: "Office" }));
  await run(() => w.handlers.update({ id: w.personal.id, remove: true }));
  assert.deepEqual(w.audit, [
    { action: "switch", accountLabel: "Personal" },
    { action: "set-default", accountLabel: "Work" },
    { action: "set-default", accountLabel: "First ready account" },
    { action: "pool-settings", accountLabel: "Spread evenly" },
    { action: "add", accountLabel: "Third" },
    { action: "update", accountLabel: "Office" },
    { action: "remove", accountLabel: "Personal" },
  ]);
  // The device and the time are the host's to add (W4's audit store); the plugin sends only the action and the label.
  assert.ok(w.audit.every((e) => Object.keys(e).sort().join() === "accountLabel,action"));
  // A refused action is not audited as done.
  await run(() => w.handlers.switch({ agentId: "agent-1", account: "Nobody" }, w.paseo));
  assert.equal(w.audit.length, 7);
});
test("accounts-manage: remote add passes setup-token write-only to the host keychain item; never echoed/logged/stored on device", async () => {
  const w = await remoteWorld(),
    logged = [],
    orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...x) => logged.push(x.map(String).join(" "));
  try {
    const r = await w.as(w.granted, () =>
      w.handlers.add({ provider: "claude", name: "Third", token: TOKEN }),
    );
    assert.equal(r.ok, true);
    const third = pool.readAccounts(w.root).accounts.find((a) => a.name === "Third");
    assert.equal(
      w.kept.get(third.id),
      TOKEN,
      "the token is in the host keychain item, under the account id",
    );
    const bad = await w.as(w.granted, () =>
      w.handlers.add({ provider: "claude", name: "Fourth", token: "sk-ant-not-a-token" }),
    );
    assert.equal(bad.ok, false);
    for (const [what, text] of [
      ["reply", JSON.stringify(r)],
      ["refusal", JSON.stringify(bad)],
      ["audit", JSON.stringify(w.audit)],
      ["log", logged.join("\n")],
    ])
      assert.equal(text.includes("sk-ant-"), false, what + ": " + text.slice(0, 200));
  } finally {
    Object.assign(console, orig);
  }
});
test("accounts-manage: no credential material in any response or event to a remote client", async () => {
  const w = await remoteWorld(),
    replies = [];
  const run = async (f) => {
    const r = await w.as(w.granted, f);
    replies.push(r);
    return r;
  };
  await run(() => w.handlers.add({ provider: "claude", name: "Third", token: TOKEN }));
  const third = pool.readAccounts(w.root).accounts.find((a) => a.name === "Third");
  await run(() => w.handlers.update({ id: third.id, token: TOKEN }));
  await run(() => w.handlers.switch({ agentId: "agent-1", account: "Third" }, w.paseo));
  await run(() => w.handlers.settings({ defaultAccount: { provider: "claude", id: third.id } }));
  await run(() => w.handlers.read(null));
  await run(() => w.handlers.session({ agentId: "agent-1" }, w.paseo));
  await run(() => w.handlers.add({ provider: "claude", name: TOKEN.slice(0, 50), token: TOKEN })); // a token pasted as a name
  const everything = JSON.stringify([replies, w.audit, w.events]);
  assert.equal(everything.includes(TOKEN), false);
  assert.equal(/sk-ant-|auth\.json|oauth/i.test(everything), false, everything.slice(0, 400));
});
test("accounts-manage: without the capability the Switch account panel says who to ask", async () => {
  setHandler((name) => {
    if (name === "organization.accounts.session") throw Error(ASK);
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
  assert.ok(await screen.findByText(ASK));
});
// 7b fold: Move up / Move down send ONE request naming the move; the server swaps under its lock (never a priority).
test("Move up and Move down send one move request each, never a priority", async () => {
  const writes = setup();
  assert.ok(await screen.findByText("2. Personal"));
  assert.equal(
    screen.queryByRole("button", { name: "Move Work up" }),
    null,
    "the first account has no Move up",
  );
  assert.equal(
    screen.queryByRole("button", { name: "Move Personal down" }),
    null,
    "the last account has no Move down",
  );
  fireEvent.click(screen.getByRole("button", { name: "Move Personal up" }));
  await waitFor(() => assert.equal(writes.length, 1));
  fireEvent.click(screen.getByRole("button", { name: "Move Work down" }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.deepEqual(writes, [
    { name: "organization.accounts.update", input: { id: B, move: "up" } },
    { name: "organization.accounts.update", input: { id: A, move: "down" } },
  ]);
});

// Account audit follows the requested operation, independently of existing conversation history.
test("accounts-manage: a remote switch audits as switch, and explicit account continuation audits as takeover", async () => {
  const w = await remoteWorld();
  await pool.assign(w.root, "chat-1", "claude", Date.parse("2026-10-01T00:00:03Z"));
  const talking = {
    agents: {
      ref: (id) => ({
        refresh: async () => null,
        current: () => ({
          provider: "claude",
          lastUserMessageAt: id === "chat-1" ? "2026-10-01T00:00:30.000Z" : null,
        }),
      }),
    },
  };
  assert.equal(
    (
      await w.as(w.granted, () =>
        w.handlers.switch({ agentId: "agent-1", account: "Personal" }, talking),
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await w.as(w.granted, () =>
        w.handlers.takeover({ agentId: "chat-1", account: "Personal" }, talking),
      )
    ).ok,
    true,
  );
  assert.deepEqual(w.audit, [
    { action: "switch", accountLabel: "Personal" },
    { action: "takeover", accountLabel: "Personal" },
  ]);
  // Without the seam (no continuation) a move is a switch whatever the session holds.
  const plainHandlers = createAccountHandlers({
    root: () => w.root,
    configRoles: () => null,
    host: () => "Mac mini",
  });
  // (The stand-in seam above does not move the pool, so chat-1 is still on Work.)
  assert.equal(
    (
      await w.as(w.granted, () =>
        plainHandlers.switch({ agentId: "chat-1", account: "Personal" }, talking),
      )
    ).ok,
    true,
  );
  assert.deepEqual(w.audit.at(-1), { action: "switch", accountLabel: "Personal" });
});

// update-7c: the rundown of every pooled account's usage, from the host (provider.usage.list with accounts). Names and
// figures only; a host that cannot list it shows no rundown and the rest of the page is unchanged.
const usageRow = (over = {}) => ({
  accountId: A,
  name: "Work",
  provider: "claude",
  status: "ok",
  observedAt: new Date(Date.now() - 120000).toISOString(),
  source: "session",
  fiveHour: { usedPct: 40, resetsAt: new Date(Date.now() + 3 * 3600000).toISOString() },
  weekly: { usedPct: 61, resetsAt: new Date(Date.now() + 4 * 86400000).toISOString() },
  inUse: true,
  ...over,
});
test("the rundown lists every account with 5h and weekly use, resets and status; refresh asks the host once, on demand", async () => {
  const asked = [];
  setPaseo({
    providers: {
      listUsage: async (o) => {
        asked.push(o);
        return {
          requestId: "r",
          fetchedAt: new Date().toISOString(),
          providers: [],
          accounts: [
            usageRow(),
            usageRow({
              accountId: B,
              name: "Personal",
              status: "limited",
              fiveHour: { usedPct: 100, resetsAt: new Date(Date.now() + 3600000).toISOString() },
              weekly: { usedPct: 97, resetsAt: null },
              inUse: false,
            }),
            usageRow({
              accountId: null,
              name: "Codex A",
              provider: "codex",
              status: "unavailable",
              fiveHour: null,
              weekly: null,
              observedAt: null,
              inUse: false,
            }),
          ],
        };
      },
    },
  });
  setup();
  const box = await screen.findByTestId("account-usage-rundown");
  await waitFor(() => assert.match(box.textContent, /Work/));
  assert.match(box.textContent, /5h 40%/);
  assert.match(box.textContent, /Weekly 61%/);
  assert.match(box.textContent, /Personal.*Limited/s);
  assert.match(box.textContent, /Codex A.*Usage unavailable/s);
  assert.deepEqual(asked, [{ accounts: true }]);
  fireEvent.click(screen.getByLabelText("Refresh account usage"));
  await waitFor(() => assert.deepEqual(asked.at(-1), { accounts: true, refresh: true }));
  assert.doesNotMatch(document.body.textContent, /sk-ant|sha256/);
  setPaseo(null);
});
test("a host that cannot list usage shows no rundown and does not break the page", async () => {
  setPaseo({});
  setup();
  assert.ok(await screen.findByText("1. Work"));
  assert.equal(screen.queryByTestId("account-usage-rundown"), null);
  setPaseo(null);
});

test("the account rundown keeps refresh failure visible and permits a retry", async () => {
  let fail = true;
  setPaseo({
    providers: {
      listUsage: async (options) => {
        if (options.refresh && fail) throw new Error("synthetic transport failure");
        return { accounts: [usageRow()] };
      },
    },
  });
  setup();
  await screen.findByTestId("account-usage-rundown");
  await waitFor(() =>
    assert.match(screen.getByTestId("account-usage-rundown").textContent, /Work/),
  );
  fireEvent.click(screen.getByLabelText("Refresh account usage"));
  await screen.findByText("Unable to load account usage. Try Refresh again.");
  fail = false;
  fireEvent.click(screen.getByLabelText("Refresh account usage"));
  await waitFor(() =>
    assert.equal(
      screen.queryByText("Unable to load account usage. Try Refresh again.") === null,
      true,
    ),
  );
  setPaseo(null);
});

test("Settings Accounts route retains registered host, saves defaults and reopens without credential input", async () => {
  let registered,
    current = view({
      rotations: [],
      accounts: [
        {
          id: A,
          provider: "claude",
          name: "Work",
          enabled: true,
          priority: 1,
          status: { state: "ok" },
          limitNote: null,
          sessions: [],
          lastUsedAt: null,
        },
      ],
    });
  const writes = [],
    usageReads = [];
  const dispose = contribute({
    addSurface: (_id, component) => {
      registered = component;
      return () => {};
    },
    addSidebarItem: () => () => {},
    addCommandCenterItem: () => () => {},
    openSurface() {},
  });
  setHandler((name, input) => {
    if (name === "organization.accounts") return current;
    if (name === "organization.accounts.settings") {
      writes.push(input);
      current = {
        ...current,
        defaultAccounts: {
          ...current.defaultAccounts,
          [input.defaultAccount.provider]: input.defaultAccount.id,
        },
      };
      return { ok: true, message: "Saved." };
    }
    return Promise.reject(new Error("Synthetic unrelated view unavailable"));
  });
  setPaseo({
    providers: {
      listUsage: async (input) => {
        usageReads.push(input);
        return {
          accounts: [
            {
              accountId: A,
              name: "Work",
              provider: "claude",
              status: "ok",
              observedAt: null,
              fiveHour: null,
              weekly: null,
              inUse: false,
            },
          ],
        };
      },
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  try {
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(registered, {
          theme,
          layout: { compact: false, platform: "web" },
          host: { id: "settings-host", label: "Settings host" },
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("organization-tab-settings"));
    fireEvent.click(screen.getByRole("button", { name: "Accounts & Defaults" }));
    await screen.findByTestId("accounts-settings");
    assert.ok(await screen.findByText("1. Work"));
    assert.ok(screen.getByText(/^0 sessions using it now/));
    await screen.findByTestId("account-usage-rundown");
    await waitFor(() =>
      assert.ok(client.getQueryData(["orca-organization", "account-usage", "settings-host"])),
    );
    assert.equal(client.getQueryData(["orca-organization", "account-usage", undefined]), undefined);
    fireEvent.click(screen.getByRole("button", { name: "New Claude sessions use Work" }));
    await waitFor(() =>
      assert.deepEqual(writes, [{ defaultAccount: { provider: "claude", id: A } }]),
    );
    await screen.findByText("Saved.");
    fireEvent.click(screen.getByTestId("organization-tab-today"));
    assert.equal(screen.queryByTestId("accounts-settings"), null);
    fireEvent.click(screen.getByTestId("organization-tab-settings"));
    assert.ok(await screen.findByTestId("accounts-settings"));
    await waitFor(() =>
      assert.equal(
        screen
          .getByRole("button", { name: "New Claude sessions use Work" })
          .getAttribute("aria-selected"),
        "true",
      ),
    );
    assert.ok(usageReads.every((input) => input.accounts === true));
    assert.ok(writes.every((input) => !Object.hasOwn(input, "token")));
    assert.equal(screen.getByLabelText("Claude account token").value, "");
  } finally {
    cleanup();
    client.clear();
    setPaseo(null);
    dispose();
  }
});
