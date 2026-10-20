import { execGitCommand } from "@getpaseo/plugin/server/git";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import type { PaseoApi, PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { matchesHumanOwner, type BoardItem, type ProgressBoard } from "../shared/progress-board";
import { scrubFreeText } from "../shared/privacy-scrub";
import { createRefreshGate, type RefreshGateTimers } from "../shared/refresh-gate";

const COLUMNS = ["id", "item", "kind", "owner", "status", "evidence", "source"] as const;
// Request dates do not date completion. Explicit close records take priority.
export function ledgerDate(text: string): string | undefined {
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (!date) return undefined;
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date
    ? new Date(at).toISOString()
    : undefined;
}

export function parseLedger(
  text: string,
  humanOwners: readonly string[] = [],
): { items: BoardItem[]; malformed: number } {
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
    const cell = (index: number) => scrubFreeText(cells[index]!, null);
    const row: BoardItem = {
      id: cell(0),
      item: cell(1),
      kind: cell(2),
      owner: cell(3),
      status: cell(4),
      evidence: cell(5),
      source: cell(6),
    };
    // Source dates describe the request; evidence prose does not reliably date completion.
    row.createdAt = ledgerDate(row.source);
    // Only labelled transition dates qualify; dates in PR prose do not date the closure.
    const transition = (label: string) => {
      const match = cells
        .slice(4, 6)
        .join(" ")
        .match(
          new RegExp(
            `\\b${label}\\s*(?:at|on|since)?\\s*[:=]?\\s*(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)`,
            "i",
          ),
        );
      return match && Number.isFinite(Date.parse(match[1]!)) ? match[1] : undefined;
    };
    row.completedAt = transition("(?:closed|completed)");
    if (row.completedAt) row.completedSource = "record";
    row.blockedAt = transition("blocked");
    // Match original labels. Redaction can map different owners to the same display text.
    row.needsHuman = matchesHumanOwner(cells[3]!, humanOwners);
    items.push(row);
  }
  if (text.trim() && !header) malformed++;
  return { items, malformed };
}

export function oneLine(text: string): string | null {
  const first = text
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim() && !/^[-_*=#]{2,}$/.test(line.trim()))
    ?.replace(/\s+/g, " ");
  return first ? scrubFreeText(first, null).slice(0, 320) : null;
}

export function jobList(
  agents: readonly PaseoAgent[],
  workspaceIds: ReadonlySet<string>,
  machine: string,
  results: ReadonlyMap<string, string>,
  projectName?: string,
  workspaceOwners?: ReadonlyMap<string, string | null>,
) {
  return agents
    .filter(
      (a) =>
        !a.archivedAt &&
        (projectName
          ? a.labels?.["project"]?.trim() || a.labels?.["fulcra.project"]?.trim()
            ? (a.labels?.["project"]?.trim() || a.labels?.["fulcra.project"]?.trim()) ===
              projectName
            : !!a.workspaceId &&
              workspaceIds.has(a.workspaceId) &&
              workspaceOwners?.get(a.workspaceId) === projectName
          : !!a.workspaceId && workspaceIds.has(a.workspaceId)),
    )
    .map((a) => ({
      id: a.id,
      title: scrubFreeText(a.title ?? "Untitled job", null),
      status: a.labels?.["fulcra.hold"] === "done" ? "done" : a.status,
      machine: scrubFreeText(machine, null),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      permissions: a.pendingPermissions.length,
      model: a.model ?? null,
      startedAt: a.activeTurn?.startedAt ?? null,
      result: oneLine(results.get(a.id) ?? a.lastError ?? ""),
    }));
}

export type RunRead = (command: string, args: string[], cwd: string) => Promise<string>;
export const runRead: RunRead = (command, args, cwd) =>
  command === "git"
    ? execGitCommand(args, { cwd, timeout: 4000, maxBuffer: 8 * 1024 * 1024 }).then(
        (result) => result.stdout,
      )
    : new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          {
            cwd,
            timeout: 4000,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });

export async function ledgerLineDates(file: string, run = runRead): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  try {
    const name = path.basename(file),
      cwd = path.dirname(file);
    let text: string;
    try {
      text = await run("git", ["blame", "--line-porcelain", "HEAD", "--", name], cwd);
    } catch {
      // The current copy can be untracked after a ledger was removed from the vault.
      const revision = (
        await run(
          "git",
          ["log", "-1", "--format=%H", "--diff-filter=AM", "--no-renames", "--", name],
          cwd,
        )
      ).trim();
      if (!/^[a-f0-9]{40}$/.test(revision)) return dates;
      text = await run("git", ["blame", "--line-porcelain", revision, "--", name], cwd);
    }
    let committed = false,
      at: string | undefined;
    for (const line of text.split("\n")) {
      if (/^[a-f0-9]{40} \d+ \d+/.test(line)) {
        committed = !line.startsWith("0".repeat(40));
        at = undefined;
      } else if (line.startsWith("committer-time ")) {
        const seconds = Number(line.slice(15));
        if (Number.isFinite(seconds)) at = new Date(seconds * 1000).toISOString();
      } else if (line.startsWith("\t") && committed && at) {
        const cells = line
          .slice(1)
          .trim()
          .replace(/^\||\|$/g, "")
          .split(/(?<!\\)\|/)
          .map((c) => c.trim());
        if (cells.length === 7 && /^(DONE|BLOCKED)\b/i.test(cells[4]!)) dates.set(cells[0]!, at);
      }
    }
  } catch {
    /* A file without committed rows cannot supply completion dates. */
  }
  return dates;
}

export async function dateLedgerItems(
  items: BoardItem[],
  file: string,
  mtime: string,
  run = runRead,
): Promise<BoardItem[]> {
  if (
    !items.some(
      (item) =>
        (/^DONE\b/i.test(item.status) && item.completedSource !== "record") ||
        (/^BLOCKED\b/i.test(item.status) && !item.blockedAt),
    )
  )
    return items;
  const dates = await ledgerLineDates(file, run);
  return items.map((item) => {
    const at = dates.get(item.id);
    if (/^DONE\b/i.test(item.status) && item.completedSource !== "record")
      return { ...item, completedAt: at, completedSource: at ? "git" : undefined };
    if (/^BLOCKED\b/i.test(item.status) && !item.blockedAt)
      return { ...item, blockedAt: at ?? mtime, blockedApprox: true };
    return item;
  });
}

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

/** One board rebuild a window, for all changes in it (FU-412: at most one each 30 to 60 s). */
const BOARD_WINDOW_MS = 30_000;

/**
 * What a running session is doing, from its record alone. The board never reads a session timeline:
 * each read replays that session's journal from disk (FU-412).
 */
function activityOf(agent: PaseoAgent): string | null {
  if (agent.pendingPermissions.length) return "Waiting for permission";
  if (agent.status === "initializing") return "Starting the session";
  if (agent.status === "running") return "Working on the task";
  return null;
}

export function createProgressBoard(
  server: Pick<PluginServerContext, "on">,
  options: {
    root?: string;
    machine?: string;
    run?: RunRead;
    humanOwners?: () => readonly string[];
    historyFile?: string;
    /** Test seam: the batch timer. */
    timers?: RefreshGateTimers;
  } = {},
) {
  const root =
    options.root ??
    (process.env.FULCRA_LEDGER_DIR?.trim() || path.join(os.homedir(), "shared-vault", "projects"));
  const historyFile = options.historyFile;
  type Transition = {
    status: string;
    observedAt?: string;
    completedAt?: string;
    blockedAt?: string;
  };
  let transitions: Record<string, Transition> = {};
  if (historyFile) {
    try {
      const stat = fs.lstatSync(historyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152)
        throw Error("Invalid cache");
      const fd = fs.openSync(historyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
      if (saved.version === 1 && saved.rows && typeof saved.rows === "object")
        transitions = saved.rows;
    } catch {
      /* The first observation cannot date old work. */
    }
  }
  function track(
    name: string,
    item: BoardItem,
    observedAt: string,
    watchedChange = false,
  ): BoardItem {
    const key = `${name}:${item.id}`;
    const previous = Object.hasOwn(transitions, key) ? transitions[key] : undefined;
    const continuous =
      watchedChange ||
      (previous?.observedAt && Date.parse(observedAt) - Date.parse(previous.observedAt) <= 60000);
    const done = /^DONE\b/i.test(item.status);
    const blocked = /^BLOCKED\b/i.test(item.status);
    const completedAt = done && item.completedSource === "record" ? item.completedAt : undefined;
    const blockedAt = blocked
      ? (item.blockedAt ??
        previous?.blockedAt ??
        (continuous && previous && !/^BLOCKED\b/i.test(previous.status) ? observedAt : undefined))
      : undefined;
    transitions[key] = { status: item.status, observedAt, completedAt, blockedAt };
    return { ...item, completedAt, blockedAt };
  }
  let historyUnavailable = false;
  function saveHistory() {
    if (!historyFile) return;
    const temporary = `${historyFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, rows: transitions }), {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporary, historyFile);
      historyUnavailable = false;
    } catch {
      historyUnavailable = true;
    }
  }
  function observeFile(name: string, watchedChange: boolean) {
    if (!historyFile) return;
    try {
      const file = path.join(root, name, "OPEN-ITEMS.md"),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152) return;
      const rows = parseLedger(fs.readFileSync(file, "utf8")).items;
      const at = new Date().toISOString();
      rows.forEach((item) => track(name, item, at, watchedChange));
      saveHistory();
    } catch {
      /* A missing or unreadable list cannot supply a date. */
    }
  }
  // The last reply of each session, from turn events. A new turn replaces it with live activity.
  const results = new Map<string, string>();
  const ledgers = new Map<string, { items: BoardItem[]; state: string; signature?: string }>();
  // Status changes of any session. Each one marks the board changed; nothing else does.
  const hooks = [
    server.on("agent.turn_started", (event, context) => {
      results.delete(event.agent.id);
      changed(context?.paseo);
    }),
    ...(
      [
        "agent.permission_requested",
        "agent.permission_resolved",
        "agent.archived",
        "agent.created",
        "agent.closed",
        "workspace.created",
        "workspace.archived",
      ] as const
    ).map((name) => server.on(name, (_event, context) => changed(context?.paseo))),
    server.on("agent.turn_ended", (event, context) => {
      changed(context?.paseo);
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
  const watched = new Set<string>();
  function watch(directory: string, key?: string) {
    try {
      const watcher = fs.watch(directory, () => {
        if (key) {
          observeFile(key, true);
          ledgers.delete(key);
        } else {
          discoverLedgers();
          ledgers.clear();
        }
        changed();
      });
      watcher.on("error", () => {
        watcher.close();
        ledgers.clear();
      });
      watchers.push(watcher);
    } catch {
      /* Snapshot stat checks also detect changes when watching is unavailable. */
    }
  }
  function discoverLedgers() {
    if (!historyFile) return;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || watched.has(entry.name)) continue;
        observeFile(entry.name, false);
        watch(path.join(root, entry.name), entry.name);
        watched.add(entry.name);
      }
    } catch {
      /* Snapshot reads name unavailable project lists. */
    }
  }
  watch(root);
  discoverLedgers();
  const dated = new Map<string, { signature: string | undefined; items: BoardItem[] }>();
  let flight: Promise<ProgressBoard> | undefined;
  let ownerSignature: string | undefined;
  // The last board, rebuilt at most once a window and only after a change (FU-412).
  let board: ProgressBoard | undefined;
  let dirty = false;
  let latest: PaseoApi | undefined;
  const gate = createRefreshGate(
    () => {
      if (latest) void rebuild(latest).catch(() => undefined);
    },
    BOARD_WINDOW_MS,
    options.timers,
  );
  function changed(paseo?: PaseoApi) {
    if (paseo) latest = paseo;
    dirty = true;
    gate.changed();
  }
  function snapshot(paseo: PaseoApi): Promise<ProgressBoard> {
    return (
      flight ??
      (flight = compute(paseo).finally(() => {
        flight = undefined;
      }))
    );
  }
  async function rebuild(paseo: PaseoApi): Promise<ProgressBoard> {
    dirty = false;
    try {
      board = await snapshot(paseo);
      return board;
    } catch (error) {
      dirty = true;
      throw error;
    }
  }
  function ownersChanged(): boolean {
    const humanOwners = options.humanOwners?.() ?? [];
    return (
      JSON.stringify(humanOwners.map((owner) => owner.trim().toLowerCase()).sort()) !==
      ownerSignature
    );
  }
  async function compute(paseo: PaseoApi): Promise<ProgressBoard> {
    const humanOwners = options.humanOwners?.() ?? [];
    const signature = JSON.stringify(humanOwners.map((owner) => owner.trim().toLowerCase()).sort());
    if (signature !== ownerSignature) {
      ledgers.clear();
      dated.clear();
      ownerSignature = signature;
    }
    const warnings: string[] = [];
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => d.name)
        .sort();
    } catch (error) {
      warnings.push(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "This computer has no project lists."
          : "Project lists cannot be read on this computer.",
      );
    }
    const [workspaces, agents] = await Promise.all([
      paseo.workspaces.list({ page: { limit: 100 } }),
      paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: 100 },
        sort: [{ key: "updated_at", direction: "desc" }],
      }),
    ]);
    while (workspaces.pageInfo.hasMore && workspaces.pageInfo.nextCursor) {
      const next = await paseo.workspaces.list({
        page: { limit: 100, cursor: workspaces.pageInfo.nextCursor },
      });
      workspaces.entries.push(...next.entries);
      workspaces.pageInfo = next.pageInfo;
    }
    while (agents.pageInfo.hasMore && agents.pageInfo.nextCursor) {
      const next = await paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: 100, cursor: agents.pageInfo.nextCursor },
        sort: [{ key: "updated_at", direction: "desc" }],
      });
      agents.entries.push(...next.entries);
      agents.pageInfo = next.pageInfo;
    }
    if (workspaces.pageInfo.hasMore || agents.pageInfo.hasMore)
      warnings.push("More workspaces or jobs could not be read on this host.");
    const agentRows = agents.entries.map((entry) => entry.agent).filter((a) => !a.archivedAt);
    const workspaceById = new Map(workspaces.entries.map((w) => [w.id, w]));
    // Each session has exactly one project. A session without a workspace is still visible.
    const projectOf = (a: PaseoAgent) => {
      const label = a.labels?.["project"]?.trim() || a.labels?.["fulcra.project"]?.trim();
      if (label) return label;
      const workspace = a.workspaceId ? workspaceById.get(a.workspaceId) : undefined;
      if (!workspace) return "Other sessions";
      const name = workspace.projectDisplayName;
      return (
        names.find(
          (n) =>
            n.toLowerCase() === name.toLowerCase() ||
            n.toLowerCase() === path.basename(workspace.projectRootPath).toLowerCase(),
        ) ?? (/^[a-f0-9-]{24,}$/i.test(name) ? "Other sessions" : name)
      );
    };
    names = names.filter((name) => {
      try {
        return fs.lstatSync(path.join(root, name, "OPEN-ITEMS.md")).isFile();
      } catch {
        return false;
      }
    });
    const projectNames = new Set([
      ...names,
      ...agentRows
        .filter((a) => a.status === "running" || a.status === "initializing")
        .map(projectOf),
    ]);
    const previousTransitions = JSON.stringify(transitions);
    const observedAt = new Date().toISOString();
    const projects: ProgressBoard["projects"] = [];
    for (const name of [...projectNames].sort()) {
      const projectAgents = agentRows.filter((a) => projectOf(a) === name);
      const file = path.join(root, name, "OPEN-ITEMS.md");
      let signature: string | undefined;
      try {
        if (!names.includes(name)) throw Error("No ledger");
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152)
          throw Error("Invalid ledger");
        signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (ledgers.get(name)?.signature !== signature) {
          const parsed = parseLedger(fs.readFileSync(file, "utf8"), humanOwners);
          ledgers.set(name, {
            items: parsed.items,
            signature,
            state: parsed.malformed
              ? `${parsed.malformed} unreadable rows`
              : parsed.items.length
                ? "Current"
                : "Empty ledger",
          });
        }
        if (!watched.has(name)) {
          watch(path.dirname(file), name);
          watched.add(name);
        }
      } catch {
        ledgers.set(name, {
          items: [],
          state: "No readable ledger for this project on this computer.",
        });
      }
      const ledger = ledgers.get(name)!;
      const tracked = ledger.items.map((item) => track(name, item, observedAt));
      if (dated.get(name)?.signature !== signature || !dated.has(name)) {
        dated.set(name, {
          signature,
          items: names.includes(name)
            ? await dateLedgerItems(
                tracked,
                file,
                new Date(fs.statSync(file).mtimeMs).toISOString(),
                options.run,
              )
            : tracked,
        });
      }
      const items = dated.get(name)!.items;
      const jobs = projectAgents.map((a) => ({
        id: a.id,
        title: scrubFreeText(a.title ?? "Untitled session", null),
        status: a.status,
        machine: "This computer",
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        startedAt: a.activeTurn?.startedAt ?? null,
        model: a.model ?? null,
        permissions: a.pendingPermissions.length,
        result: oneLine(results.get(a.id) ?? a.lastError ?? activityOf(a) ?? ""),
      }));
      projects.push({
        id: name,
        name,
        ledgerState: ledger.state,
        ledgerUpdatedAt: names.includes(name)
          ? new Date(fs.statSync(file).mtimeMs).toISOString()
          : undefined,
        items,
        jobs,
        branches: [],
      });
    }
    if (previousTransitions !== JSON.stringify(transitions)) saveHistory();
    if (historyUnavailable)
      warnings.push("Completion history could not be saved. Dates may be missing after a restart.");
    const scrub = (value: string) => scrubFreeText(value, null);
    return {
      observedAt: new Date().toISOString(),
      machine: "This computer",
      projects: projects.map((project) => ({
        ...project,
        id: scrub(project.id),
        name: scrub(project.name),
        jobs: project.jobs.map((job) => ({
          ...job,
          id: scrub(job.id),
          title: scrub(job.title),
          machine: scrub(job.machine),
          result: job.result === null ? null : scrub(job.result),
        })),
        branches: project.branches.map((branch) => ({
          ...branch,
          workspace: scrub(branch.workspace),
          branch: branch.branch === null ? null : scrub(branch.branch),
        })),
      })),
      warnings: warnings.map(scrub),
    };
  }
  return {
    /**
     * The board as of the last change. It is built on the first read, then only by the batch timer
     * after a change, or by a read that finds a change the timer could not build.
     */
    read(paseo: PaseoApi): Promise<ProgressBoard> {
      latest = paseo;
      if (flight) return flight;
      if (!board || (dirty && !gate.pending) || ownersChanged()) return rebuild(paseo);
      return Promise.resolve(board);
    },
    /** Builds the board now, without the cache. */
    snapshot,
    close() {
      gate.close();
      hooks.forEach((stop) => stop());
      watchers.forEach((w) => w.close());
      results.clear();
      ledgers.clear();
    },
  };
}
