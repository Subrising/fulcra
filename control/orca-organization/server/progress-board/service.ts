import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PaseoApi, PaseoAgentListResult } from "@getpaseo/client";
import type { ProgressBoard, Branch } from "../../shared/progress-board";
import { adaptJobs, parseLedger, projectKey } from "./adapters";
import { readBranch } from "./git";

const MAX_BYTES = 512 * 1024;
export class ProgressBoardService {
  private revision = 1;
  private closed = false;
  private watchers = new Map<string, FSWatcher>();
  private waiters = new Set<() => void>();
  private entries = new Map<string, PaseoAgentListResult["entries"][number]>();
  private results = new Map<string, string>();
  private branches = new Map<string, Branch>();
  private ledger: ProgressBoard["projects"] = [];
  private ledgerDirty = true;
  private notice = "";
  private ledgerNotice = "";
  private partial = false;
  private starting?: Promise<void>;
  private loading?: Promise<void>;
  private stopJobs?: () => void;
  private gitRunning = false;
  private lastGit = 0;
  private save: Promise<void> = Promise.resolve();
  constructor(
    private root = process.env.FULCRA_LEDGER_DIR ||
      path.join(homedir(), "shared-vault", "projects"),
    private stateFile = process.env.PASEO_HOME
      ? path.join(process.env.PASEO_HOME, "progress-board-results.json")
      : null,
    private branchReader = readBranch,
  ) {}
  private changed() {
    this.revision++;
    for (const wake of [...this.waiters]) wake();
  }
  watchRevision(revision: number): Promise<{ revision: number }> {
    if (revision !== this.revision || this.closed)
      return Promise.resolve({ revision: this.revision });
    if (this.waiters.size >= 64)
      return Promise.reject(new Error("The board has too many observers."));
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve({ revision: this.revision });
      };
      const timer = setTimeout(wake, 20000);
      this.waiters.add(wake);
    });
  }
  recordResult(id: string, result: string) {
    this.results.delete(id);
    this.results.set(id, result.slice(0, 280));
    while (this.results.size > 2000) this.results.delete(this.results.keys().next().value!);
    this.changed();
    if (!this.stateFile) return Promise.resolve();
    const file = this.stateFile;
    const text = JSON.stringify(Object.fromEntries(this.results));
    this.save = this.save
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, text, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      })
      .catch(() => {
        this.notice = "Job results could not be saved.";
        this.changed();
      });
    return this.save;
  }
  private watchDirectory(directory: string) {
    if (this.watchers.has(directory)) return;
    try {
      const watcher = watch(directory, (_event, name) => {
        if (!name || directory === this.root || name.toString() === "OPEN-ITEMS.md") {
          this.ledgerDirty = true;
          this.changed();
        }
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(directory);
        this.notice = "Ledger events are unavailable. Use Refresh.";
        this.changed();
      });
      this.watchers.set(directory, watcher);
    } catch {
      this.notice = "Ledger events are unavailable. Use Refresh.";
    }
  }
  private async start(api: PaseoApi) {
    if (this.closed) throw new Error("The progress board is closed.");
    if (this.stateFile) {
      try {
        const values: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
        if (values && typeof values === "object" && !Array.isArray(values)) {
          for (const [id, result] of Object.entries(values).slice(-2000))
            if (typeof result === "string" && !this.results.has(id))
              this.results.set(id, result.slice(0, 280));
        }
      } catch {
        /* Missing prior results leave each job's empty state visible. */
      }
    }
    const first = await api.agents.list({
      filter: { includeArchived: false },
      page: { limit: 200 },
      subscribe: {},
    });
    if (this.closed) {
      first.subscription.release();
      return;
    }
    for (const entry of first.entries) this.entries.set(entry.agent.id, entry);
    let cursor = first.pageInfo.nextCursor,
      more = first.pageInfo.hasMore;
    const stop = first.subscription.subscribe({
      snapshot: (snapshot) => {
        this.entries.clear();
        this.partial = snapshot.pageInfo.hasMore;
        for (const entry of snapshot.entries) this.entries.set(entry.agent.id, entry);
        this.changed();
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "remove" || update.agent.archivedAt)
          this.entries.delete(update.kind === "remove" ? update.agentId : update.agent.id);
        else {
          const project = update.project ?? this.entries.get(update.agent.id)?.project;
          if (project) this.entries.set(update.agent.id, { agent: update.agent, project });
        }
        this.changed();
      },
      error: () => {
        this.stopJobs?.();
        this.stopJobs = undefined;
        this.starting = undefined;
        this.partial = true;
        this.notice = "Job events are unavailable. Use Refresh to reconnect.";
        this.changed();
      },
    });
    this.stopJobs = () => {
      stop();
      first.subscription.release();
    };
    for (let page = 1; more && cursor && page < 10 && !this.closed; page++) {
      const next = await api.agents.list({
        filter: { includeArchived: false },
        page: { limit: 200, cursor },
      });
      for (const entry of next.entries)
        if (!this.entries.has(entry.agent.id)) this.entries.set(entry.agent.id, entry);
      more = next.pageInfo.hasMore;
      if (next.pageInfo.nextCursor === cursor) break;
      cursor = next.pageInfo.nextCursor;
    }
    this.partial = more;
    this.changed();
  }
  private async loadLedger() {
    this.ledgerDirty = false;
    let folders;
    try {
      folders = await readdir(this.root, { withFileTypes: true });
    } catch {
      this.ledger = [];
      this.ledgerDirty = true;
      this.ledgerNotice = "The ledger directory is unavailable on this host.";
      for (const watcher of this.watchers.values()) watcher.close();
      this.watchers.clear();
      return;
    }
    this.ledgerNotice = "";
    this.watchDirectory(this.root);
    const projects: ProgressBoard["projects"] = [];
    for (const folder of folders.filter((entry) => entry.isDirectory()).slice(0, 128)) {
      const directory = path.join(this.root, folder.name);
      this.watchDirectory(directory);
      let parsed;
      try {
        const handle = await open(path.join(directory, "OPEN-ITEMS.md"), "r");
        try {
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          parsed =
            bytesRead > MAX_BYTES
              ? { items: [], notice: "The ledger exceeds the size limit." }
              : parseLedger(bytes.subarray(0, bytesRead).toString("utf8"));
        } finally {
          await handle.close();
        }
      } catch {
        parsed = { items: [], notice: "The ledger file is unavailable." };
      }
      if (parsed.items.length > 2000)
        parsed = {
          items: parsed.items.slice(0, 2000),
          notice: "The ledger item limit was reached.",
        };
      projects.push({
        id: projectKey(folder.name),
        name: folder.name,
        ...parsed,
        jobs: [],
        branches: [],
      });
    }
    this.ledger = projects;
    const active = new Set([
      this.root,
      ...folders
        .filter((entry) => entry.isDirectory())
        .slice(0, 128)
        .map((folder) => path.join(this.root, folder.name)),
    ]);
    for (const [directory, watcher] of this.watchers)
      if (!active.has(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    if (folders.length > 128) this.ledgerNotice = "The project limit was reached.";
  }
  private refreshGit(directories: string[]) {
    if (this.gitRunning || Date.now() - this.lastGit < 60000) return;
    if (!directories.length) return;
    this.gitRunning = true;
    this.lastGit = Date.now();
    const queue = directories.slice(0, 32);
    if (directories.length > 32) this.partial = true;
    void Promise.all(
      Array.from({ length: 4 }, async () => {
        while (queue.length && !this.closed) {
          const directory = queue.shift()!;
          try {
            this.branches.set(directory, await this.branchReader(directory));
          } catch {
            this.branches.set(directory, {
              directory,
              branch: "Unavailable",
              head: "",
              state: "Unavailable",
              ci: "Unavailable",
              checkedAt: new Date().toISOString(),
            });
          }
        }
      }),
    ).finally(() => {
      this.gitRunning = false;
      if (!this.closed) this.changed();
    });
  }
  async read(api: PaseoApi, machine: string): Promise<ProgressBoard> {
    this.starting ??= this.start(api).catch((error) => {
      this.starting = undefined;
      throw error;
    });
    await this.starting;
    if (this.ledgerDirty) {
      this.loading ??= this.loadLedger().finally(() => {
        this.loading = undefined;
      });
      await this.loading;
    }
    const jobs = adaptJobs([...this.entries.values()], machine, this.results);
    this.refreshGit([...new Set(jobs.map((job) => job.directory))]);
    const projects = this.ledger.map((project) => ({
      ...project,
      jobs: [] as typeof jobs,
      branches: [] as Branch[],
    }));
    for (const job of jobs) {
      let project = projects.find((row) => row.id === job.project);
      if (!project) {
        const owned = projects.filter((row) =>
          row.items.some(
            (item) =>
              item.owner.toLowerCase().includes(`(${job.id.slice(0, 8).toLowerCase()})`) ||
              (job.title.length >= 4 && item.owner.toLowerCase() === job.title.toLowerCase()),
          ),
        );
        if (owned.length === 1) project = owned[0];
      }
      if (!project) {
        project = {
          id: job.project,
          name: job.project || "Other jobs",
          notice: "No matching ledger was found.",
          items: [],
          jobs: [],
          branches: [],
        };
        projects.push(project);
      }
      project.jobs.push(job);
      const branch = this.branches.get(job.directory);
      if (branch && !project.branches.some((row) => row.directory === branch.directory))
        project.branches.push(branch);
    }
    return {
      revision: this.revision,
      observedAt: new Date().toISOString(),
      partial: this.partial,
      notice: [this.notice, this.ledgerNotice].filter(Boolean).join(" "),
      projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  close() {
    this.closed = true;
    this.stopJobs?.();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const wake of [...this.waiters]) wake();
    return this.save;
  }
}
