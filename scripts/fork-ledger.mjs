// Fork patch ledger: maps every file that differs from the Paseo base to one named Fulcra core patch.
// Usage: node scripts/fork-ledger.mjs [--base <tag>] [--write] [--check]
//   (no flag) print the summary table
//   --write   regenerate docs/fork-patches.tsv and the generated tables in docs/fork-patches.md
//   --check   exit 1 if the TSV is stale (a changed file was added, removed or re-attributed)
// Compares the working tree (stage new files first). control/ is Fulcra-only (no upstream counterpart) and is not part of the core diff.
// Attribution: a file whose path names a patch belongs to it. Otherwise each diff hunk is attributed by its
// content keywords and the file goes to the patch with most changed lines; a file where no patch has 60% of
// those lines is a shared seam and lists its split. What remains is product UI (features) or core-fixes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PATCHES = [
  {
    id: "image-retention",
    owner: "Fulcra prime (platform)",
    reason:
      "Agent image files: confined private storage and a rolling retention window. At about 2,000 files or 1 GB the least recently written images are deleted to make room, and a deleted image reads as 'Image no longer kept'. Paseo refused every new image after 256 files or 64 MB per daemon run.",
    path: /provider-image-output/i,
    words: /EvictedProviderImage|EVICTED_PROVIDER_IMAGE|evictOldest|evictedNames/,
  },
  {
    id: "orchestration",
    owner: "Fulcra prime (orchestration)",
    reason:
      "Primes/leads/workers hierarchy, durable report-up and receipts, re-parent/promote, controller channel and management route. Paseo has no hierarchy or durable delivery.",
    path: /report-registry|report-inbox|intercom|management|message-receipts|orchestration-skills|parent-adoption|native-queued|lifecycle-command|controller-(channel|frames|rpc|service|distribution)|\/hub\/|snapshot-mutation-ownership|session-ownership|import-sessions|agent-loading|cli\/src\/commands\/agent\/(send|run)|leadership|organi[sz]ation/i,
    words:
      /report|receipt|inbox|intercom|parent|prime|\blead\b|hierarch|management|controller|outcome|promot|\brole\b|supervis/i,
  },
  {
    id: "admission",
    owner: "Fulcra prime (security)",
    reason:
      "Permission veto and input admission (human seat vs delegated seat), per-agent grants, trusted host. Paseo has no before-hook on prompt/send/permission and its permissions are daemon-wide.",
    path: /admission|trusted|authorization\/|permission-response|operation-permissions|server\/auth(\.test)?\.ts|grant|veto|fence/i,
    words: /admission|admit|trusted|veto|refus|grant|\bseat|delegat|provenance|fence/i,
  },
  {
    id: "accounts",
    owner: "Fulcra prime (accounts)",
    reason:
      "Account pool, per-launch credentials, plugin secrets/credential store (including plugin-saved secrets, used by Deploy for a cluster sign-in), connectors, account usage, quota and limit resume. Paseo has no secret store or multi-account launch.",
    path: /limit-resume|quota|usage|account|credential|plugin-secrets|secret|integrations\/|oauth|keychain|connector/i,
    words: /account|quota|usage|credential|secret|\bpool\b|rate.?limit|oauth/i,
  },
  {
    id: "session-launch",
    owner: "Fulcra prime (providers)",
    reason:
      "Session launch: create-agent intent, provider launch config, Claude/Codex/OpenCode/Pi provider changes, public baseline transport, model catalog.",
    path: /catalog|create-agent|agent\/providers\/|provider-(registry|snapshot|availability|image-output|refresh|selection)|runtime-mcp-config|model-manifest|public-baseline|agent-prompt|agent\/tools\/|agent-profiles/i,
    words: /provider|\bmodel|catalog|baseline|thinking|modeId|launch/i,
  },
  {
    id: "plugin-host",
    owner: "Fulcra prime (platform)",
    reason:
      "Bundled trusted plugin loading and the SDK adapters the bundled plugin needs (update/cancel, notifications, replayable events, panels, turn footers, and AgentQuestions in the UI kit, which reuses the core PermissionRequestCard exported from agent-stream/view.tsx).",
    path: /packages\/plugin\/|server\/plugins\/|app\/src\/plugins\/|agent-stream\/turn-tool-calls|bundled-plugins|bundled-controller|plugin-identity|plugin-examples|docs\/plugins/i,
    words: /plugin/i,
  },
  {
    id: "pairing",
    owner: "Fulcra prime (security)",
    reason:
      "Relay v3, signed invitations, device proof, immutable daemon-key pin, host repair, multi-Mac pairing bundles. Security transport below the plugin layer.",
    path: /pair|relay|connection-offer|device|host-repair|daemon-endpoints|host-runtime|app\/src\/hosts\//i,
    words: /pair|relay|device|invitation|fingerprint/i,
  },
  {
    id: "durability",
    owner: "Fulcra prime (platform)",
    reason:
      "Durable timelines and state: file timeline store, atomic writes, pid lock, persisted config, workspace reconciliation fixes that prevent history loss.",
    path: /timeline-store|agent-storage|atomic-file|pid-lock|persisted-config|daemon-config-store|workspace-(reconciliation|archive|directory|git-service)|session-timeline|timeline-sync/i,
    words: /timeline|persist|durable|atomic|journal/i,
  },
  {
    id: "desktop-runtime",
    owner: "Fulcra prime (release)",
    reason:
      "Standalone desktop/daemon runtime: daemon manager, bootstrap, self-updater, packaged speech models, desktop settings.",
    path: /packages\/desktop\/|daemon-manager|daemon-worker|bootstrap|self-updater|speech\/|sherpa|dictation|server\/config(\.test)?\.ts|session\/daemon\//i,
    words: null,
  },
  {
    id: "automations",
    owner: "Fulcra prime (product)",
    reason:
      'Automations ("when X, do Y") on top of Paseo schedules: service, protocol messages, client calls, screen and sidebar entry. Kept in core: moving it into the plugin needs two SDK seams and a ~900-line UI rewrite to save ~150 shared-file lines.',
    path: /automation/i,
    words: /automation/i,
  },
  {
    id: "features",
    owner: "Fulcra prime (product)",
    reason:
      "Fulcra product UI and helpers in the app: architecture map and plain-English PR review (the checkout.pull-request-review.explain RPC behind the pullRequestReviewExplain feature, cached in PASEO_HOME/review-explanations, capped daily by the optional daemon config field explainDailyLimit), insights, work map, attention, schedules, navigation, sidebar and other views. Kept in core because each would cost more to move into the plugin than the shared-file lines it saves.",
    path: /architecture|pull-request-review|explain-budget|insight|work-map|attention|schedule|sidebar|navigation|workspace-tabs|panels\/|command-center|agent-list/i,
    words: null,
  },
  {
    id: "branding",
    owner: "Fulcra prime (release)",
    reason:
      "Fulcra name, assets, strings, docs and app identity. Distribution identity is what needs the fork.",
    path: /app\/public\/|README|CHANGELOG|NOTICE|SECURITY|BRANDING|CONTRIBUTING|CODE_OF_CONDUCT|RELEASE-NOTES|assets\/|images\/|i18n|locales|fastlane|packages\/website|^docs\/|public-docs|^skills\/|AGENTS\.md|CLAUDE\.md|app\.json|app\.config|\.(png|jpg|gif|webm|mp4|svg|icns|ico)$/i,
    words: null,
  },
  {
    id: "build-ci",
    owner: "Fulcra prime (release)",
    reason: "CI workflows, build/packaging/test-infra scripts, dependency pins and patches.",
    path: /e2e\/support|test-stubs|metro|maestro|\.oxlintrc|\.oxfmtrc|\.gitattributes|^\.github\/|^scripts\/|package(-lock)?\.json$|^patches\/|^nix\/|flake\.|lefthook|knip|vitest|tsconfig|^release\/|^local\/|^docker\/|\.gitignore|paseo\.json|cli-client-id|repair-mutations/i,
    words: null,
  },
  {
    id: "core-fixes",
    owner: "Fulcra prime (platform)",
    reason:
      "General fixes in Paseo code found while running Fulcra. Re-check against each upstream release; drop each one upstream fixes.",
    path: null,
    words: null,
  },
];
const SEAM_SHARE = 0.6;
const SEAM_MIN_LINES = 80;

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
}

function hunkSplit(patchText) {
  // Lines changed per patch id, from added and removed lines of each hunk.
  const split = {};
  for (const hunk of patchText.split(/^@@.*$/m).slice(1)) {
    const lines = hunk.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (!lines.length) continue;
    const text = lines.join("\n");
    const hit = PATCHES.find((p) => p.words && p.words.test(text));
    const id = hit ? hit.id : "_none";
    split[id] = (split[id] ?? 0) + lines.length;
  }
  return split;
}

export function attribute(file, patchText = "") {
  const byPath = PATCHES.find((p) => p.path && p.path.test(file));
  if (byPath) return { patch: byPath.id, split: null };
  const split = hunkSplit(patchText);
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(split)
    .filter(([id]) => id !== "_none")
    .sort((a, b) => b[1] - a[1]);
  const fallback = /packages\/app\/src\//.test(file) ? "features" : "core-fixes";
  if (!ranked.length || ranked[0][1] < total * 0.25) return { patch: fallback, split: null };
  const seam = total >= SEAM_MIN_LINES && ranked[0][1] < total * SEAM_SHARE;
  return {
    patch: ranked[0][0],
    split: seam
      ? Object.fromEntries(ranked.map(([k, v]) => [k, Math.round((100 * v) / total)]))
      : null,
  };
}

export function ledger(root, base) {
  const names = git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    base,
    "--",
    ".",
    ":!control",
    ":!docs/fork-patches.tsv",
    ":!docs/fork-patches.md",
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const nums = new Map(
    git(root, [
      "diff",
      "--numstat",
      "--no-renames",
      base,
      "--",
      ".",
      ":!control",
      ":!docs/fork-patches.tsv",
      ":!docs/fork-patches.md",
    ])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [a, d, f] = l.split("\t");
        return [f, [a === "-" ? 0 : +a, d === "-" ? 0 : +d]];
      }),
  );
  const patches = new Map();
  const full = git(root, [
    "diff",
    "-U0",
    "--no-renames",
    "--diff-filter=M",
    base,
    "--",
    ".",
    ":!control",
    ":!docs/fork-patches.tsv",
    ":!docs/fork-patches.md",
  ]);
  for (const chunk of full.split(/^diff --git /m).slice(1)) {
    const m = chunk.match(/^a\/(.+?) b\//);
    if (m) patches.set(m[1], chunk);
  }
  const rows = names.map(([status, file]) => {
    const [added, deleted] = nums.get(file) ?? [0, 0];
    const { patch, split } = attribute(file, status === "M" ? (patches.get(file) ?? "") : "");
    return { file, status, added, deleted, patch, split };
  });
  // A test belongs to the patch of the source file it tests, when that file is also changed.
  const bySource = new Map(rows.map((r) => [r.file, r.patch]));
  for (const r of rows) {
    const m = r.file.match(/^(.*?)(\.[\w-]+)*\.test\.(tsx?|mjs|js)$/);
    if (!m) continue;
    const source = ["ts", "tsx", "mjs", "js"]
      .map((ext) => `${m[1]}.${ext}`)
      .find((f) => bySource.has(f));
    if (source) {
      r.patch = bySource.get(source);
      r.split = null;
    }
  }
  return rows;
}

function tables(rows, base) {
  const sum = (xs, k) => xs.reduce((n, r) => n + r[k], 0);
  const up = rows.filter((r) => r.status !== "A");
  const lines = [
    `<!-- ledger:start (generated by node scripts/fork-ledger.mjs --write; base ${base}) -->`,
    "| Patch | Owner | Upstream files changed | Lines in them | New files | New lines | Reason |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...PATCHES.map((p) => {
      const mine = rows.filter((r) => r.patch === p.id);
      const mod = mine.filter((r) => r.status !== "A");
      const add = mine.filter((r) => r.status === "A");
      return `| \`${p.id}\` | ${p.owner} | ${mod.length} | +${sum(mod, "added")}/−${sum(mod, "deleted")} | ${add.length} | +${sum(add, "added")} | ${p.reason} |`;
    }),
    `| **total** | | ${up.length} | +${sum(up, "added")}/−${sum(up, "deleted")} | ${rows.length - up.length} | +${sum(
      rows.filter((r) => r.status === "A"),
      "added",
    )} | |`,
    "",
    "Shared seams (upstream files where several patches meet; resolve these hunk by hunk on merge):",
    "",
    "| File | Lines changed | Split by patch (% of changed lines; rest unattributed) |",
    "| --- | ---: | --- |",
    ...rows
      .filter((r) => r.split)
      .sort((a, b) => b.added + b.deleted - (a.added + a.deleted))
      .map(
        (r) =>
          `| \`${r.file}\` | ${r.added + r.deleted} | ${Object.entries(r.split)
            .map(([k, v]) => `${k} ${v}%`)
            .join(", ")} |`,
      ),
    "<!-- ledger:end -->",
  ];
  return lines.join("\n");
}

function main() {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const args = process.argv.slice(2);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "v0.11.0-beta.5";
  const rows = ledger(root, base).sort(
    (x, y) => x.patch.localeCompare(y.patch) || x.file.localeCompare(y.file),
  );
  const tsv =
    "patch\tstatus\tadded\tdeleted\tfile\n" +
    rows.map((r) => [r.patch, r.status, r.added, r.deleted, r.file].join("\t")).join("\n") +
    "\n";
  const tsvPath = path.join(root, "docs/fork-patches.tsv");
  const table = tables(rows, base);
  if (args.includes("--write")) {
    fs.writeFileSync(tsvPath, tsv);
    const mdPath = path.join(root, "docs/fork-patches.md");
    const md = fs.readFileSync(mdPath, "utf8");
    fs.writeFileSync(mdPath, md.replace(/<!-- ledger:start[\s\S]*?<!-- ledger:end -->/, table));
  } else if (args.includes("--check")) {
    if (!fs.existsSync(tsvPath) || fs.readFileSync(tsvPath, "utf8") !== tsv) {
      console.error(
        "docs/fork-patches.tsv is stale: run node scripts/fork-ledger.mjs --write and review the change",
      );
      process.exit(1);
    }
  } else console.log(table);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
