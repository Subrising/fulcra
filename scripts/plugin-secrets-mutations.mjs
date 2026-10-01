// Mutation run for plugin secrets (J3 issue trackers, J3-DESIGN.md §3.1). Each mutation applies exact-anchor
// edits, runs plugin-secrets.test.ts, requires the named test to fail, then restores the original bytes.
// An anchor that does not occur exactly once aborts the run.
//
//   node scripts/plugin-secrets-mutations.mjs [ids…]
//   J3_VITEST=/abs/vitest.mjs J3_VITEST_CONFIG=/abs/config.mjs node scripts/plugin-secrets-mutations.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = path.join(root, "packages/server/src/server/plugins/plugin-secrets.ts");
const PROCESS = path.join(root, "packages/server/src/server/plugins/plugin-process.ts");
const SUITE = "src/server/plugins/plugin-secrets.test.ts";

const M = [
  {
    id: "PM1",
    why: "namespace not bound to the plugin id",
    expect: "P1",
    edits: [
      [SECRETS, "  return `ai.fulcra.plugin.${pluginId}`;", '  return "ai.fulcra.plugin.shared";'],
    ],
  },
  {
    id: "PM2",
    why: "exists() reads the secret value",
    expect: "P2",
    edits: [[SECRETS, '...(withValue ? ["-w"] : [])', '...(withValue ? ["-w"] : ["-w"])']],
  },
  {
    id: "PM3",
    why: "secret name not validated",
    expect: "P2",
    edits: [
      [
        SECRETS,
        '  if (typeof name !== "string" || !SECRET_NAME.test(name)) {',
        '  if (typeof name !== "string") {',
      ],
    ],
  },
  {
    id: "PM4",
    why: "plugin output containing a secret not withheld",
    expect: "P3",
    edits: [
      [
        SECRETS,
        "  if (store?.containsSecret(output)) throw new PluginOutputWithheldError();\n",
        "",
      ],
    ],
  },
  {
    id: "PM5",
    why: "error text not redacted",
    expect: "P4",
    edits: [[SECRETS, "  return store ? store.redact(message) : message;", "  return message;"]],
  },
  {
    id: "PM6",
    why: "malformed secret values accepted",
    expect: "P5",
    edits: [
      [
        SECRETS,
        "  if (!value || value.length > MAX_SECRET_LENGTH || hasControlCharacter(value)) {",
        "  if (!value) {",
      ],
    ],
  },
  {
    id: "PM7",
    why: "non-macOS hosts not refused",
    expect: "P5",
    edits: [
      [SECRETS, '    if (platform !== "darwin") throw new PluginSecretUnavailableError();\n', ""],
    ],
  },
  {
    id: "PM8",
    why: "plugin process never creates the per-plugin store",
    expect: "P6",
    edits: [
      [PROCESS, "  secretStore = createPluginSecretStore({ pluginId: message.pluginId });\n", ""],
    ],
  },
  {
    id: "PM9",
    why: "RPC results not guarded",
    expect: "P6",
    edits: [[PROCESS, "    .then((output) => guardPluginOutput(secretStore, output))\n", ""]],
  },
  {
    id: "PM10",
    why: "hook results not guarded",
    expect: "P6",
    edits: [
      [
        PROCESS,
        "            output: guardPluginOutput(secretStore, output),",
        "            output,",
      ],
    ],
  },
];

function failing() {
  const report = path.join(os.tmpdir(), `plugin-secrets-mutations-${process.pid}.json`);
  const vitest = process.env.J3_VITEST;
  const args = vitest
    ? [
        vitest,
        "run",
        "--config",
        process.env.J3_VITEST_CONFIG,
        "--reporter=json",
        `--outputFile=${report}`,
      ]
    : [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        SUITE,
        "--reporter=json",
        `--outputFile=${report}`,
      ];
  try {
    execFileSync(process.execPath, args, {
      cwd: path.join(root, "packages/server"),
      stdio: "ignore",
    });
  } catch {
    // A failing suite exits non-zero; the JSON report says which tests failed.
  }
  const result = JSON.parse(fs.readFileSync(report, "utf8"));
  fs.rmSync(report, { force: true });
  return result.testResults.flatMap((file) =>
    file.assertionResults.filter((a) => a.status === "failed").map((a) => a.title),
  );
}

const only = process.argv.slice(2);
let survived = 0;
for (const m of M.filter((x) => !only.length || only.includes(x.id))) {
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      const text = originals.get(file) ?? fs.readFileSync(file, "utf8");
      originals.set(file, text);
      const current = fs.readFileSync(file, "utf8");
      if (current.split(from).length !== 2)
        throw new Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(
        file,
        current.replace(from, () => to),
      );
    }
    const failed = failing();
    const killed = failed.some((title) => title.startsWith(`${m.expect}:`));
    if (!killed) survived += 1;
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"} ${m.id.padEnd(5)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.map((t) => t.slice(0, 24)).join(" | ") || "none"}`,
    );
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(survived ? `${survived} mutation(s) SURVIVED` : "all mutations killed");
process.exitCode = survived ? 1 : 0;
