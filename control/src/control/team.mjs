import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { portable, privateJson } from "../portable-config.mjs";
import { COMPANY, PROGRAMME, uuid } from "./authority.mjs";
import { managementRefusal } from "./management-refusal.mjs";

// Fulcra 0.2.8: build the team from chats that already exist. Until now a seat could only be held by a chat the
// controller had created itself, so "Make main assistant" on any chat the owner opened by hand was refused -- and the
// refusal reached the app as "outcome uncertain". These are owner-only management writes (managementDispatcher runs
// requireManagementPrincipal first; the role lane refuses them in rpc.mjs). Each change is recorded with the host
// principal that asked for it, in team_changes, beside the generic management_calls row.
//
// Every precondition is checked before the journal is written and is thrown as a managementRefusal, so the app shows
// the real reason. Nothing here starts, stops or messages a chat, and nothing grants a seat: seats stay with
// bindings-assign, which these methods only make possible.

const TRACKER_TIMEOUT = 4000;
const NAME_MAX = 160;
const ACTIVE = new Set(["todo", "in_progress"]);

const refuse = (message) => {
  throw managementRefusal(message);
};
const name = (v) => (typeof v === "string" ? v.trim() : "");
const SEAT_LABEL = "fulcra.seat";
const MAIN_ASSISTANT = "main-assistant";
const SYSTEM_ACTOR = JSON.stringify({
  principal: "controller",
  authentication: "seat-sync",
  deviceId: null,
});

export function actorOf(principal) {
  return JSON.stringify({
    principal: String(principal?.id ?? "unknown").slice(0, 200),
    authentication: String(principal?.authentication ?? "unknown").slice(0, 64),
    deviceId: principal?.deviceId ? String(principal.deviceId).slice(0, 200) : null,
  });
}

export class Team {
  constructor(control, { fetcher = fetch, config = portable, now = () => new Date() } = {}) {
    this.control = control;
    this.db = control.store.db;
    this.fetcher = fetcher;
    this.config = config;
    this.now = now;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS team_changes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, task TEXT, actor TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL)",
    );
  }

  record(kind, subject, task, actor, note) {
    if (this.db.prepare("SELECT count(*) n FROM team_changes").get().n >= 5000)
      this.db
        .prepare(
          "DELETE FROM team_changes WHERE id IN (SELECT id FROM team_changes ORDER BY at LIMIT 500)",
        )
        .run();
    const at = this.now().toISOString();
    this.db
      .prepare("INSERT INTO team_changes VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), kind, subject, task, actor, note, at);
    return at;
  }

  /**
   * Record a chat's reporting line on the chat itself, as labels the daemon reads when a chat sends: who it reports
   * to, whether it holds the main assistant seat, and its one direct link. Writing a label is not a seat change.
   */
  async line(a, principal) {
    const labels = {};
    if (a.reportsTo !== undefined) labels["fulcra.reports-to"] = a.reportsTo;
    if (a.seat !== undefined) labels["fulcra.seat"] = a.seat;
    if (a.directLink !== undefined) labels["fulcra.direct-link"] = a.directLink;
    if (!Object.keys(labels).length) refuse("Say which line to set.");
    if (a.seat !== undefined)
      refuse("The main assistant label follows the seat. Use Make main assistant instead.");
    if (a.reportsTo === a.sessionId || a.directLink === a.sessionId)
      refuse("A chat cannot report to itself or link to itself.");
    const native = this.control.native;
    if (typeof native?.setLabels !== "function")
      refuse("Fulcra is not connected to this computer's chats. Try again in a moment.");
    const snapshot = await native.snapshot?.(a.sessionId).catch(() => null);
    if (native.snapshot && !snapshot) refuse("That chat is not on this computer.");
    await native.setLabels(a.sessionId, labels);
    const at = this.record(
      "line",
      a.sessionId,
      null,
      actorOf(principal),
      `${a.note} ${JSON.stringify(labels)}`.slice(0, 2000),
    );
    return { sessionId: a.sessionId, labels, at };
  }

  /**
   * Make the main assistant label (fulcra.seat) agree with the controller's seat bindings: the chat that holds the
   * main assistant seat carries it, and no other chat does. The seat is the authority; the label only lets the daemon
   * route a send to "role:main-assistant" without asking the controller. Runs at start (this is the 0.2.8 migration:
   * a main assistant seated before 0.2.8 gets the label with no manual step), every minute, and after each seat
   * change. Idempotent. Stale holders are cleared before the holder is set, so a failed clear never leaves two.
   */
  async syncSeat(reason = "sync") {
    const native = this.control.native;
    if (typeof native?.labelled !== "function" || typeof native?.setLabels !== "function")
      return {
        holder: null,
        cleared: [],
        set: false,
        skipped: "Not connected to this computer's chats",
      };
    const held = (this.control.bindings?.directory?.().bindings ?? []).filter(
      (b) => b.role === "prime" && b.state === "assigned" && typeof b.sessionId === "string",
    );
    const seat = held.find((b) => b.seat === "main") ?? held[0] ?? null;
    const holder = seat && !native.route?.(seat.sessionId) ? seat.sessionId : null;
    const marked = await native.labelled(SEAT_LABEL, MAIN_ASSISTANT);
    const cleared = [];
    for (const id of marked.filter((id) => id !== holder)) {
      await native.setLabels(id, { [SEAT_LABEL]: "" });
      cleared.push(id);
      this.record(
        "seat-cleared",
        id,
        null,
        SYSTEM_ACTOR,
        `${reason}: not the main assistant seat holder`,
      );
    }
    let set = false;
    if (holder && !marked.includes(holder)) {
      await native.setLabels(holder, {
        [SEAT_LABEL]: MAIN_ASSISTANT,
        "fulcra.reports-to": "owner",
      });
      set = true;
      this.record("seat-set", holder, null, SYSTEM_ACTOR, `${reason}: holds the ${seat.seat} seat`);
    }
    return { holder, cleared, set };
  }

  history(limit = 50) {
    return this.db
      .prepare("SELECT kind,subject,task,actor,note,at FROM team_changes ORDER BY at DESC LIMIT ?")
      .all(Math.min(Math.max(1, limit), 200))
      .map((r) => ({ ...r, actor: JSON.parse(r.actor) }));
  }

  /**
   * Add an existing chat on this computer to the team, on one task: the programme root for a main assistant, a
   * project's anchor task for a lead or worker. A chat already on that task is reported as is. A chat on another
   * task moves only while it is under human control and holds no seat, because a seat and a delegation are both
   * keyed to the task.
   */
  async enrol(a, principal) {
    const { sessionId, taskId, note } = a;
    const row = this.control.store.get(sessionId);
    if (row?.task === taskId)
      return { action: "already", sessionId, taskId, generation: row.generation };
    if (row) {
      if (row.mode !== "human")
        refuse(
          "This chat is working for a lead right now. Take it back (stop it, or type in it), then try again.",
        );
      const seat = this.db
        .prepare("SELECT role,seat FROM role_bindings WHERE session=? AND state='assigned'")
        .get(sessionId);
      if (seat)
        refuse(
          seat.role === "prime"
            ? "This chat is a main assistant. Choose another main assistant first, then try again."
            : "This chat already leads a project. Choose another lead for that project first, then try again.",
        );
    }
    if (this.control.native?.route?.(sessionId))
      refuse("This chat runs on another computer. Add it from the Fulcra app on that computer.");
    let snapshot;
    try {
      snapshot = await this.control.native.snapshot(sessionId);
    } catch {
      refuse("Fulcra cannot find this chat on this computer. Open it once, then try again.");
    }
    if (snapshot.archivedAt) refuse("This chat is archived. Restore it, then try again.");
    if (!["claude", "codex"].includes(snapshot.provider))
      refuse("Only Claude and Codex chats can join a team.");
    if (typeof snapshot.cwd !== "string" || !path.isAbsolute(snapshot.cwd))
      refuse("This chat has no working folder, so it cannot join a team.");
    try {
      await this.control.authority(taskId);
    } catch (error) {
      refuse(`This task cannot take team members: ${error.message}`);
    }
    const actor = actorOf(principal);
    return this.control.store.atomic(() => {
      const fresh = this.control.store.get(sessionId);
      if ((fresh?.generation ?? null) !== (row?.generation ?? null) || fresh?.mode !== row?.mode)
        refuse("This chat changed while it was being added. Try again.");
      let generation = 1;
      if (fresh) {
        generation = fresh.generation + 1;
        this.db
          .prepare("UPDATE sessions SET task=?, generation=? WHERE id=? AND mode='human'")
          .run(taskId, generation, sessionId);
      } else this.control.store.created(sessionId, taskId, snapshot.cwd);
      const at = this.record(fresh ? "moved" : "enrolled", sessionId, taskId, actor, note);
      return {
        action: fresh ? "moved" : "enrolled",
        sessionId,
        taskId,
        previousTaskId: fresh?.task ?? null,
        generation,
        at,
      };
    });
  }

  /** Register a project and its anchor task, in the tracker when one is configured, else in tasks.json. */
  async createProject(a, principal) {
    const projectName = name(a.name);
    if (!projectName || projectName.length > NAME_MAX)
      refuse("A project name needs 1 to 160 characters.");
    const directory = await this.control.bindings.readProjects();
    if (!directory.available)
      refuse("The project list cannot be read right now, so no project was added. Try again.");
    const same = directory.projects.find(
      (p) => p.name.trim().toLowerCase() === projectName.toLowerCase(),
    );
    if (same) refuse(`A project called "${same.name}" already exists. Choose it instead.`);
    const created =
      this.config.authority.issueApi === null
        ? this.createLocal(projectName, a.description ?? null)
        : await this.createInTracker(projectName, a.description ?? null);
    const at = this.record(
      "project-created",
      created.projectId,
      created.taskId,
      actorOf(principal),
      a.note,
    );
    return { ...created, name: projectName, at };
  }

  /** The active anchor task of a project: the task its lead and workers are added on. Created when missing. */
  async anchor(a, principal) {
    const directory = await this.control.bindings.readProjects();
    const project = directory.projects.find((p) => p.id === a.projectId);
    if (!project) refuse("That project is not in the project list.");
    const tasks = await this.tasks();
    const found = tasks.find(
      (t) =>
        t.projectId === a.projectId &&
        t.parentId === PROGRAMME &&
        t.assigneeUserId === "local-board" &&
        !t.assigneeAgentId &&
        ACTIVE.has(t.status),
    );
    if (found) return { projectId: a.projectId, taskId: found.id, created: false };
    const taskId =
      this.config.authority.issueApi === null
        ? this.addLocalTask(project.name, a.projectId)
        : await this.addTrackerTask(project.name, a.projectId);
    this.record("anchor-created", a.projectId, taskId, actorOf(principal), a.note);
    return { projectId: a.projectId, taskId, created: true };
  }

  /** Hide a project from every list. Its tasks, chats, seats and history are kept. */
  async archiveProject(a, principal) {
    const directory = await this.control.bindings.readProjects();
    if (!directory.projects.some((p) => p.id === a.projectId))
      refuse("That project is not in the project list.");
    if (this.config.authority.issueApi === null) this.archiveLocal(a.projectId);
    else
      await this.tracker(`/api/projects/${a.projectId}`, "PATCH", {
        archivedAt: this.now().toISOString(),
      });
    const at = this.record("project-archived", a.projectId, null, actorOf(principal), a.note);
    return { projectId: a.projectId, archived: true, at };
  }

  // --- the tracker (an Orca board on this computer) ---

  async tracker(route, method, body) {
    let response;
    try {
      response = await this.fetcher(`${this.config.authority.issueApi}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TRACKER_TIMEOUT),
      });
    } catch {
      refuse("The project board on this computer does not answer. Nothing was changed.");
    }
    if (!response.ok)
      refuse(
        `The project board refused the change (HTTP ${response.status}). Nothing was changed.`,
      );
    const text = await response.text();
    if (text.length > 1048576) refuse("The project board answer is too large.");
    return text ? JSON.parse(text) : null;
  }

  async tasks() {
    if (this.config.authority.issueApi === null) return this.catalog().issues;
    const rows = await this.tracker(`/api/companies/${COMPANY}/issues`, "GET");
    return Array.isArray(rows) ? rows : [];
  }

  async createInTracker(projectName, description) {
    const project = await this.tracker(`/api/companies/${COMPANY}/projects`, "POST", {
      name: projectName,
      description,
      status: "in_progress",
    });
    if (!uuid(project?.id)) refuse("The project board did not return the new project.");
    const taskId = await this.addTrackerTask(projectName, project.id);
    return { projectId: project.id, taskId };
  }

  async addTrackerTask(projectName, projectId) {
    const task = await this.tracker(`/api/companies/${COMPANY}/issues`, "POST", {
      title: projectName,
      projectId,
      parentId: PROGRAMME,
      status: "in_progress",
      assigneeUserId: "local-board",
    });
    if (!uuid(task?.id)) refuse("The project board did not return the new task.");
    return task.id;
  }

  // --- the local catalog (tasks.json): the same rows `bootstrap.mjs project add` writes ---

  catalog() {
    const data = privateJson(this.config.tasks);
    if (data.version !== 1 || !Array.isArray(data.issues))
      refuse("The local task list cannot be read.");
    return data;
  }

  writeCatalog(update) {
    // Re-read inside the write: the controller is the only writer it can order, and a `bootstrap.mjs` edit between
    // the read and the rename would otherwise be lost. Replaced atomically, private, as task-catalog.py does.
    const data = this.catalog();
    const result = update(data);
    const text = JSON.stringify(data, null, 2) + "\n";
    if (Buffer.byteLength(text) > 1048576)
      refuse("The task list would be too large. Nothing was changed.");
    const temporary = path.join(path.dirname(this.config.tasks), `tasks-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      const fd = fs.openSync(temporary, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(temporary, this.config.tasks);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return result;
  }

  createLocal(projectName, description) {
    return this.writeCatalog((data) => {
      data.projects ??= [];
      if (!Array.isArray(data.projects)) refuse("The local project list is not valid.");
      if (data.projects.length >= 64) refuse("This computer already has 64 projects.");
      if (data.issues.length >= 1000) refuse("This computer already has 1000 tasks.");
      const projectId = randomUUID();
      data.projects.push({
        id: projectId,
        companyId: COMPANY,
        name: projectName,
        description,
        status: "active",
      });
      const taskId = this.localTaskRow(data, projectName, projectId);
      return { projectId, taskId };
    });
  }

  addLocalTask(projectName, projectId) {
    return this.writeCatalog((data) => {
      if (data.issues.length >= 1000) refuse("This computer already has 1000 tasks.");
      return this.localTaskRow(data, projectName, projectId);
    });
  }

  localTaskRow(data, title, projectId) {
    const id = randomUUID();
    data.issues.push({
      id,
      companyId: COMPANY,
      parentId: PROGRAMME,
      identifier: `ORCA-${data.issues.length}`,
      title,
      status: "in_progress",
      assigneeUserId: "local-board",
      assigneeAgentId: null,
      projectId,
    });
    return id;
  }

  archiveLocal(projectId) {
    this.writeCatalog((data) => {
      const project = (data.projects ?? []).find((p) => p?.id === projectId);
      if (!project) refuse("That project is not in the local project list.");
      project.status = "archived";
    });
  }
}

export const team = (control) => (control.team ??= new Team(control));
