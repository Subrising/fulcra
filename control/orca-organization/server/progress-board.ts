import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import type { PaseoApi, PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { BoardItem, ProgressBoard } from "../shared/progress-board";

const COLUMNS = ["id", "item", "kind", "owner", "status", "evidence", "source"] as const;
export function parseLedger(text: string): { items: BoardItem[]; malformed: number } {
  const items: BoardItem[] = [];
  let header = false,
    malformed = 0;
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "|"));
    if (cells.join("|").toLowerCase() === COLUMNS.join("|")) {
      header = true;
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!header) continue;
    if (cells.length !== 7 || !cells[0] || !cells[1] || !cells[4] || ids.has(cells[0]!)) {
      malformed++;
      continue;
    }
    ids.add(cells[0]!);
    items.push(Object.fromEntries(COLUMNS.map((key, i) => [key, cells[i]!])) as BoardItem);
  }
  if (text.trim() && !header) malformed++;
  return { items, malformed };
}

export function oneLine(text: string): string | null {
  return (
    text
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.replace(/\s+/g, " ")
      .slice(0, 320) ?? null
  );
}

export function jobList(
  agents: readonly PaseoAgent[],
  workspaceIds: ReadonlySet<string>,
  machine: string,
  results: ReadonlyMap<string, string>,
) {
  return agents
    .filter((a) => !a.archivedAt && !!a.workspaceId && workspaceIds.has(a.workspaceId))
    .map((a) => ({
      id: a.id,
      title: a.title ?? "Untitled job",
      status: a.status,
      machine,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      permissions: a.pendingPermissions.length,
      result: results.get(a.id) ?? (a.lastError ? oneLine(a.lastError) : null),
    }));
}

export type RunRead = (command: string, args: string[], cwd: string) => Promise<string>;
export const runRead: RunRead = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: 4000,
        maxBuffer: 262144,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export async function readBranch(
  workspace: PaseoWorkspace,
  run = runRead,
): Promise<ProgressBoard["projects"][number]["branches"][number]> {
  const cwd = workspace.workspaceDirectory ?? workspace.projectRootPath;
  const row = {
    workspace: workspace.name,
    branch: null as string | null,
    head: null as string | null,
    state: "Git unavailable",
    ci: "Unavailable",
    observedAt: new Date().toISOString(),
  };
  try {
    const lines = (await run("git", ["log", "-1", "--format=%H%n%D"], cwd)).trim().split("\n");
    row.head = lines[0] ?? null;
    row.branch = (
      await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd).catch(
        () => "Detached HEAD",
      )
    ).trim();
    row.state = "Local branch";
    if (row.branch === "Detached HEAD") return row;
    try {
      const prs = JSON.parse(
        await run(
          "gh",
          [
            "pr",
            "list",
            "--head",
            row.branch,
            "--state",
            "all",
            "--limit",
            "1",
            "--json",
            "state,headRefOid,statusCheckRollup",
          ],
          cwd,
        ),
      );
      const pr = prs[0];
      if (pr) {
        row.state =
          pr.state === "MERGED" ? "Merged" : pr.state === "OPEN" ? "Open PR" : "Closed PR";
        if (pr.headRefOid !== row.head) {
          row.state = "PR has another head";
          row.ci = "PR head differs";
        } else {
          const checks: Array<{ conclusion?: string; status?: string; state?: string }> =
            pr.statusCheckRollup ?? [];
          row.ci = !checks.length
            ? "No checks"
            : checks.some((c) =>
                  [
                    "FAILURE",
                    "ERROR",
                    "CANCELLED",
                    "TIMED_OUT",
                    "ACTION_REQUIRED",
                    "STARTUP_FAILURE",
                  ].includes(c.conclusion ?? c.state ?? ""),
                )
              ? "Failed"
              : checks.every((c) =>
                    ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? c.state ?? ""),
                  )
                ? "Passed"
                : "Pending";
        }
      } else row.state = "No PR";
    } catch {
      row.state = "PR unavailable";
    }
  } catch {
    /* Keep explicit unavailable state. */
  }
  return row;
}

export function createProgressBoard(
  server: Pick<PluginServerContext, "on">,
  options: { root?: string; machine?: string; run?: RunRead } = {},
) {
  const root = options.root ?? path.join(os.homedir(), "shared-vault", "projects");
  const machine = options.machine ?? os.hostname();
  const results = new Map<string, string>();
  const ledgers = new Map<string, { items: BoardItem[]; state: string; signature?: string }>();
  const branches = new Map<string, { at: number; row: Awaited<ReturnType<typeof readBranch>> }>();
  const pending = new Set<string>();
  const attemptedResults = new Set<string>();
  const queue: Array<() => Promise<void>> = [];
  let active = 0;
  let closed = false;
  function enqueue(work: () => Promise<void>) {
    queue.push(work);
    drain();
  }
  function drain() {
    if (closed) return;
    while (active < 2 && queue.length) {
      active++;
      void queue.shift()!().finally(() => {
        active--;
        drain();
      });
    }
  }
  const hooks = [
    server.on("agent.turn_ended", (event) => {
      const last = event.timeline.toReversed().find((entry) => entry.type === "assistant_message");
      const text =
        last?.type === "assistant_message"
          ? oneLine(last.text)
          : event.outcome.kind === "failed"
            ? oneLine(event.outcome.error.message)
            : null;
      if (text) results.set(event.agent.id, text);
    }),
  ];
  const watchers: fs.FSWatcher[] = [];
  function watch(directory: string, key?: string) {
    try {
      const watcher = fs.watch(directory, () => (key ? ledgers.delete(key) : ledgers.clear()));
      watcher.on("error", () => {
        watcher.close();
        ledgers.clear();
      });
      watchers.push(watcher);
    } catch {
      /* Snapshot stat checks also detect changes when watching is unavailable. */
    }
  }
  watch(root);
  const watched = new Set<string>();
  let flight: Promise<ProgressBoard> | undefined;
  async function read(paseo: PaseoApi): Promise<ProgressBoard> {
    const warnings: string[] = [];
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => d.name)
        .sort();
    } catch {
      warnings.push("Ledger directory unavailable on this host.");
    }
    const [workspaces, agents] = await Promise.all([
      paseo.workspaces.list({ page: { limit: 100 } }),
      paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: 100 },
        sort: [{ key: "updated_at", direction: "desc" }],
      }),
    ]);
    if (workspaces.pageInfo.hasMore || agents.pageInfo.hasMore)
      warnings.push("Showing the first 100 workspaces and jobs on this host.");
    const groups = new Map<string, PaseoWorkspace[]>();
    for (const w of workspaces.entries) {
      const name = w.projectDisplayName;
      const key =
        names.find(
          (n) =>
            n.toLowerCase() === name.toLowerCase() ||
            n.toLowerCase() === path.basename(w.projectRootPath).toLowerCase(),
        ) ?? name;
      groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    const projects: ProgressBoard["projects"] = [];
    const agentWorkspaceIds = new Set(agents.entries.map((e) => e.agent.workspaceId));
    const candidates = [...groups]
      .filter(
        ([name, work]) => names.includes(name) || work.some((w) => agentWorkspaceIds.has(w.id)),
      )
      .flatMap(([, work]) => work.slice(0, 16));
    const branchKeys = [
      ...new Set(candidates.map((w) => w.workspaceDirectory ?? w.projectRootPath)),
    ];
    const scheduled = new Set(
      branchKeys
        .filter(
          (key) =>
            !pending.has(key) &&
            (!branches.has(key) || Date.now() - branches.get(key)!.at >= 60000),
        )
        .sort((a, b) => (branches.get(a)?.at ?? 0) - (branches.get(b)?.at ?? 0))
        .slice(0, 16),
    );
    for (const name of [...new Set([...names, ...groups.keys()])].sort()) {
      const work = groups.get(name) ?? [];
      const jobRows = jobList(
        agents.entries.map((e) => e.agent),
        new Set(work.map((w) => w.id)),
        machine,
        results,
      );
      if (!names.includes(name) && !jobRows.length) continue;
      let signature: string | undefined;
      if (names.includes(name)) {
        try {
          const stat = fs.lstatSync(path.join(root, name, "OPEN-ITEMS.md"));
          signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch {
          /* Missing file is shown below. */
        }
      }
      if (!signature || ledgers.get(name)?.signature !== signature) ledgers.delete(name);
      if (!ledgers.has(name)) {
        try {
          if (!names.includes(name)) throw Error("No ledger");
          const file = path.join(root, name, "OPEN-ITEMS.md");
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152)
            throw Error("Invalid ledger");
          const parsed = parseLedger(fs.readFileSync(file, "utf8"));
          ledgers.set(name, {
            items: parsed.items,
            signature,
            state: parsed.malformed
              ? `${parsed.malformed} invalid rows skipped`
              : parsed.items.length
                ? "Current"
                : "Empty ledger",
          });
          if (!watched.has(name)) {
            watch(path.dirname(file), name);
            watched.add(name);
          }
        } catch {
          ledgers.set(name, { items: [], state: "Ledger unavailable" });
        }
      }
      const ledger = ledgers.get(name)!;
      for (const a of agents.entries
        .map((e) => e.agent)
        .filter(
          (a) => jobRows.some((j) => j.id === a.id) && a.status !== "running" && !results.has(a.id),
        )) {
        const key = `result:${a.id}`;
        if (!attemptedResults.has(key)) {
          attemptedResults.add(key);
          pending.add(key);
          enqueue(() =>
            paseo.agents
              .ref(a.id)
              .timeline.refetch({ limit: 20 })
              .then((page) => {
                const last = page.entries
                  .toReversed()
                  .find((e) => e.item.type === "assistant_message");
                if (!closed && last?.item.type === "assistant_message") {
                  const text = oneLine(last.item.text);
                  if (text) results.set(a.id, text);
                }
              })
              .catch(() => {})
              .finally(() => pending.delete(key)),
          );
        }
      }
      const branchRows = work.slice(0, 16).map((w) => {
        const key = w.workspaceDirectory ?? w.projectRootPath;
        const cached = branches.get(key);
        if (scheduled.has(key) && !pending.has(key)) {
          pending.add(key);
          enqueue(() =>
            readBranch(w, options.run)
              .then((row) => {
                if (!closed) branches.set(key, { row, at: Date.now() });
              })
              .finally(() => pending.delete(key)),
          );
        }
        return (
          cached?.row ?? {
            workspace: w.name,
            branch: null,
            head: null,
            state: "Reading branch",
            ci: "Unavailable",
            observedAt: null,
          }
        );
      });
      if (work.length > 16) warnings.push(`${name}: showing the first 16 branches.`);
      projects.push({
        id: name,
        name,
        ledgerState: ledger.state,
        items: ledger.items,
        jobs: jobRows,
        branches: branchRows,
      });
    }
    return { observedAt: new Date().toISOString(), machine, projects, warnings };
  }
  return {
    read(paseo: PaseoApi) {
      return (
        flight ??
        (flight = read(paseo).finally(() => {
          flight = undefined;
        }))
      );
    },
    close() {
      closed = true;
      queue.length = 0;
      hooks.forEach((stop) => stop());
      watchers.forEach((w) => w.close());
      results.clear();
      branches.clear();
      ledgers.clear();
    },
  };
}
