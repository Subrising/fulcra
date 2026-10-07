import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertColumns } from "./schema.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readIssue } from "./authority.mjs";
import { ownedBySeat } from "./seat-sweep.mjs";
import { WorktreeLifecycle, contained } from "./worktree-lifecycle.mjs";
const exec = promisify(execFile);
// All sessions whose working directories share this job must be known and inactive.
export function createWorktreeLifecycle(control, home, options = {}) {
  const service = new WorktreeLifecycle({
    home,
    db: control.store.db,
    // Even if a controller is installed inside an old job, that job cannot retire itself.
    protectedPaths: [fileURLToPath(import.meta.url)],
    session: async (_id, dir) => {
      const rows = control.store
        .list()
        .filter((r) => r.cwd === dir || r.cwd.startsWith(dir + path.sep));
      try {
        const file = await contained(path.join(home, "tasks"), path.join(dir, "SESSION-ID"));
        const id = (await fs.readFile(file, "utf8")).trim();
        if (!rows.some((r) => r.id === id)) rows.push({ id });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (!rows.length) return { state: "unknown" };
      const snapshots = await Promise.all(rows.map((r) => control.native.snapshot(r.id)));
      const label = snapshots.find((s) => s?.title)?.title;
      if (snapshots.some((s) => !s)) return { state: "unknown" };
      if (
        snapshots.some((s) => s.activeTurn || ["running", "working", "starting"].includes(s.status))
      )
        return { state: "live", label };
      if (snapshots.every((s) => s.archivedAt))
        return {
          state: "archived",
          label,
          at: new Date(Math.max(...snapshots.map((s) => Date.parse(s.archivedAt)))).toISOString(),
        };
      if (snapshots.every((s) => s.archivedAt || s.status === "idle"))
        return { state: "idle", label };
      return { state: "unknown" };
    },
    // PR inspection is read-only and injectable. No shell, fetch URL or command comes from RPC input.
    pr: async (_id, dir) => {
      const values = [];
      const visit = async (d) => {
        await contained(path.join(home, "tasks"), d);
        const entries = await fs.readdir(d, { withFileTypes: true });
        if (entries.some((e) => e.name === ".git")) {
          try {
            const { stdout } = await exec("gh", ["pr", "view", "--json", "state,mergedAt"], {
              cwd: d,
              timeout: 10000,
              maxBuffer: 65536,
            });
            values.push(JSON.parse(stdout));
          } catch {
            values.push(null);
          }
          return;
        }
        for (const e of entries)
          if (
            e.isDirectory() &&
            !["inputs", "kept-files", "node_modules", "dist", "build"].includes(e.name)
          )
            await visit(path.join(d, e.name));
      };
      await visit(dir);
      // Every repo must be merged: one merged PR must not retire another repo's open work.
      if (values.length && values.every((v) => v?.state === "MERGED" && v.mergedAt))
        return {
          state: "merged",
          at: new Date(Math.max(...values.map((v) => Date.parse(v.mergedAt)))).toISOString(),
        };
      return { state: values.some((v) => v?.state === "OPEN") ? "open" : "unknown" };
    },
    ...options,
  });
  service.sessions = new OwnedSessionCleanup(control, home, {
    ...options,
    settings: service.settings,
  });
  return service;
}

// A terminal board item is completion evidence; an idle provider turn is not.
export class OwnedSessionCleanup {
  constructor(control, home, { now = Date.now, readTask = readIssue, settings = null } = {}) {
    Object.assign(this, { control, home: path.resolve(home), now, readTask, settings });
    control.store.db.exec(
      `CREATE TABLE IF NOT EXISTS cc_session_cleanup(id TEXT PRIMARY KEY,session TEXT NOT NULL,generation INTEGER NOT NULL,instanceId TEXT NOT NULL,nativeId TEXT NOT NULL,boot TEXT NOT NULL,humanAt INTEGER NOT NULL,archive INTEGER NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL)`,
    );
    assertColumns(
      control.store.db,
      "cc_session_cleanup",
      "id,session,generation,instanceId,nativeId,boot,humanAt,archive,state,at",
    );
  }
  // preview: report what would happen and change nothing. only: act only on sessions a preview showed.
  async run(settings, { manual = false, preview = false, only = null } = {}) {
    const c = this.control,
      db = c.store.db,
      results = [];
    const has = (table) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    for (const listed of c.store.list().slice(0, 256)) {
      if (c.closing) break;
      if (!(manual || settings.archiveFinished || settings.idleMinutes !== "never")) break;
      const id = listed.id;
      if (only && !only.has(id)) continue;
      let action = "reap",
        attempted = false;
      try {
        await c.exclusive(id, async () => {
          const row = c.store.get(id);
          if (!row || row.mode !== "delegated" || !ownedBySeat(db, id) || c.native.route?.(id))
            return;
          if (
            has("role_bindings") &&
            db.prepare("SELECT 1 FROM role_bindings WHERE session=? AND state='assigned'").get(id)
          )
            return;
          if (
            has("manager_grants") &&
            db
              .prepare("SELECT 1 FROM manager_grants WHERE supervisor=? AND generation=?")
              .get(id, row.generation)
          )
            return;
          if (
            has("deliveries") &&
            db
              .prepare(
                "SELECT 1 FROM deliveries WHERE session=? AND state IN ('intent','uncertain','queued','reserved')",
              )
              .get(id)
          )
            return;
          const dir = await contained(path.join(this.home, "tasks"), row.cwd);
          if (dir !== row.cwd) return;
          const initial = await c.native.snapshot(id);
          if (!this.idle(row, initial)) return;
          const task = await this.readTask(row.task);
          const finished = task.id === row.task && ["done", "cancelled"].includes(task.status);
          const archive = finished && (manual || settings.archiveFinished);
          if (archive) action = "archive";
          else {
            const elapsed = this.now() - Date.parse(initial.updatedAt);
            if (
              settings.idleMinutes === "never" ||
              !Number.isFinite(elapsed) ||
              elapsed < settings.idleMinutes * 60000
            )
              return;
          }
          if (this.settings) {
            const currentSettings = await this.settings.getAll();
            if (!manual && archive && !currentSettings.archiveFinished) return;
            if (
              !archive &&
              (currentSettings.idleMinutes === "never" ||
                this.now() - Date.parse(initial.updatedAt) < currentSettings.idleMinutes * 60000)
            )
              return;
          }
          if (archive) {
            const currentTask = await this.readTask(row.task);
            if (currentTask.id !== row.task || !["done", "cancelled"].includes(currentTask.status))
              return;
          }
          if (preview) {
            results.push({
              id,
              action,
              state: "planned",
              reason: archive
                ? "Finished job will be archived; history kept"
                : "Idle runtime will be closed; history and owner kept",
              bytes: 0,
            });
            return;
          }
          const fresh = await c.native.snapshot(id);
          const current = c.store.get(id);
          if (
            !current ||
            current.mode !== "delegated" ||
            current.generation !== row.generation ||
            !ownedBySeat(db, id) ||
            !this.idle(current, fresh) ||
            fresh.runtimeInstanceId !== initial.runtimeInstanceId ||
            fresh.updatedAt !== initial.updatedAt ||
            fresh.inputSequence?.boot !== initial.inputSequence?.boot ||
            fresh.inputSequence?.humanAt !== initial.inputSequence?.humanAt
          )
            throw Error("Session changed; retained");
          const nativeId = fresh.runtimeInfo?.sessionId;
          if (!nativeId || fresh.persistence?.sessionId !== nativeId)
            throw Error("Native lifetime unavailable");
          if (db.prepare("SELECT count(*) n FROM cc_session_cleanup").get().n >= 10000)
            throw Error("Cleanup journal is full");
          const intent = randomUUID();
          db.prepare("INSERT INTO cc_session_cleanup VALUES(?,?,?,?,?,?,?,?,?,?)").run(
            intent,
            id,
            row.generation,
            fresh.runtimeInstanceId,
            nativeId,
            fresh.inputSequence.boot,
            fresh.inputSequence.humanAt,
            archive ? 1 : 0,
            "intent",
            this.now(),
          );
          try {
            attempted = true;
            await c.native.cleanupIdle(id, fresh, archive, intent);
            db.prepare("UPDATE cc_session_cleanup SET state='complete' WHERE id=?").run(intent);
          } catch (error) {
            db.prepare("UPDATE cc_session_cleanup SET state='needs-attention' WHERE id=?").run(
              intent,
            );
            throw error;
          }
          // A finished job's grant ends only after native acknowledgement. An unfinished job keeps its
          // owner: closing the runtime frees memory, and the job resumes when the runtime reopens.
          if (archive && c.store.get(id)?.mode === "delegated")
            c.takeover(id, "Finished owned job archived");
          results.push({
            id,
            action,
            state: "complete",
            reason: archive
              ? "Finished owned job archived; history kept"
              : "Idle owned runtime closed; history and owner kept",
            bytes: 0,
          });
        });
      } catch {
        results.push({
          id,
          action,
          state: attempted ? "needs-attention" : "skipped",
          reason: attempted
            ? "Cleanup outcome could not be confirmed; inspect the session"
            : "Ownership, native state or task could not be confirmed; session retained",
          bytes: 0,
        });
      }
    }
    return { results, partial: c.store.list().length > 256 };
  }
  idle(row, snapshot) {
    return (
      snapshot?.status === "idle" &&
      !snapshot.archivedAt &&
      !snapshot.activeTurn &&
      !snapshot.pendingPermissions?.length &&
      snapshot.runtimeInstanceId &&
      snapshot.labels?.owner === "orca-control" &&
      snapshot.labels?.task === row.task &&
      snapshot.cwd === row.cwd &&
      snapshot.inputSequence?.boot === row.boot &&
      Number.isSafeInteger(snapshot.inputSequence?.humanAt) &&
      snapshot.inputSequence.humanAt < row.grantedAt
    );
  }
}

export { admitOwnedCleanup } from "./owned-cleanup-admission.mjs";
