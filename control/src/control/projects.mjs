import { portable, localTasks, localProjects } from "../portable-config.mjs";
import { COMPANY, uuid } from "./authority.mjs";
// The same authoritative company source authority.mjs already reads, projected into the shape the
// organization plugin publishes (shared/projects.ts projectDirectory). This is not a second registry:
// nothing here is stored, and a project exists only while the source says so.
const LIMIT = { projects: 64, issues: 1000 };
const text = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const NOTE = {
  board:
    "Registered projects and explicit task membership. Recorded Orca leaders come from the session controller; project grouping grants no control.",
  boardPartial:
    "Some project records or task memberships could not be verified. Missing links are unknown; recorded work remains available.",
  local:
    "This installation records tasks only; project grouping is not supported here. No project membership is claimed for local work. Recorded work remains available.",
  localPartial:
    "This installation records tasks only; project grouping is not supported here. Some local task records could not be read and their membership is unknown. Recorded work remains available.",
  localProjects:
    "Local catalog projects and explicit task membership. Recorded Orca leaders come from the session controller; project grouping grants no control.",
  localProjectsPartial:
    "Some local project records or task memberships could not be verified. Missing links are unknown; recorded work remains available.",
  unavailable:
    "Project directory unavailable or beyond its read limits. Recorded work remains available; project membership is unknown.",
  localUnavailable:
    "Local task catalog unavailable or beyond its read limits. Recorded work remains available; project membership is unknown.",
};
const unavailable = (observedAt, note) => ({
  observedAt,
  available: false,
  partial: true,
  projects: [],
  membership: [],
  note,
});
const asProject = (r) =>
  r &&
  typeof r === "object" &&
  uuid(r.id) &&
  r.companyId === COMPANY &&
  text(r.name, 160) &&
  (r.description === null || (typeof r.description === "string" && r.description.length <= 2000)) &&
  text(r.status, 64)
    ? { id: r.id, name: r.name, description: r.description, status: r.status }
    : null;
const asIssue = (r) =>
  r &&
  typeof r === "object" &&
  uuid(r.id) &&
  r.companyId === COMPANY &&
  (r.projectId === null || uuid(r.projectId))
    ? { id: r.id, projectId: r.projectId }
    : null;
export async function readProjectList(resource, fetcher = fetch, timeout = 4000) {
  const response = await fetcher(
    `${portable.authority.issueApi}/api/companies/${COMPANY}/${resource}`,
    { redirect: "error", signal: AbortSignal.timeout(timeout) },
  );
  if (!response.ok || !response.body) throw new Error("Project source unavailable");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1048576) throw new Error("Project source exceeds bound");
    chunks.push(chunk);
  }
  const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(rows) || rows.length > LIMIT[resource])
    throw new Error("Project coverage exceeds bound");
  return rows;
}
// A duplicated identity is omitted entirely rather than resolved to one of the records.
function collect(rows, validate) {
  const found = new Map(),
    seen = new Set();
  let partial = false;
  for (const raw of rows) {
    const id = raw && typeof raw === "object" ? raw.id : null;
    if (typeof id === "string") {
      if (seen.has(id)) {
        found.delete(id);
        partial = true;
        continue;
      }
      seen.add(id);
    }
    const value = validate(raw);
    if (!value) {
      partial = true;
      continue;
    }
    found.set(value.id, value);
  }
  return { found, partial };
}
// A local installation reads its own catalog and contacts no board. A catalog with no projects behaves
// exactly as before: no directory, and every membership unknown.
export function localProjectDirectory(read = localTasks, readProjects = () => []) {
  const observedAt = new Date().toISOString();
  try {
    const rows = read(),
      rawProjects = readProjects();
    if (!Array.isArray(rows) || rows.length > 1000)
      throw new Error("Local task coverage exceeds bound");
    if (!Array.isArray(rawProjects) || rawProjects.length > LIMIT.projects)
      throw new Error("Local project coverage exceeds bound");
    const projects = collect(rawProjects, asProject);
    let partial = projects.partial;
    const tasks = new Map(),
      dropped = new Set();
    for (const raw of rows) {
      if (
        !(
          raw &&
          typeof raw === "object" &&
          uuid(raw.id) &&
          raw.companyId === COMPANY &&
          (raw.projectId == null || uuid(raw.projectId))
        )
      ) {
        partial = true;
        continue;
      }
      if (tasks.has(raw.id) || dropped.has(raw.id)) {
        partial = true;
        dropped.add(raw.id);
        tasks.delete(raw.id);
        continue;
      }
      // A link to a project this catalog does not confirm is unknown, never membership.
      const confirmed = raw.projectId != null && projects.found.has(raw.projectId);
      if (raw.projectId != null && !confirmed) partial = true;
      tasks.set(raw.id, confirmed ? raw.projectId : null);
    }
    const grouping = projects.found.size > 0;
    return {
      observedAt,
      available: true,
      partial,
      projects: [...projects.found.values()],
      membership: [...tasks].map(([taskId, projectId]) => ({ taskId, projectId })),
      note: grouping
        ? partial
          ? NOTE.localProjectsPartial
          : NOTE.localProjects
        : partial
          ? NOTE.localPartial
          : NOTE.local,
    };
  } catch {
    return unavailable(observedAt, NOTE.localUnavailable);
  }
}
export async function readProjectDirectory(
  read = readProjectList,
  local = portable.authority.issueApi === null ? localTasks : null,
  localProjectList = portable.authority.issueApi === null ? localProjects : () => [],
) {
  if (local) return localProjectDirectory(local, localProjectList);
  const observedAt = new Date().toISOString();
  try {
    const [rawProjects, rawIssues] = await Promise.all([read("projects"), read("issues")]);
    if (
      !Array.isArray(rawProjects) ||
      !Array.isArray(rawIssues) ||
      rawProjects.length > LIMIT.projects ||
      rawIssues.length > LIMIT.issues
    )
      throw new Error("Project coverage exceeds bound");
    const projects = collect(rawProjects, asProject),
      issues = collect(rawIssues, asIssue);
    let partial = projects.partial || issues.partial;
    const membership = [...issues.found.values()].flatMap((row) => {
      // A link to a project the directory does not confirm is unknown, never membership.
      if (row.projectId && !projects.found.has(row.projectId)) {
        partial = true;
        return [];
      }
      return [{ taskId: row.id, projectId: row.projectId }];
    });
    return {
      observedAt,
      available: true,
      partial,
      projects: [...projects.found.values()],
      membership,
      note: partial ? NOTE.boardPartial : NOTE.board,
    };
  } catch {
    return unavailable(observedAt, NOTE.unavailable);
  }
}
