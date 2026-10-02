// Fulcra J4: Trackers and Settings › Integrations screenshots, in both host states (the shared sign-in store
// available, and a host without update P1), dark and light, at 1280×800 and 390×844. Same method as
// verify-inbox-screens.mjs: the real client files are bundled with react-native mapped to react-native-web,
// fed seeded data through the useRpc seam, and rendered in headless Chromium with the host's default theme
// values. External tooling is supplied explicitly; nothing is installed and no live UI or controller is touched.
// Usage: node verify-tracker-screens.mjs <absolute tooling dir with react-native-web, react-dom, playwright, zod, @tanstack/react-query, esbuild> [state]
// J4b adds the `atlassian` state: the Jira and Bitbucket rows (Cloud and Data Center) with their token forms, and an
// account whose Disconnect was not confirmed ("Couldn't remove; retry"). A state name renders only that state.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { noPersonal } from "./shared/cc/refs.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const tooling = process.argv[2];
if (!tooling || !path.isAbsolute(tooling))
  throw Error("Supply absolute external UI tooling directory");
const ui = createRequire(path.join(tooling, "package.json")),
  pkg = (name) => path.dirname(ui.resolve(`${name}/package.json`));
const out = path.join(root, "..", "..", "local", "screens", "trackers"),
  work = path.join(root, "runtime", "tracker-screens");
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const THEMES = {
  dark: {
    surface0: "#181B1A",
    surface1: "#1E2120",
    surface2: "#272A29",
    border: "#252B2A",
    foreground: "#fafafa",
    foregroundMuted: "#A1A5A4",
    accent: "#20744A",
    accentForeground: "#ffffff",
    statusSuccess: "#6cb17b",
    statusWarning: "#c09664",
    statusDanger: "#d8847b",
  },
  light: {
    surface0: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    border: "#e4e4e7",
    foreground: "#1a1a1e",
    foregroundMuted: "#71717a",
    accent: "#20744A",
    accentForeground: "#ffffff",
    statusSuccess: "#3e704a",
    statusWarning: "#7b5d39",
    statusDanger: "#9d433b",
  },
};
// Seeded, plain-language, personal-data free. Repositories and accounts are obviously fake.
const now = Date.now(),
  iso = (ms) => new Date(ms).toISOString();
const P1 = "6a1e0c52-3f1c-4d2e-9a61-5c8d2e7f1a01",
  P2 = "6a1e0c52-3f1c-4d2e-9a61-5c8d2e7f1a02",
  T1 = "7b2f1d63-4a2d-4e3f-8b72-6d9e3f8a2b01";
const S1 = "8c3a2e74-5b3e-4f4a-9c83-7eaf4a9b3c01",
  M1 = "9d4b3f85-6c4f-4a5b-8d94-8fb05bac4d01",
  M2 = "9d4b3f85-6c4f-4a5b-8d94-8fb05bac4d02";
const A1 = "ae5c4a96-7d5a-4b6c-9ea5-9ac16cbd5e01",
  A2 = "ae5c4a96-7d5a-4b6c-9ea5-9ac16cbd5e02";
const merged = iso(now - 50 * 60000);
const item = (ref, kind, title, state, updatedAt, labels = []) => ({
  key: kind === "pr" ? `pr:github:acme/app#${ref}` : `issue:github:123456:${ref}`,
  connector: "github",
  kind,
  ref: `#${ref}`,
  title,
  state,
  url: `https://github.com/acme/app/${kind === "pr" ? "pull" : "issues"}/${ref}`,
  updatedAt,
  assignee: null,
  labels,
});
const link = (id, from, to, provenance, confidence, evidence) => ({
  id,
  from,
  to,
  relation: from.startsWith("pr:") && to.startsWith("issue:") ? "fixes" : "worked-by",
  provenance,
  confidence,
  evidence,
  state: "active",
  revision: 1,
  createdAt: iso(now - 3600000),
  by: "system:provenance",
});
const L1 = link(
  "b0000000-0000-4000-8000-000000000001",
  "pr:github:acme/app#17",
  "issue:github:123456:42",
  "reported",
  "high",
  "The pull request says it fixes this issue.",
);
const L2 = link(
  "b0000000-0000-4000-8000-000000000002",
  "pr:github:acme/app#17",
  `session:${S1}`,
  "inferred",
  "high",
  "Commits in this pull request were made by this session.",
);
const L3 = link(
  "b0000000-0000-4000-8000-000000000003",
  "issue:github:123456:45",
  `task:${T1}`,
  "inferred",
  "medium",
  "A commit by this task mentions the issue.",
);
const step = (kind, label, extra = {}) => ({
  kind,
  ref: null,
  label,
  at: null,
  provenance: null,
  confidence: null,
  ...extra,
});
const items = [
  {
    item: item(42, "issue", "Sign-in fails after an update", "closed", merged, ["bug"]),
    stale: false,
    observedAt: iso(now - 120000),
    links: [L1],
    trail: [
      step("pr", "fixed in PR #17", { ref: L1.from, provenance: "reported", confidence: "high" }),
      step("session", "by session 'Sign-in fixes'", {
        ref: L2.to,
        provenance: "inferred",
        confidence: "high",
      }),
      step("state", "merged", { at: merged }),
    ],
  },
  {
    item: item(45, "issue", "Add a weekly summary email", "open", iso(now - 7200000), ["feature"]),
    stale: false,
    observedAt: iso(now - 120000),
    links: [L3],
    trail: [
      step("task", "worked on by task 'Weekly summaries'", {
        ref: L3.to,
        provenance: "inferred",
        confidence: "medium",
      }),
    ],
  },
  {
    item: item(40, "issue", "Old crash on start", "closed", iso(now - 4 * 86400000)),
    stale: false,
    observedAt: iso(now - 120000),
    links: [],
    trail: [],
  },
  {
    item: item(17, "pr", "Fix sign-in after an update", "merged", merged),
    stale: false,
    observedAt: iso(now - 120000),
    links: [L1, L2],
    trail: [
      step("session", "by session 'Sign-in fixes'", {
        ref: L2.to,
        provenance: "inferred",
        confidence: "high",
      }),
      step("state", "merged", { at: merged }),
    ],
  },
  {
    item: item(18, "pr", "Add the reports page", "open", iso(now - 3 * 3600000)),
    stale: false,
    observedAt: iso(now - 120000),
    links: [],
    trail: [],
  },
];
const mapping = (id, name, accountId) => ({
  id,
  revision: 1,
  projectId: P1,
  connector: "github",
  accountId,
  remoteId: id === M1 ? "123456" : "777",
  remoteName: name,
  site: null,
  state: "mapped",
  note: "",
  at: iso(now - 86400000),
});
const github = {
  id: "github",
  label: "GitHub",
  kinds: ["issue", "pr"],
  selfHosted: false,
  keyPatterns: ["#[1-9][0-9]{0,9}"],
  sync: { pollSeconds: 60, webhook: false },
  tokenHelp: {
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    scopes: [
      "Repository access: only the repositories you track",
      "Metadata: Read-only",
      "Issues: Read-only",
      "Pull requests: Read-only",
    ],
    note: "Create a fine-grained token that can only read. Fulcra never writes to GitHub.",
  },
};
const account = (id, displayName, state, connector = "github", site = null) => ({
  version: 1,
  id,
  connector,
  site,
  displayName,
  method: "token",
  scopes: ["repo"],
  state,
  expiresAt: null,
  lastCheckedAt: iso(now - 600000),
  createdAt: iso(now - 9 * 86400000),
});
const directory = {
  available: true,
  partial: false,
  note: "",
  projects: [
    { id: P1, name: "Customer app", mapping: null, tasks: [T1], sessions: [{ id: S1, task: T1 }] },
    { id: P2, name: "Website", mapping: null, tasks: [], sessions: [] },
  ],
};
const atl = (id, label, selfHosted, kinds, createUrl, scopes, note) => ({
  id,
  label,
  kinds,
  selfHosted,
  auth: ["token"],
  keyPatterns: ["[A-Z][A-Z0-9]+-\\d+"],
  sync: { pollSeconds: 120, webhook: false },
  tokenHelp: { createUrl, scopes, note },
});
const ATLASSIAN = [
  atl(
    "jira",
    "Jira",
    false,
    ["ticket"],
    "https://id.atlassian.com/manage-profile/security/api-tokens",
    ["read:jira-work", "read:jira-user"],
    "Create an API token (with scopes, choose Jira and these read scopes). Fulcra sends it with the email address of your Atlassian account and never writes to Jira.",
  ),
  atl(
    "jira-dc",
    "Jira Data Center",
    true,
    ["ticket"],
    "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html",
    ["Browse projects (for the projects you track)"],
    "In Jira open your profile, then Personal Access Tokens, and create one. It reads what your Jira user can read. Fulcra never writes to Jira.",
  ),
  atl(
    "bitbucket",
    "Bitbucket",
    false,
    ["issue", "pr"],
    "https://id.atlassian.com/manage-profile/security/api-tokens",
    [
      "read:repository:bitbucket",
      "read:pullrequest:bitbucket",
      "read:issue:bitbucket",
      "read:user:bitbucket",
    ],
    "Create an API token with scopes, choose Bitbucket and these read scopes. Fulcra sends it with the email address of your Atlassian account and never writes to Bitbucket.",
  ),
  atl(
    "bitbucket-dc",
    "Bitbucket Data Center",
    true,
    ["pr"],
    "https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html",
    ["Repository read (REPO_READ)"],
    "In Bitbucket open Manage account, then HTTP access tokens, and create a read-only one. For a personal token also enter your username. Fulcra never writes to Bitbucket.",
  ),
];
const A3 = "ae5c4a96-7d5a-4b6c-9ea5-9ac16cbd5e03",
  A4 = "ae5c4a96-7d5a-4b6c-9ea5-9ac16cbd5e04";
const STATES = {
  available: {
    hostApi: true,
    "organization.trackers.directory": directory,
    "organization.integrations": {
      version: 1,
      observedAt: iso(now),
      partial: false,
      hostApi: true,
      connectors: [{ ...github, auth: ["device", "token", "cli"] }],
      accounts: [
        account(A1, "acme-bot (GitHub)", "connected"),
        account(A2, "acme-ci (GitHub)", "needs-reconnect"),
      ],
    },
    "organization.tracker-mappings": {
      version: 1,
      observedAt: iso(now),
      partial: false,
      mappings: [mapping(M1, "acme/app", A1), mapping(M2, "acme/site", A2)],
      legacy: null,
    },
    "organization.tracker-view": {
      version: 1,
      observedAt: iso(now),
      partial: true,
      items,
      trackers: [
        {
          mappingId: M1,
          connector: "github",
          label: "GitHub",
          remoteName: "acme/app",
          commandLine: false,
          status: "ok",
          retryAt: null,
          observedAt: iso(now - 120000),
        },
        {
          mappingId: M2,
          connector: "github",
          label: "GitHub",
          remoteName: "acme/site",
          commandLine: false,
          status: "auth-required",
          retryAt: null,
          observedAt: iso(now - 86400000),
        },
      ],
    },
  },
  atlassian: {
    hostApi: true,
    screens: ["integrations"],
    open: ["Connect Jira", "Connect Bitbucket Data Center"],
    "organization.integrations": {
      version: 1,
      observedAt: iso(now),
      partial: false,
      hostApi: true,
      connectors: [{ ...github, auth: ["device", "token", "cli"] }, ...ATLASSIAN],
      accounts: [
        account(A1, "acme-bot (GitHub)", "connected"),
        account(A3, "Acme Jira (Jira)", "connected", "jira", "acme.atlassian.net"),
        account(A4, "acme-ci (Bitbucket)", "revoked", "bitbucket"),
      ],
    },
  },
  "needs-p1": {
    hostApi: false,
    "organization.trackers.directory": {
      ...directory,
      projects: directory.projects.map((p) =>
        p.id === P1
          ? {
              ...p,
              mapping: {
                projectId: P1,
                tracker: "github",
                auth: "keychain",
                site: "github.com",
                remoteId: "777",
                remoteName: "acme/site",
                state: "mapped",
                revision: 1,
                validatedAt: iso(now - 86400000),
                note: "",
                at: iso(now - 86400000),
              },
            }
          : p,
      ),
    },
    "organization.integrations": {
      version: 1,
      observedAt: iso(now),
      partial: true,
      hostApi: false,
      connectors: [{ ...github, auth: ["token", "cli"] }],
      accounts: [],
    },
    "organization.tracker-mappings": {
      version: 1,
      observedAt: iso(now),
      partial: false,
      mappings: [mapping(M1, "acme/app", null)],
      legacy: { connector: "github", remoteName: "acme/site", commandLine: false, copied: false },
    },
    "organization.tracker-view": {
      version: 1,
      observedAt: iso(now),
      partial: false,
      items: items.map((i) => ({ ...i })),
      trackers: [
        {
          mappingId: M1,
          connector: "github",
          label: "GitHub",
          remoteName: "acme/app",
          commandLine: true,
          status: "ok",
          retryAt: null,
          observedAt: iso(now - 60000),
        },
      ],
    },
    // The earlier one-tracker set-up, shown under "Show the earlier set-up".
    "organization.trackers": {
      version: 1,
      observedAt: iso(now),
      partial: false,
      projects: [
        {
          projectId: P1,
          tracker: "github",
          remoteName: "acme/site",
          mappingRevision: 1,
          status: "ok",
          retryAt: null,
          observedAt: iso(now - 60000),
        },
      ],
      items: [],
      links: [],
    },
  },
};
// The screenshot secret gate (CONTRACTS §1a): nothing personal or host-specific may be rendered.
(function gate(v, where = "seed") {
  if (typeof v === "string") {
    if (!noPersonal(v)) throw Error(`Seed data at ${where} is not personal-data free`);
  } else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) gate(x, `${where}.${k}`);
})(STATES);
fs.writeFileSync(
  path.join(work, "plugin-client.mjs"),
  `export const useRpc = definition => async () => { const value = window.__seed[definition.name]; if (!value) throw new Error('No seed for ' + definition.name); return value; };
export const useTheme = () => null;
const credentials = { begin: async () => ({ flowId: 'flow-fake-0001', userCode: 'WDJB-MJHT' }), complete: async () => ({ status: 'pending', retryAfterSeconds: 5 }), reconnect: async () => ({ flowId: 'flow-fake-0002' }), remove: async () => ({ removed: true }) };
// A host without update P1 has no usePaseo credentials.
export const usePaseo = () => (window.__seed.hostApi ? { credentials } : {});
`,
);
fs.writeFileSync(
  path.join(work, "plugin.mjs"),
  "export const defineRpc = definition => definition;\n",
);
// Plain .jsx on purpose: tsconfig includes every **/*.tsx, and a generated file must never join the typecheck.
fs.writeFileSync(
  path.join(work, "entry.jsx"),
  `import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TrackingSurface } from '../../client/tracking';
import { IntegrationsScreen } from '../../client/integrations';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const theme = { colors: window.__theme };
const compact = window.innerWidth < 600;
const Screen = window.__screen === 'integrations' ? IntegrationsScreen : TrackingSurface;
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><Screen theme={theme} layout={{ compact, platform: 'web' }} /></div></QueryClientProvider>);
`,
);
const { build } = ui("esbuild");
await build({
  entryPoints: [path.join(work, "entry.jsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  outfile: path.join(work, "bundle.js"),
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
  alias: {
    "react-native": pkg("react-native-web"),
    react: pkg("react"),
    "react-dom": pkg("react-dom"),
    zod: pkg("zod"),
    "@tanstack/react-query": pkg("@tanstack/react-query"),
    "@getpaseo/plugin/client": path.join(work, "plugin-client.mjs"),
    "@getpaseo/plugin": path.join(work, "plugin.mjs"),
  },
});
const bundle = fs.readFileSync(path.join(work, "bundle.js"), "utf8");
const { chromium } = ui("playwright");
const browser = await chromium.launch();
const shots = [];
try {
  const only = process.argv[3] ?? null;
  for (const [state, seed] of Object.entries(STATES).filter(([name]) => !only || name === only))
    for (const screen of seed.screens ?? ["trackers", "integrations"])
      for (const [name, colors] of Object.entries(THEMES))
        for (const [w, h] of [
          [1280, 800],
          [390, 844],
        ]) {
          const page = await browser.newPage({
            viewport: { width: w, height: h },
            colorScheme: name,
            deviceScaleFactor: w < 600 ? 2 : 1,
          });
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.setContent(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;background:${colors.surface0};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}</style></head><body><div id="root"></div></body></html>`,
          );
          await page.evaluate(
            ([d, t, s]) => {
              window.__seed = d;
              window.__theme = t;
              window.__screen = s;
            },
            [seed, colors, screen],
          );
          await page.addScriptTag({ content: bundle });
          if (screen === "trackers") {
            await page.getByTestId("tracker-trail-#42").waitFor();
            if (state === "needs-p1") {
              await page.getByRole("button", { name: "Show the earlier set-up" }).click();
            }
          } else {
            await page.getByTestId("integration-github").waitFor();
            if (seed.open)
              for (const name of seed.open)
                await page.getByRole("button", { name, exact: true }).click();
            else if (state === "available") {
              await page.getByRole("button", { name: "Connect GitHub" }).click();
              await page.getByTestId("integration-connect-github").waitFor();
            } else await page.getByTestId("integrations-needs-p1").waitFor();
          }
          await page.waitForTimeout(150);
          if (errors.length) throw Error(`Render errors: ${errors.join("; ")}`);
          const scroller = screen === "trackers" ? "tracking" : "integrations";
          const full = await page.evaluate((id) => {
            const s = document.querySelector(`[data-testid="${id}"]`);
            return s ? s.scrollHeight : document.body.scrollHeight;
          }, scroller);
          const file = `${screen}-${state}-${name}-${w}x${h}.png`;
          await page.screenshot({ path: path.join(out, file) });
          await page.setViewportSize({ width: w, height: Math.max(h, full) });
          await page.screenshot({ path: path.join(out, file.replace(".png", "-full.png")) });
          shots.push(file, file.replace(".png", "-full.png"));
          await page.close();
        }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({ screens: shots.map((s) => `../../local/screens/trackers/${s}`) }, null, 2),
);
