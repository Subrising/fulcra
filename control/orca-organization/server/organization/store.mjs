import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  projectReferenceKey,
  resolveIntakeDestination,
} from "../../shared/workspace-organization.mjs";
const uuid = (v) => typeof v === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const host = (v) => typeof v === "string" && /^srv_[A-Za-z0-9_-]{8,64}$/.test(v);
const reference = (v) => v && host(v.serverId) && text(v.projectId, 1024);
const context = (v) => reference(v) && text(v.workspaceId, 1024);
const prime = (v) =>
  v === null ||
  (v &&
    host(v.serverId) &&
    uuid(v.agentId) &&
    (text(v.seat, 64) || (v.kind === "human-session" && v.seat === null)));
const canonical = (v) =>
  JSON.stringify(v, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
export class OrganizationStore {
  constructor(file, { now = () => new Date().toISOString(), id = randomUUID } = {}) {
    this.now = now;
    this.id = id;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file))
      requireValue(
        fs.lstatSync(file).isFile() &&
          !fs.lstatSync(file).isSymbolicLink() &&
          fs.lstatSync(file).uid === process.getuid(),
        "Organization state must be an owned file",
      );
    const fd = fs.openSync(
      file,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS workspace_organization(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_organization_operations(id TEXT PRIMARY KEY,body TEXT NOT NULL,result TEXT NOT NULL);",
    );
    this.db.prepare("INSERT OR IGNORE INTO workspace_organization VALUES (1,0,?)").run(
      JSON.stringify({
        version: 1,
        companyName: null,
        defaultWorkspaceId: null,
        workspaces: [],
        intakes: [],
      }),
    );
  }
  close() {
    this.db.close();
  }
  read() {
    const row = this.db
      .prepare("SELECT revision,payload FROM workspace_organization WHERE id=1")
      .get();
    return { ...JSON.parse(row.payload), revision: row.revision };
  }
  mutate(input) {
    requireValue(
      uuid(input.requestId) &&
        Number.isSafeInteger(input.expectedRevision) &&
        input.expectedRevision >= 0,
      "A request identity and observed revision are required",
    );
    const body = canonical(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT body,result FROM workspace_organization_operations WHERE id=?")
        .get(input.requestId);
      if (prior) {
        requireValue(prior.body === body, "Request identity was reused for different work");
        this.db.exec("COMMIT");
        return this.read();
      }
      requireValue(
        this.db.prepare("SELECT count(*) count FROM workspace_organization_operations").get()
          .count < 10000,
        "Organization operation history is full",
      );
      const state = this.read();
      requireValue(
        state.revision === input.expectedRevision,
        "Organization changed. Refresh before making this change.",
      );
      this.apply(state, input.command);
      requireValue(
        Buffer.byteLength(JSON.stringify(state)) < 4 * 1024 * 1024,
        "Organization state exceeds its retained-work limit",
      );
      state.revision++;
      this.db
        .prepare("UPDATE workspace_organization SET revision=?,payload=? WHERE id=1")
        .run(state.revision, JSON.stringify(state));
      this.db
        .prepare("INSERT INTO workspace_organization_operations VALUES (?,?,?)")
        .run(input.requestId, body, JSON.stringify({ revision: state.revision }));
      this.db.exec("COMMIT");
      return state;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  apply(state, c) {
    requireValue(c && typeof c.action === "string", "Organization action required");
    if (c.action === "name-company") {
      requireValue(text(c.name, 160), "Company name required");
      state.companyName = c.name.trim();
      return;
    }
    if (c.action === "create-workspace") {
      requireValue(
        state.workspaces.length < 64 && text(c.name, 160) && prime(c.prime),
        "Name and a valid recorded intake reference are required",
      );
      requireValue(
        !state.workspaces.some(
          (w) =>
            w.name.normalize("NFKC").toLocaleLowerCase("en-GB") ===
            c.name.trim().normalize("NFKC").toLocaleLowerCase("en-GB"),
        ),
        "A workspace umbrella with this name is already retained. Open it rather than creating another.",
      );
      state.workspaces.push({
        id: this.id(),
        name: c.name.trim(),
        prime: c.prime,
        lastProjectKey: null,
        projects: [],
        tasks: [],
        at: this.now(),
      });
      if (state.workspaces.length === 1) state.defaultWorkspaceId = state.workspaces[0].id;
      return;
    }
    const workspace = state.workspaces.find((w) => w.id === c.workspaceId);
    requireValue(workspace, "Workspace umbrella is unavailable");
    if (c.action === "default-workspace") {
      state.defaultWorkspaceId = workspace.id;
      return;
    }
    if (c.action === "set-prime") {
      requireValue(prime(c.prime), "Valid intake reference required");
      workspace.prime = c.prime;
      return;
    }
    if (c.action === "add-project") {
      requireValue(
        reference(c.project) && text(c.project.name, 160) && workspace.projects.length < 128,
        "Choose a real project reference",
      );
      const key = projectReferenceKey(c.project);
      requireValue(
        !state.workspaces.some((w) => w.projects.some((p) => p.key === key)),
        "This project already belongs to a workspace umbrella",
      );
      workspace.projects.push({
        key,
        name: c.project.name.trim(),
        placements: [{ serverId: c.project.serverId, projectId: c.project.projectId }],
        controllerProjectId: null,
        preferredContext: null,
      });
      return;
    }
    const project = workspace.projects.find((p) => p.key === c.projectKey);
    if (c.action === "set-context") {
      requireValue(
        project &&
          context(c.context) &&
          project.placements.some(
            (p) => p.serverId === c.context.serverId && p.projectId === c.context.projectId,
          ),
        "Choose a context belonging to this project",
      );
      project.preferredContext = c.context;
      return;
    }
    if (c.action === "add-task") {
      requireValue(
        project &&
          text(c.title, 160) &&
          ["feature", "task"].includes(c.kind) &&
          workspace.tasks.length < 512,
        "Project and planning work required",
      );
      requireValue(
        c.parentId === null ||
          workspace.tasks.some((t) => t.id === c.parentId && t.projectKey === project.key),
        "Parent planning work belongs to another project",
      );
      workspace.tasks.push({
        id: this.id(),
        projectKey: project.key,
        title: c.title.trim(),
        kind: c.kind,
        parentId: c.parentId,
        status: "planned",
        owner: null,
        controllerTaskId: null,
        contexts: [],
        sessions: [],
      });
      return;
    }
    if (c.action === "update-task" || c.action === "link-session") {
      const task = workspace.tasks.find((t) => t.id === c.taskId);
      requireValue(task, "Planning task unavailable");
      const member = workspace.projects.find((p) => p.key === task.projectKey);
      if (c.action === "update-task") {
        requireValue(
          ["planned", "active", "blocked", "done"].includes(c.status) && prime(c.owner),
          "Valid planning state and existing responsible person required",
        );
        task.status = c.status;
        task.owner = c.owner;
        return;
      }
      requireValue(
        context(c.context) &&
          c.session &&
          uuid(c.session.agentId) &&
          c.session.serverId === c.context.serverId &&
          c.session.workspaceId === c.context.workspaceId &&
          member.placements.some(
            (p) => p.serverId === c.context.serverId && p.projectId === c.context.projectId,
          ),
        "Session context must belong to this project's planning work",
      );
      requireValue(task.sessions.length < 128, "Planning session links are full");
      if (
        !task.sessions.some(
          (s) => s.serverId === c.session.serverId && s.agentId === c.session.agentId,
        )
      )
        task.sessions.push({
          serverId: c.session.serverId,
          agentId: c.session.agentId,
          workspaceId: c.session.workspaceId,
        });
      task.contexts ??= [];
      if (
        !task.contexts.some(
          (v) => v.serverId === c.context.serverId && v.workspaceId === c.context.workspaceId,
        )
      ) {
        requireValue(task.contexts.length < 64, "Planning context links are full");
        task.contexts.push(c.context);
      }
      return;
    }
    if (c.action === "begin-intake") {
      requireValue(
        uuid(c.intakeId) &&
          state.intakes.length < 256 &&
          !state.intakes.some((i) => i.id === c.intakeId),
        "Retained intake identity required",
      );
      requireValue(text(c.text, 16384), "Write what you want to work on");
      const decision = resolveIntakeDestination(workspace, c.text, c.projectKey);
      state.intakes.push({
        id: c.intakeId,
        workspaceId: workspace.id,
        text: c.text,
        prime: workspace.prime,
        projectKey: decision.kind === "resolved" ? decision.projectKey : null,
        context: null,
        state: decision.kind,
        basis: decision.basis ?? null,
        primeRequest: null,
        primeReply: null,
        conversations: [],
        history: [],
        at: this.now(),
      });
      return;
    }
    const intake = state.intakes.find((i) => i.id === c.intakeId && i.workspaceId === workspace.id);
    requireValue(intake, "Retained intake is unavailable");
    if (c.action === "route") {
      requireValue(
        project &&
          context(c.context) &&
          project.placements.some(
            (p) => p.serverId === c.context.serverId && p.projectId === c.context.projectId,
          ),
        "Destination must be an existing child project/context",
      );
      intake.history.push({
        projectKey: intake.projectKey,
        context: intake.context,
        at: this.now(),
      });
      requireValue(intake.history.length <= 64, "Routing history is full");
      workspace.lastProjectKey = project.key;
      intake.projectKey = project.key;
      intake.context = c.context;
      intake.state = intake.conversations.length ? "correction-recorded" : "routed";
      return;
    }
    if (c.action === "reserve-prime") {
      requireValue(
        intake.prime &&
          (!intake.primeRequest ||
            (intake.primeRequest.id === c.requestId &&
              ["held", "offline", "busy", "unavailable"].includes(intake.primeRequest.state))),
        "Main assistant routing already requested or no main assistant is recorded",
      );
      requireValue(
        text(c.prompt, 16384) &&
          (!intake.primeRequest?.prompt || intake.primeRequest.prompt === c.prompt),
        "The original main assistant routing prompt must be retained",
      );
      intake.primeRequest = { id: c.requestId, state: "pending", prompt: c.prompt, at: this.now() };
      intake.state = "waiting-prime";
      return;
    }
    if (c.action === "prime-result") {
      requireValue(
        intake.primeRequest?.id === c.requestId && intake.primeRequest.state === "pending",
        "This is not the retained main assistant request",
      );
      requireValue(
        ["answered", "held", "offline", "busy", "unavailable", "uncertain", "queued"].includes(
          c.state,
        ),
        "Invalid main assistant delivery result",
      );
      intake.primeRequest.state = c.state;
      intake.primeReply = typeof c.reply === "string" ? c.reply.slice(0, 16384) : null;
      intake.state = c.state;
      return;
    }
    if (c.action === "reserve-chat") {
      requireValue(
        intake.context && ["routed", "correction-recorded"].includes(intake.state),
        "Resolve an existing destination first",
      );
      requireValue(
        !intake.conversations.length,
        "A chat delivery was already retained. Open its original conversation instead of creating another.",
      );
      requireValue(uuid(c.deliveryId) && uuid(c.agentId), "Chat identities required");
      intake.conversations.push({
        deliveryId: c.deliveryId,
        agentId: c.agentId,
        ...intake.context,
        state: "pending",
        projectKey: intake.projectKey,
        at: this.now(),
      });
      intake.state = "creating-chat";
      return;
    }
    if (c.action === "chat-result") {
      const conversation = intake.conversations.find((s) => s.deliveryId === c.deliveryId);
      requireValue(
        conversation?.state === "pending" && ["created", "uncertain"].includes(c.state),
        "Retained creation does not match",
      );
      conversation.state = c.state;
      intake.state = c.state;
      if (c.state === "created" && c.taskId) {
        const task = workspace.tasks.find(
          (t) => t.id === c.taskId && t.projectKey === conversation.projectKey,
        );
        requireValue(task, "Planning work is not in the delivered project");
        task.sessions.push({
          serverId: conversation.serverId,
          agentId: conversation.agentId,
          workspaceId: conversation.workspaceId,
        });
        task.contexts ??= [];
        if (
          !task.contexts.some(
            (entry) =>
              entry.serverId === conversation.serverId &&
              entry.workspaceId === conversation.workspaceId,
          )
        )
          task.contexts.push({
            serverId: conversation.serverId,
            projectId: conversation.projectId,
            workspaceId: conversation.workspaceId,
          });
      }
      return;
    }
    throw new Error("Unknown organization action");
  }
}
