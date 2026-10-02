// J3 issue trackers (J3-DESIGN.md §3.5, §5). The journal records WHICH tracker project a registered Orca
// project maps to, and which sessions or workstreams (member tasks) are linked to which tracker items.
// Ids, enums, public URLs and timestamps only: there is no credential column, the controller calls no
// tracker, and nothing here sends a message. Every method is operator-only (rpc.mjs, after the gate).
import { randomUUID } from "node:crypto";
import { uuid } from "./authority.mjs";
import { assertColumns } from "./schema.mjs";
import { readProjectDirectory } from "./projects.mjs";
import {
  validMapping,
  validItemRef,
  canonicalUrl,
} from "../../orca-organization/shared/tracker-refs.mjs";
const keys = (a, names) =>
  a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === names;
export const TRACKER_LIMITS = Object.freeze({
  mappings: 64,
  linksPerProject: 256,
  linksPerSubject: 16,
  history: 5000,
  subjects: 64,
});
export const NO_TRACKER_AUTHORITY =
  "A tracker mapping or link records ids and public URLs only. It holds no credential, calls no tracker, sends no message and grants no authority.";
const MAPPING_COLUMNS =
  "project,tracker,auth,site,remoteId,remoteName,state,revision,validatedAt,note,at";
const LINK_COLUMNS =
  "id,project,subjectKind,subjectId,tracker,site,remoteId,remoteName,itemRef,url,state,revision,createdAt,at";
const identity = (r) => ({
  tracker: r.tracker,
  auth: r.auth,
  site: r.site,
  remoteId: r.remoteId,
  remoteName: r.remoteName,
});
export class Trackers {
  constructor(control, readProjects = readProjectDirectory) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.readProjects = readProjects;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS tracker_mappings(project TEXT PRIMARY KEY,tracker TEXT NOT NULL,auth TEXT NOT NULL,site TEXT NOT NULL,remoteId TEXT NOT NULL,remoteName TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,validatedAt TEXT,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracker_mapping_history(id TEXT PRIMARY KEY,project TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracker_links(id TEXT PRIMARY KEY,project TEXT NOT NULL,subjectKind TEXT NOT NULL,subjectId TEXT NOT NULL,tracker TEXT NOT NULL,site TEXT NOT NULL,remoteId TEXT NOT NULL,remoteName TEXT NOT NULL,itemRef TEXT NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(subjectKind,subjectId,tracker,remoteId,itemRef));
      CREATE TABLE IF NOT EXISTS tracker_link_history(id TEXT PRIMARY KEY,link TEXT NOT NULL,action TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, "tracker_mappings", MAPPING_COLUMNS);
    assertColumns(
      this.db,
      "tracker_mapping_history",
      "id,project,action,before,after,previousRevision,revision,actor,note,at",
    );
    assertColumns(this.db, "tracker_links", LINK_COLUMNS);
    assertColumns(
      this.db,
      "tracker_link_history",
      "id,link,action,previousRevision,revision,actor,at",
    );
  }
  row(project) {
    return this.db.prepare("SELECT * FROM tracker_mappings WHERE project=?").get(project) ?? null;
  }
  // The project must be in the current company directory. An unavailable source refuses the write, as a
  // seat assignment does, rather than recording an unverified project.
  async directory(project) {
    const d = await this.readProjects();
    if (!d.available) throw Error("Project directory unavailable; the project cannot be verified");
    if (!d.projects.some((p) => p.id === project))
      throw Error("Unknown project in the current company project directory");
    return d;
  }
  async map(a) {
    if (
      !keys(a, "auth,expectedRevision,note,project,remoteId,remoteName,site,tracker,validatedAt") ||
      !uuid(a.project) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 0 ||
      typeof a.note !== "string" ||
      a.note.length > 500 ||
      typeof a.validatedAt !== "string" ||
      Number.isNaN(Date.parse(a.validatedAt)) ||
      Date.parse(a.validatedAt) > Date.now() + 300000
    )
      throw Error("Invalid tracker mapping");
    const mapping = identity(a);
    if (!validMapping(mapping)) throw Error("Invalid tracker mapping");
    await this.directory(a.project);
    return this.store.atomic(() => {
      const current = this.row(a.project),
        revision = current?.revision ?? 0;
      if (revision !== a.expectedRevision)
        throw Error("Tracker mapping revision changed; refresh before mapping");
      if (
        current?.state !== "mapped" &&
        this.db.prepare("SELECT count(*) n FROM tracker_mappings WHERE state='mapped'").get().n >=
          TRACKER_LIMITS.mappings
      )
        throw Error("Tracker mapping capacity reached");
      if (
        this.db.prepare("SELECT count(*) n FROM tracker_mapping_history").get().n >=
        TRACKER_LIMITS.history
      )
        throw Error("Tracker mapping history capacity reached");
      const next = revision + 1,
        at = new Date().toISOString(),
        note = a.note.trim();
      this.db
        .prepare("INSERT OR REPLACE INTO tracker_mappings VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          a.project,
          mapping.tracker,
          mapping.auth,
          mapping.site,
          mapping.remoteId,
          mapping.remoteName,
          "mapped",
          next,
          new Date(a.validatedAt).toISOString(),
          note,
          at,
        );
      this.db
        .prepare("INSERT INTO tracker_mapping_history VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          a.project,
          current?.state === "mapped" ? "remap" : "map",
          current ? JSON.stringify({ ...identity(current), state: current.state }) : null,
          JSON.stringify({ ...mapping, state: "mapped" }),
          revision,
          next,
          "operator",
          note,
          at,
        );
      return {
        mapping: this.publicMapping(this.row(a.project)),
        grantsAuthority: false,
        note: NO_TRACKER_AUTHORITY,
      };
    });
  }
  unmap(a) {
    if (
      !keys(a, "expectedRevision,note,project") ||
      !uuid(a.project) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 1 ||
      typeof a.note !== "string" ||
      a.note.length > 500
    )
      throw Error("Invalid tracker unmapping");
    return this.store.atomic(() => {
      const current = this.row(a.project);
      if (!current || current.state !== "mapped")
        throw Error("That project has no tracker mapping");
      if (current.revision !== a.expectedRevision)
        throw Error("Tracker mapping revision changed; refresh before unmapping");
      if (
        this.db.prepare("SELECT count(*) n FROM tracker_mapping_history").get().n >=
        TRACKER_LIMITS.history
      )
        throw Error("Tracker mapping history capacity reached");
      // The row stays, unmapped, so the revision counter survives: a writer holding an older revision is
      // still refused after a later re-map.
      const next = current.revision + 1,
        at = new Date().toISOString(),
        note = a.note.trim();
      this.db
        .prepare("UPDATE tracker_mappings SET state='unmapped',revision=?,at=? WHERE project=?")
        .run(next, at, a.project);
      this.db
        .prepare("INSERT INTO tracker_mapping_history VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          a.project,
          "unmap",
          JSON.stringify({ ...identity(current), state: "mapped" }),
          JSON.stringify({ ...identity(current), state: "unmapped" }),
          current.revision,
          next,
          "operator",
          note,
          at,
        );
      return {
        mapping: this.publicMapping(this.row(a.project)),
        grantsAuthority: false,
        note: NO_TRACKER_AUTHORITY,
      };
    });
  }
  // A link subject must be an explicit member of the project: a member task (a workstream), or a saved
  // session whose own task is a member. Task ancestry never implies membership.
  async link(a) {
    if (
      !keys(a, "expectedMappingRevision,itemRef,project,subject") ||
      !uuid(a.project) ||
      !keys(a.subject, "id,kind") ||
      !["session", "task"].includes(a.subject.kind) ||
      !uuid(a.subject.id) ||
      !Number.isSafeInteger(a.expectedMappingRevision) ||
      a.expectedMappingRevision < 1 ||
      typeof a.itemRef !== "string"
    )
      throw Error("Invalid tracker link");
    const pinned = this.row(a.project);
    if (!pinned || pinned.state !== "mapped") throw Error("That project has no tracker mapping");
    if (!validItemRef(pinned.tracker, pinned.remoteName, a.itemRef))
      throw Error("Invalid tracker item for this mapping");
    const d = await this.directory(a.project);
    const task = a.subject.kind === "task" ? a.subject.id : this.store.get(a.subject.id)?.task;
    if (!task) throw Error("Tracker link requires a saved session identity");
    if (!d.membership.some((m) => m.taskId === task && m.projectId === a.project))
      throw Error("That subject is not an explicitly recorded member of the project");
    return this.store.atomic(() => {
      const m = this.row(a.project);
      if (!m || m.state !== "mapped" || m.revision !== a.expectedMappingRevision)
        throw Error("Tracker mapping changed; refresh before linking");
      const existing = this.db
        .prepare(
          "SELECT * FROM tracker_links WHERE subjectKind=? AND subjectId=? AND tracker=? AND remoteId=? AND itemRef=?",
        )
        .get(a.subject.kind, a.subject.id, m.tracker, m.remoteId, a.itemRef);
      if (existing?.state === "linked")
        throw Error("That subject is already linked to that tracker item");
      if (
        this.db
          .prepare("SELECT count(*) n FROM tracker_links WHERE project=? AND state='linked'")
          .get(a.project).n >= TRACKER_LIMITS.linksPerProject
      )
        throw Error("Tracker link capacity reached for this project");
      if (
        this.db
          .prepare(
            "SELECT count(*) n FROM tracker_links WHERE subjectKind=? AND subjectId=? AND state='linked'",
          )
          .get(a.subject.kind, a.subject.id).n >= TRACKER_LIMITS.linksPerSubject
      )
        throw Error("Tracker link capacity reached for this subject");
      if (
        this.db.prepare("SELECT count(*) n FROM tracker_link_history").get().n >=
        TRACKER_LIMITS.history
      )
        throw Error("Tracker link history capacity reached");
      const at = new Date().toISOString(),
        url = canonicalUrl(m.tracker, m.site, m.remoteName, a.itemRef);
      const id = existing?.id ?? randomUUID(),
        previous = existing?.revision ?? 0,
        next = previous + 1;
      if (existing)
        this.db
          .prepare(
            "UPDATE tracker_links SET project=?,site=?,remoteName=?,url=?,state='linked',revision=?,at=? WHERE id=?",
          )
          .run(a.project, m.site, m.remoteName, url, next, at, id);
      else
        this.db
          .prepare("INSERT INTO tracker_links VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            a.project,
            a.subject.kind,
            a.subject.id,
            m.tracker,
            m.site,
            m.remoteId,
            m.remoteName,
            a.itemRef,
            url,
            "linked",
            next,
            at,
            at,
          );
      this.db
        .prepare("INSERT INTO tracker_link_history VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), id, existing ? "relink" : "link", previous, next, "operator", at);
      return {
        link: this.publicLink(this.db.prepare("SELECT * FROM tracker_links WHERE id=?").get(id), m),
        grantsAuthority: false,
        note: NO_TRACKER_AUTHORITY,
      };
    });
  }
  unlink(a) {
    if (
      !keys(a, "expectedRevision,link") ||
      !uuid(a.link) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 1
    )
      throw Error("Invalid tracker unlink");
    return this.store.atomic(() => {
      const current = this.db.prepare("SELECT * FROM tracker_links WHERE id=?").get(a.link);
      if (!current || current.state !== "linked") throw Error("That tracker link is not active");
      if (current.revision !== a.expectedRevision)
        throw Error("Tracker link revision changed; refresh before unlinking");
      if (
        this.db.prepare("SELECT count(*) n FROM tracker_link_history").get().n >=
        TRACKER_LIMITS.history
      )
        throw Error("Tracker link history capacity reached");
      const next = current.revision + 1,
        at = new Date().toISOString();
      this.db
        .prepare("UPDATE tracker_links SET state='unlinked',revision=?,at=? WHERE id=?")
        .run(next, at, a.link);
      this.db
        .prepare("INSERT INTO tracker_link_history VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), a.link, "unlink", current.revision, next, "operator", at);
      return {
        linkId: a.link,
        revision: next,
        state: "unlinked",
        grantsAuthority: false,
        note: NO_TRACKER_AUTHORITY,
      };
    });
  }
  publicMapping(r) {
    return r
      ? {
          projectId: r.project,
          tracker: r.tracker,
          auth: r.auth,
          site: r.site,
          remoteId: r.remoteId,
          remoteName: r.remoteName,
          state: r.state,
          revision: r.revision,
          validatedAt: r.validatedAt,
          note: r.note,
          at: r.at,
        }
      : null;
  }
  // A link made under an earlier mapping is kept and shown as such; it is never re-pointed at a new repo.
  publicLink(r, mapping = this.row(r.project)) {
    return {
      id: r.id,
      projectId: r.project,
      subject: { kind: r.subjectKind, id: r.subjectId },
      tracker: r.tracker,
      site: r.site,
      remoteId: r.remoteId,
      remoteName: r.remoteName,
      itemRef: r.itemRef,
      url: r.url,
      revision: r.revision,
      createdAt: r.createdAt,
      at: r.at,
      fromPreviousMapping:
        !mapping ||
        mapping.state !== "mapped" ||
        mapping.tracker !== r.tracker ||
        mapping.remoteId !== r.remoteId,
    };
  }
  project(project) {
    if (!uuid(project)) throw Error("Invalid project");
    const mapping = this.row(project);
    const links = this.db
      .prepare(
        "SELECT * FROM tracker_links WHERE project=? AND state='linked' ORDER BY createdAt,id",
      )
      .all(project)
      .map((r) => this.publicLink(r, mapping));
    return {
      projectId: project,
      mapping: this.publicMapping(mapping),
      links,
      note: NO_TRACKER_AUTHORITY,
    };
  }
  linksFor(a) {
    if (
      !keys(a, "subjects") ||
      !Array.isArray(a.subjects) ||
      a.subjects.length > TRACKER_LIMITS.subjects ||
      !a.subjects.every(uuid)
    )
      throw Error("Invalid tracker link read");
    if (!a.subjects.length) return { links: [] };
    const rows = this.db
      .prepare(
        `SELECT * FROM tracker_links WHERE state='linked' AND subjectId IN (${a.subjects.map(() => "?").join(",")}) ORDER BY createdAt,id`,
      )
      .all(...a.subjects);
    return { links: rows.slice(0, 256).map((r) => this.publicLink(r)) };
  }
  // What the tracker panel needs to offer a mapping or a link: registered projects, their explicit member
  // tasks (workstreams) and saved sessions on those tasks. Read-only; unknown stays unknown.
  async projectsView() {
    const d = await this.readProjects(),
      sessions = this.store.list();
    const mappings = new Map(
      this.db
        .prepare("SELECT * FROM tracker_mappings")
        .all()
        .map((r) => [r.project, this.publicMapping(r)]),
    );
    return {
      available: d.available,
      partial: d.partial,
      note: d.note,
      projects: d.projects.slice(0, TRACKER_LIMITS.mappings).map((p) => {
        const tasks = d.membership
          .filter((m) => m.projectId === p.id)
          .map((m) => m.taskId)
          .slice(0, 64);
        return {
          id: p.id,
          name: p.name,
          mapping: mappings.get(p.id) ?? null,
          tasks,
          sessions: sessions
            .filter((s) => tasks.includes(s.task))
            .slice(0, 64)
            .map((s) => ({ id: s.id, task: s.task })),
        };
      }),
    };
  }
  status() {
    return {
      mappings: this.db
        .prepare("SELECT * FROM tracker_mappings WHERE state='mapped' ORDER BY project")
        .all()
        .map((r) => this.publicMapping(r)),
      note: NO_TRACKER_AUTHORITY,
    };
  }
  history(project) {
    if (!uuid(project)) throw Error("Invalid project");
    const mappings = this.db
      .prepare("SELECT * FROM tracker_mapping_history WHERE project=? ORDER BY rowid")
      .all(project)
      .map((h) => ({
        ...h,
        before: h.before ? JSON.parse(h.before) : null,
        after: JSON.parse(h.after),
      }));
    const links = this.db
      .prepare(
        "SELECT h.* FROM tracker_link_history h JOIN tracker_links l ON l.id=h.link WHERE l.project=? ORDER BY h.rowid",
      )
      .all(project);
    return { projectId: project, mappings, links };
  }
}
