import { z } from "zod";
import { projectDirectory, projectSummary, type ProjectDirectory } from "../shared/projects";
import { portable, localIssues, localProjects } from "./portable";
import { COMPANY } from "./tasks";

const project = projectSummary.extend({ companyId: z.literal(COMPANY) });
const issue = z.object({
  id: z.string().uuid(),
  companyId: z.literal(COMPANY),
  projectId: z.string().uuid().nullable(),
});
/** Fulcra 0.2.8: an archived project is hidden from every list. Its rows stay in the source. */
export function isArchivedProject(raw: unknown) {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as { archivedAt?: unknown; status?: unknown };
  return (row.archivedAt !== undefined && row.archivedAt !== null) || row.status === "archived";
}
const archivedIds = (rows: unknown[]) =>
  new Set(
    rows
      .filter(isArchivedProject)
      .map((r) => (r as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string"),
  );
const localTask = z.object({
  id: z.string().uuid(),
  companyId: z.literal(COMPANY),
  projectId: z.string().uuid().nullable().optional(),
});

/**
 * A local installation may record a project catalog beside its tasks. Membership is emitted only
 * when the catalog itself confirms the project a task names; an unconfirmable link stays null and
 * marks the read partial, exactly as the board path does. This mirrors the controller's reader in
 * `src/control/projects.mjs` — the two must agree or a role seat would be verified against a
 * membership the UI does not show.
 */
export function localProjectDirectory(
  read: () => unknown[],
  readProjectRows: (() => unknown[]) | null = null,
): ProjectDirectory {
  const observedAt = new Date().toISOString();
  try {
    const rows = read();
    if (!Array.isArray(rows) || rows.length > 1000)
      throw new Error("Local task coverage exceeds bound");
    let partial = false;
    const known = new Map<string, z.infer<typeof project>>(),
      archived = new Set<string>();
    if (readProjectRows) {
      const projectRows = readProjectRows();
      if (!Array.isArray(projectRows) || projectRows.length > 64)
        throw new Error("Local project coverage exceeds bound");
      for (const id of archivedIds(projectRows)) archived.add(id);
      const seen = new Set<string>();
      for (const raw of projectRows.filter((r) => !isArchivedProject(r))) {
        const parsed = project.safeParse(raw);
        // A foreign or malformed row is dropped and the read says so; it never becomes a project.
        if (!parsed.success) {
          partial = true;
          continue;
        }
        if (seen.has(parsed.data.id)) {
          partial = true;
          known.delete(parsed.data.id);
          continue;
        }
        seen.add(parsed.data.id);
        known.set(parsed.data.id, parsed.data);
      }
    }
    const tasks = new Map<string, string | null>(),
      dropped = new Set<string>();
    for (const raw of rows) {
      const parsed = localTask.safeParse(raw);
      if (!parsed.success) {
        partial = true;
        continue;
      }
      const { id, projectId } = parsed.data;
      if (tasks.has(id) || dropped.has(id)) {
        partial = true;
        dropped.add(id);
        tasks.delete(id);
        continue;
      }
      // Confirmed membership, or an explicit unknown. A named project the catalog cannot confirm
      // is never presented as membership — it is the same class of claim as a capped page.
      if (projectId != null && known.has(projectId)) tasks.set(id, projectId);
      else {
        if (projectId != null && !archived.has(projectId)) partial = true;
        tasks.set(id, null);
      }
    }
    const projects = [...known.values()].map(({ companyId: _company, ...summary }) => summary);
    return projectDirectory.parse({
      observedAt,
      available: true,
      partial,
      projects,
      membership: [...tasks].map(([taskId, projectId]) => ({ taskId, projectId })),
      note: projects.length
        ? partial
          ? "Local project catalog. Some records could not be confirmed and their membership is unknown. Recorded work remains available."
          : "Local project catalog with explicit task membership. Recorded Fulcra leaders come from the session controller; project grouping grants no control."
        : partial
          ? "This installation records tasks only; project grouping is not supported here. Some local task records could not be read and their membership is unknown. Recorded work remains available."
          : "This installation records tasks only; project grouping is not supported here. No project membership is claimed for local work. Recorded work remains available.",
    });
  } catch {
    return projectDirectory.parse({
      observedAt,
      available: false,
      partial: true,
      projects: [],
      membership: [],
      note: "Local task catalog unavailable or beyond its read limits. Recorded work remains available; project membership is unknown.",
    });
  }
}

export async function readProjectList(
  resource: "projects" | "issues",
  fetcher = fetch,
  timeout = 4000,
): Promise<unknown[]> {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), timeout);
  try {
    const response = await fetcher(
      `${portable.authority.issueApi}/api/companies/${COMPANY}/${resource}`,
      { signal: abort.signal, redirect: "error" },
    );
    if (!response.ok || !response.body) throw new Error("Project source unavailable");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) throw new Error("Project source exceeds bound");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const rows: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(rows) || rows.length > (resource === "projects" ? 64 : 1000))
      throw new Error("Project coverage exceeds bound");
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export async function readProjects(
  read = readProjectList,
  local = portable.authority.issueApi === null ? localIssues : null,
  localProjectRows = portable.authority.issueApi === null ? localProjects : null,
) {
  if (local) return localProjectDirectory(local, localProjectRows);
  const observedAt = new Date().toISOString();
  try {
    const [allProjects, allIssues] = await Promise.all([read("projects"), read("issues")]);
    if (allProjects.length > 64 || allIssues.length > 1000)
      throw new Error("Project coverage exceeds bound");
    const archived = archivedIds(allProjects);
    const rawProjects = allProjects.filter((r) => !isArchivedProject(r));
    const rawIssues = allIssues.filter(
      (r) => !archived.has((r as { projectId?: unknown } | null)?.projectId as string),
    );
    let partial = false;
    function unique<T extends { id: string }>(rows: unknown[], schema: z.ZodType<T>) {
      const found = new Map<string, T>(),
        seen = new Set<string>();
      for (const raw of rows) {
        const id = raw && typeof raw === "object" && "id" in raw ? raw.id : null;
        if (typeof id === "string") {
          if (seen.has(id)) {
            found.delete(id);
            partial = true;
            continue;
          }
          seen.add(id);
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          partial = true;
          continue;
        }
        found.set(parsed.data.id, parsed.data);
      }
      return found;
    }
    const projects = unique(rawProjects, project),
      issues = unique(rawIssues, issue);
    const membership = [...issues.values()].flatMap((row) => {
      if (row.projectId && !projects.has(row.projectId)) {
        partial = true;
        return [];
      }
      return [{ taskId: row.id, projectId: row.projectId }];
    });
    return projectDirectory.parse({
      observedAt,
      available: true,
      partial,
      projects: [...projects.values()].map(({ companyId: _company, ...summary }) => summary),
      membership,
      note: partial
        ? "Some project records or task memberships could not be verified. Missing links are unknown; recorded work remains available."
        : "Registered projects and explicit task membership. Recorded Fulcra leaders come from the session controller; project grouping grants no control.",
    });
  } catch {
    return projectDirectory.parse({
      observedAt,
      available: false,
      partial: true,
      projects: [],
      membership: [],
      note: "Project directory unavailable or beyond its read limits. Recorded work remains available; project membership is unknown.",
    });
  }
}

export interface ArchivedProjects {
  projects: Set<string>;
  tasks: Set<string>;
}

/**
 * Fulcra 0.2.9: the archived projects and their tasks, by the same rule as the projects list. Team hides their chats;
 * the chats themselves are not changed, so History still opens them. An unreadable source hides nothing.
 */
export async function readArchivedProjects(
  read = readProjectList,
  local = portable.authority.issueApi === null ? localIssues : null,
  localProjectRows = portable.authority.issueApi === null ? localProjects : null,
): Promise<ArchivedProjects> {
  try {
    const [projectRows, taskRows] = local
      ? [localProjectRows?.() ?? [], local()]
      : await Promise.all([read("projects"), read("issues")]);
    if (!Array.isArray(projectRows) || !Array.isArray(taskRows))
      throw new Error("Project source unavailable");
    const projects = archivedIds(projectRows);
    const tasks = new Set<string>();
    for (const raw of taskRows) {
      const row = raw as { id?: unknown; projectId?: unknown } | null;
      if (typeof row?.id === "string" && projects.has(row.projectId as string)) tasks.add(row.id);
    }
    return { projects, tasks };
  } catch {
    return { projects: new Set(), tasks: new Set() };
  }
}
