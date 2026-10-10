import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build, version: esbuildVersion } = require("esbuild");
const files = [
  "server/management.ts",
  "server/management.test.ts",
  "shared/management.ts",
  "client/management.tsx",
  "client/supervision.tsx",
  "client/management-query.ts",
  "client/management-query.test.ts",
  "../src/control/manager.mjs",
  "../src/control/manager.test.mjs",
  "../src/control/native.mjs",
  "../src/control/store.mjs",
  "../src/control/controller.mjs",
  "../src/control/rpc.mjs",
  "../src/control/control.test.mjs",
  "index.server.ts",
  "index.client.tsx",
  "server/organization.ts",
  "server/organization.test.ts",
  "shared/organization.ts",
  "client/organization.tsx",
  "package.json",
  "tsconfig.json",
  "paseo-plugin.json",
  "verify.mjs",
];
files.push(
  "client/navigation.ts",
  "client/navigation.test.ts",
  "shared/tasks.ts",
  "server/tasks.ts",
  "server/tasks.test.ts",
  "client/tasks.tsx",
  "../src/control/task-index.test.mjs",
);
files.push(
  "../src/control/resumption.mjs",
  "../src/control/resumption.test.mjs",
  "../src/control/leadership.mjs",
  "../src/control/leadership.test.mjs",
  "client/leadership.tsx",
);
files.push("client/ui.test.mjs", "client/ui-test-adapters.mjs", "verify-ui.mjs");
files.push(
  "shared/outcomes.ts",
  "server/outcomes.ts",
  "server/outcomes.test.ts",
  "client/outcomes.tsx",
  "client/work-brief.tsx",
);
files.push("server/wiring.test.mjs", "server/wiring-test-adapters.mjs");
files.push(
  "client/work-labels.ts",
  "client/work-graph.tsx",
  "client/work-graph-layout.ts",
  "client/work-graph-layout.test.ts",
);
files.push(
  "client/conversation-link.ts",
  "client/conversation-link.test.ts",
  "client/original-conversation.tsx",
);
files.push(
  "shared/history.mjs",
  "shared/history.d.mts",
  "shared/history.ts",
  "shared/history.test.mjs",
  "server/history.ts",
  "server/history.test.ts",
);
files.push(
  "shared/work-messages.mjs",
  "shared/work-messages.d.mts",
  "shared/work-messages.test.mjs",
  "client/conversation-updates.tsx",
  "client/readable-update.ts",
);
files.push("shared/host-binding.ts", "server/host-binding.ts");
files.push("server/remote-observation.ts", "server/remote-observation.test.ts");
files.push("client/inbox-model.ts", "client/inbox-model.test.ts");
// Update-7: the account pool, rotation, role defaults, orchestration, Accounts & models.
files.push(
  "server/accounts.mjs",
  "server/accounts.d.mts",
  "server/accounts.test.mjs",
  "server/role-defaults-store.mjs",
  "server/accounts-rpc.ts",
  "server/accounts-rpc.test.ts",
  "shared/accounts.ts",
  "server/orchestration.ts",
  "server/orchestration.test.ts",
  "client/accounts.tsx",
  "client/switch-account.tsx",
  "server/account-authority.mjs",
  "server/account-authority.d.mts",
  "client/accounts.ui.test.mjs",
  "../src/control/account-rotation.mjs",
  "../src/control/account-rotation.test.mjs",
);
files.push(
  "shared/fleet.ts",
  "server/fleet.ts",
  "server/fleet.test.ts",
  "client/fleet.tsx",
  "client/fleet-live.ts",
  "client/fleet-live-model.ts",
  "client/fleet-live.test.ts",
);
// J3 issue trackers: connectors, service, contracts, UI and the controller records they depend on.
files.push(
  "shared/tracker-refs.mjs",
  "shared/tracker-refs.d.mts",
  "shared/tracker-refs.test.mjs",
  "shared/trackers.ts",
  "shared/trackers.contract.test.mjs",
  "client/trackers.tsx",
  "client/tracker-link.ts",
  "client/trackers.ui.test.mjs",
);
files.push(
  ...["http", "github", "gh-runner", "jira", "bitbucket", "service"].flatMap((m) => [
    `server/trackers/${m}.mjs`,
    `server/trackers/${m}.d.mts`,
  ]),
  "server/trackers/connector.d.mts",
);
files.push(
  ...["github", "service", "security", "atlassian"].map((m) => `server/trackers/${m}.test.mjs`),
  "server/trackers/harness.mjs",
  "server/trackers/test-support.mjs",
);
files.push(
  "../src/control/trackers.mjs",
  "../src/control/trackers.test.mjs",
  "../src/control/trackers-credential.mjs",
  "../src/control/trackers-credential.test.mjs",
);
// Fulcra J4/J4b connectors: host-mediated `http`, GitHub, Jira and Bitbucket (Cloud and Data Center), service, provenance.
files.push(
  ...[
    "http",
    "github",
    "jira",
    "bitbucket",
    "web-refs",
    "service",
    "registry",
    "provenance",
    "git",
  ].flatMap((m) => [`server/connectors/${m}.mjs`, `server/connectors/${m}.d.mts`]),
  "server/connectors/host-test-support.mjs",
);
files.push(
  ...["github", "jira", "bitbucket", "service", "provenance"].map(
    (m) => `server/connectors/${m}.test.mjs`,
  ),
  "client/integrations.tsx",
  "client/integrations.ui.test.mjs",
  "client/tracking.tsx",
  "client/tracker-refresh.ts",
  "client/tracker-link.ts",
);
// DESIGN-R R2: the Recovery surface, in its own files.
files.push("shared/plain-reason.mjs");
files.push(
  "shared/recovery.ts",
  "shared/recovery-view.mjs",
  "shared/recovery-view.d.mts",
  "shared/recovery-view.test.mjs",
  "shared/plain-reason.test.mjs",
  "server/recovery.ts",
  "server/recovery-handlers.mjs",
  "server/recovery-handlers.d.mts",
  "server/recovery-handlers.test.mjs",
  "client/recovery.tsx",
);
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
files.push(
  "shared/briefing.ts",
  "server/briefing.ts",
  "server/briefing.test.ts",
  "client/briefing.tsx",
);
files.push(
  "client/selected-task.ts",
  "client/portfolio.tsx",
  "client/management-section.tsx",
  "shared/projects.ts",
  "server/projects.ts",
  "server/projects.test.ts",
  "client/projects.tsx",
);
files.push(
  "client/hierarchy.ts",
  "client/hierarchy.test.ts",
  "client/prime.tsx",
  "client/seat-chat.ts",
);
files.push("shared/roles.ts", "server/roles.ts", "server/roles.test.ts", "client/role-seat.tsx");
files.push(
  "shared/session-defaults.ts",
  "server/session-defaults.ts",
  "server/session-defaults.test.ts",
);
files.push("shared/rpc-contract.ts", "client/use-contract.ts");
// Command Centre shared contracts (CONTRACTS.md), one file per section.
files.push(
  "shared/cc/refs.mjs",
  "shared/cc/refs.d.mts",
  "shared/cc/refs.ts",
  "shared/cc/refs.test.ts",
  "shared/cc/refs.test.mjs",
);
files.push(
  "client/today.tsx",
  "client/today-model.ts",
  "client/today-model.test.ts",
  "client/today-seen.ts",
  "client/today.ui.test.mjs",
);
files.push(
  "client/launchpad.tsx",
  "client/launchpad-model.ts",
  "client/launchpad-model.test.ts",
  "client/launchpad-snooze.ts",
  "client/launchpad.ui.test.mjs",
);
files.push(
  "client/tabs.ts",
  "client/tabs.test.ts",
  "screens/lifecycle/tsconfig.json",
  "screens/lifecycle/dom.d.mts",
  "server/portable.fixture.ts",
);
// J6 step-through: contracts, server shaping, UI, agent panel, fixtures and tests.
files.push(
  "shared/session-steps.ts",
  "shared/privacy-scrub.ts",
  "server/session-steps.ts",
  "server/session-steps.test.ts",
  "client/step-through.tsx",
  "client/step-through-panel.tsx",
  "client/step-through.ui.test.mjs",
  "client/what-it-did.ts",
  "client/what-it-did.test.ts",
  "client/what-it-did-card.tsx",
  "client/what-it-did-footer.tsx",
  "shared/step-shaping.ts",
  "client/team-tree.ts",
  "client/team-tree.test.ts",
  "client/team-tree-view.tsx",
  "client/team-tree.ui.test.mjs",
  "client/fresh-start.ts",
  "client/fresh-start.test.ts",
  "client/fresh-start-view.tsx",
  "client/cleanup-now.ts",
  "client/recovery-seen.ts",
  "client/pending-questions.tsx",
  "client/organisation-model.test.ts",
  "client/cleanup-now.test.ts",
  "client/cleanup-now-view.tsx",
  "client/cleanup-now.ui.test.mjs",
  "screens/session-fixtures.ts",
);
files.push(
  "client/changes.tsx",
  "client/project-sessions.tsx",
  "../src/control/host-native.mjs",
  "../src/control/list-batch.test.mjs",
  "../src/control/held-subject.mjs",
  "../src/control/held-subject.test.mjs",
  "../src/control/default-remits.test.mjs",
);
files.push("client/details.tsx", "client/last-good.ts", "client/last-good.test.ts");
files.push("client/project-work.tsx", "client/build-identity.ts");
files.push(
  "shared/work-map.ts",
  "shared/linked-issues.ts",
  "server/work-map.ts",
  "server/work-map.test.ts",
  "client/work-map-model.ts",
  "client/work-map-model.test.ts",
  "client/work-map-readonly.test.ts",
  "client/work-map.tsx",
  "client/work-map.test.mjs",
);
// Fulcra J3 Inbox: contracts, rules shared with the controller, server handlers, UI and the controller store.
files.push(
  "shared/cc/refs.mjs",
  "shared/cc/refs.d.mts",
  "shared/cc/refs.ts",
  "shared/cc/refs.test.mjs",
  "shared/cc/decision-rules.mjs",
  "shared/cc/decision-rules.d.mts",
  "shared/cc/decision.ts",
  "shared/cc/devices.ts",
  "server/devices.ts",
  "client/devices.tsx",
  "shared/cc/channels.ts",
  "shared/cc/channel-text.mjs",
  "server/channels.ts",
  "client/channels.tsx",
  "verify-chat-sample.mjs",
  "server/inbox.ts",
  "server/inbox.test.mjs",
  "client/inbox.tsx",
  "client/inbox.ui.test.mjs",
);
files.push(
  "../src/control/decisions.mjs",
  "../src/control/decisions.fixture.mjs",
  "../src/control/decisions.test.mjs",
  "../src/control/devices.mjs",
  "../src/control/devices.test.mjs",
  "../src/control/inbox-channels.mjs",
  "../src/control/inbox-channels.test.mjs",
  "../src/control/fulcra-inbox.mjs",
);
// Fulcra J1 Organisation: remit and brief contracts, rules shared with the controller, server handlers, UI and the controller stores.
files.push(
  "shared/cc/remit-rules.mjs",
  "shared/cc/remit-rules.d.mts",
  "shared/cc/remit.ts",
  "shared/cc/brief-rules.mjs",
  "shared/cc/brief-rules.d.mts",
  "shared/cc/brief.ts",
  "server/organisation.ts",
  "server/organisation.test.mjs",
  "client/organisation.tsx",
  "client/organisation-model.ts",
  "client/organisation-story.tsx",
  "client/organisation-remit.tsx",
  "client/organisation-ui.tsx",
  "client/organisation.ui.test.mjs",
);
files.push(
  "../src/control/remits.mjs",
  "../src/control/briefs.mjs",
  "../src/control/remits.test.mjs",
);
// Fulcra J8 Environments: contract, rules shared with the controller, server handlers, UI and the controller registry.
files.push(
  "shared/cc/environment-rules.mjs",
  "shared/cc/environment-rules.d.mts",
  "shared/cc/environment.ts",
  "server/environments.ts",
  "server/environments.test.mjs",
  "client/environments.tsx",
  "client/environments.ui.test.mjs",
);
files.push(
  "../src/control/environments.mjs",
  "../src/control/environment-runner.mjs",
  "../src/control/environments.fixture.mjs",
  "../src/control/environments.test.mjs",
);
// This standalone plugin repository does not own the separately released controller.
for (let i = files.length - 1; i >= 0; i--) if (files[i].startsWith("../src/")) files.splice(i, 1);
const source = () => Object.fromEntries(files.map((name) => [name, hash(path.join(root, name))]));
const before = source();
const runtime = path.join(root, "runtime");
fs.mkdirSync(runtime, { recursive: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit"], {
  cwd: root,
  stdio: "inherit",
});
// The lifecycle screen entry runs in a browser: typecheck it with DOM types, separately from the node plugin sources.
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "--noEmit", "-p", "screens/lifecycle"],
  { cwd: root, stdio: "inherit" },
);
for (const [entry, output] of [
  ["server/orchestration.test.ts", "orchestration.test.mjs"],
  ["server/accounts-rpc.test.ts", "accounts-rpc.test.mjs"],
  ["server/remote-observation.test.ts", "remote-observation.test.mjs"],
  ["server/briefing.test.ts", "briefing.test.mjs"],
  ["server/projects.test.ts", "projects.test.mjs"],
  ["server/history.test.ts", "history.test.mjs"],
  ["client/conversation-link.test.ts", "conversation-link.test.mjs"],
  ["client/today-model.test.ts", "today-model.test.mjs"],
  ["client/inbox-model.test.ts", "inbox-model.test.mjs"],
  ["client/launchpad-model.test.ts", "launchpad-model.test.mjs"],
  ["client/work-graph-layout.test.ts", "work-graph-layout.test.mjs"],
  ["server/fleet.test.ts", "fleet.test.mjs"],
  ["client/fleet-live.test.ts", "fleet-live.test.mjs"],
  ["server/fleet.ts", "fleet-server.mjs"],
  ["server/outcomes.test.ts", "outcomes.test.mjs"],
  ["server/outcomes.ts", "outcomes-server.mjs"],
  ["server/wiring.test.mjs", "wiring.test.mjs"],
  ["client/navigation.test.ts", "navigation.test.mjs"],
  ["server/tasks.test.ts", "tasks.test.mjs"],
  ["client/management-query.test.ts", "management-query.test.mjs"],
  ["server/management.test.ts", "management.test.mjs"],
  ["server/management.ts", "management-server.mjs"],
  ["server/organization.test.ts", "organization.test.mjs"],
  ["server/organization.ts", "organization-server.mjs"],
  ["server/work-map.test.ts", "work-map.test.mjs"],
  ["client/work-map-model.test.ts", "work-map-model.test.mjs"],
  ["client/work-map-readonly.test.ts", "work-map-readonly.test.mjs"],
  ["shared/cc/refs.test.ts", "refs.test.mjs"],
  ["client/tabs.test.ts", "tabs.test.mjs"],
  ["client/what-it-did.test.ts", "what-it-did.test.mjs"],
  ["client/team-tree.test.ts", "team-tree.test.mjs"],
  ["client/fresh-start.test.ts", "fresh-start.test.mjs"],
  ["client/cleanup-now.test.ts", "cleanup-now.test.mjs"],
  ["client/organisation-model.test.ts", "organisation-model.test.mjs"],
  ["server/session-steps.test.ts", "session-steps.test.mjs"],
  ["client/last-good.test.ts", "last-good.test.mjs"],
  ["server/session-defaults.test.ts", "session-defaults.test.mjs"],
]) {
  const plugins =
    entry === "server/wiring.test.mjs"
      ? [
          {
            name: "wiring-only-doubles",
            setup(build) {
              build.onResolve(
                { filter: /^\.\/server\/(management|tasks|organization|fleet|projects)$/ },
                (args) =>
                  args.importer === path.join(root, "index.server.ts")
                    ? { path: path.join(root, "server/wiring-test-adapters.mjs") }
                    : undefined,
              );
              build.onResolve({ filter: /^\.\/(management|tasks)$/ }, (args) =>
                args.importer === path.join(root, "server/recovery.ts")
                  ? { path: path.join(root, "server/wiring-test-adapters.mjs") }
                  : undefined,
              );
            },
          },
        ]
      : [];
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.join(runtime, output),
    plugins,
  });
}
await build({
  entryPoints: [path.join(root, "client/hierarchy.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: path.join(runtime, "hierarchy.test.mjs"),
});
await build({
  entryPoints: [path.join(root, "server/roles.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: path.join(runtime, "roles.test.mjs"),
});
// A hang guard, not a budget: the controller's Environments suite (extended by V4) runs for minutes on a slow host.
const tapFile = path.join(runtime, "tests.tap"),
  output = fs.openSync(tapFile, "w");
try {
  execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "runtime/orchestration.test.mjs",
      "runtime/accounts-rpc.test.mjs",
      "server/accounts.test.mjs",
      "../src/control/account-rotation.test.mjs",
      "../src/control/creation-roles.test.mjs",
      "runtime/work-map.test.mjs",
      "runtime/work-map-model.test.mjs",
      "runtime/work-map-readonly.test.mjs",
      "runtime/refs.test.mjs",
      "shared/cc/refs.test.mjs",
      "runtime/tabs.test.mjs",
      "runtime/what-it-did.test.mjs",
      "runtime/team-tree.test.mjs",
      "runtime/fresh-start.test.mjs",
      "runtime/cleanup-now.test.mjs",
      "runtime/organisation-model.test.mjs",
      "runtime/today-model.test.mjs",
      "runtime/inbox-model.test.mjs",
      "runtime/launchpad-model.test.mjs",
      "runtime/last-good.test.mjs",
      "runtime/hierarchy.test.mjs",
      "runtime/roles.test.mjs",
      "shared/history.test.mjs",
      "shared/work-messages.test.mjs",
      "shared/recovery-view.test.mjs",
      "shared/plain-reason.test.mjs",
      "server/recovery-handlers.test.mjs",
      "runtime/remote-observation.test.mjs",
      "runtime/fleet-live.test.mjs",
      "runtime/briefing.test.mjs",
      "runtime/projects.test.mjs",
      "runtime/history.test.mjs",
      "runtime/conversation-link.test.mjs",
      "runtime/work-graph-layout.test.mjs",
      "runtime/fleet.test.mjs",
      "server/fleet-projection.test.mjs",
      "runtime/outcomes.test.mjs",
      "runtime/wiring.test.mjs",
      "runtime/navigation.test.mjs",
      "runtime/tasks.test.mjs",
      "runtime/organization.test.mjs",
      "runtime/management.test.mjs",
      "runtime/management-query.test.mjs",
      "shared/tracker-refs.test.mjs",
      "server/trackers/github.test.mjs",
      "server/trackers/service.test.mjs",
      "server/trackers/security.test.mjs",
      "server/trackers/atlassian.test.mjs",
      "shared/trackers.contract.test.mjs",
      "../src/control/trackers.test.mjs",
      "../src/control/trackers-credential.test.mjs",
      "server/inbox.test.mjs",
      "../src/control/decisions.test.mjs",
      "../src/control/devices.test.mjs",
      "../src/control/inbox-channels.test.mjs",
      "server/organisation.test.mjs",
      "../src/control/remits.test.mjs",
      "server/connectors/github.test.mjs",
      "server/connectors/jira.test.mjs",
      "server/connectors/bitbucket.test.mjs",
      "server/connectors/service.test.mjs",
      "server/connectors/provenance.test.mjs",
      "runtime/session-steps.test.mjs",
      "runtime/session-defaults.test.mjs",
      "server/environments.test.mjs",
      "../src/control/environments.test.mjs",
    ],
    { cwd: root, stdio: ["ignore", output, output], timeout: 300000 },
  );
} catch {
  throw new Error("Plugin source tests failed; see " + tapFile);
} finally {
  fs.closeSync(output);
}
const tap = fs.readFileSync(tapFile, "utf8");
const evidence = {
  observedAt: new Date().toISOString(),
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceFiles: before,
  node: process.version,
  esbuild: esbuildVersion,
  typescript: require("typescript/package.json").version,
  executed: Object.fromEntries(
    [
      "orchestration.test.mjs",
      "accounts-rpc.test.mjs",
      "work-map.test.mjs",
      "work-map-model.test.mjs",
      "work-map-readonly.test.mjs",
      "refs.test.mjs",
      "tabs.test.mjs",
      "today-model.test.mjs",
      "inbox-model.test.mjs",
      "session-steps.test.mjs",
      "last-good.test.mjs",
      "hierarchy.test.mjs",
      "remote-observation.test.mjs",
      "briefing.test.mjs",
      "projects.test.mjs",
      "history.test.mjs",
      "conversation-link.test.mjs",
      "work-graph-layout.test.mjs",
      "fleet.test.mjs",
      "fleet-live.test.mjs",
      "fleet-server.mjs",
      "outcomes.test.mjs",
      "outcomes-server.mjs",
      "wiring.test.mjs",
      "navigation.test.mjs",
      "tasks.test.mjs",
      "management-query.test.mjs",
      "organization.test.mjs",
      "organization-server.mjs",
      "management.test.mjs",
      "management-server.mjs",
      "tests.tap",
    ].map((name) => [name, hash(path.join(runtime, name))]),
  ),
  live: null,
};
if (process.argv.includes("--live")) {
  const { organizationSnapshot } = await import("./runtime/organization-server.mjs");
  // The controller's own runtime helper: the sibling checkout by default, or ORCA_RUNTIME_MODULE when the plugin is checked out alone.
  const runtimeModule = process.env.ORCA_RUNTIME_MODULE ?? path.join(root, "../src/runtime.mjs");
  if (!path.isAbsolute(runtimeModule) || !fs.existsSync(runtimeModule))
    throw new Error(
      "--live needs the Fulcra controller runtime: set ORCA_RUNTIME_MODULE to its src/runtime.mjs",
    );
  const { connect } = await import(pathToFileURL(runtimeModule).href);
  const client = await connect();
  try {
    const started = Date.now();
    const snapshot = await organizationSnapshot(client);
    fs.writeFileSync(
      path.join(runtime, "live-observation.json"),
      JSON.stringify({ elapsedMs: Date.now() - started, snapshot }, null, 2),
    );
    evidence.live = {
      sha256: hash(path.join(runtime, "live-observation.json")),
      method:
        "Direct source function through actual SDK; installed plugin RPC and UI remain separate checks",
    };
  } finally {
    await client.close();
  }
}
if (JSON.stringify(before) !== JSON.stringify(source()))
  throw new Error("Source changed during verification");
fs.writeFileSync(
  path.join(runtime, "source-evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(tap.trim());
console.log(
  JSON.stringify({
    sourceHead: evidence.sourceHead,
    tools: { node: evidence.node, esbuild: esbuildVersion, typescript: evidence.typescript },
    live: evidence.live,
  }),
);
