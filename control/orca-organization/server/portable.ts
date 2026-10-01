import path from "node:path";
import { loadConfig, privateJson } from "./config.mjs";
export const readPrivate = privateJson;
export const portable = new Proxy({} as ReturnType<typeof loadConfig> & { company: string; programme: string }, {
  get: (_target, key) => { const c = loadConfig(); return key === "company" ? c.authority.companyId : key === "programme" ? c.authority.programmeId : c[key as keyof typeof c]; },
});
/**
 * One read validates both arrays, because a malformed `projects` array invalidates the *whole*
 * catalog in the controller's reader (`src/control/projects.mjs`). Splitting the checks would let
 * the plugin accept a catalog the controller rejects, and the two would then disagree on
 * membership — which is exactly the failure the role bindings are fenced against.
 */
function localCatalog(): { issues: any[]; projects: any[] } {
  if (!portable) throw Error("Portable configuration required");
  const data = readPrivate(path.join(portable.home, "tasks.json"));
  if (data.version !== 1 || !Array.isArray(data.issues) || data.issues.length > 1000) throw Error("Invalid local task catalog");
  // Optional: absent means this installation records no projects, which is not an error.
  const projects = data.projects;
  if (projects === undefined) return { issues: data.issues, projects: [] };
  if (!Array.isArray(projects) || projects.length > 64) throw Error("Invalid local project catalog");
  const ids = new Set<string>();
  for (const row of projects) {
    const id = row && typeof row === "object" && !Array.isArray(row) ? (row as { id?: unknown }).id : null;
    if (typeof id !== "string" || ids.has(id)) throw Error("Invalid local project catalog");
    ids.add(id);
  }
  return { issues: data.issues, projects };
}
export function localIssues(): any[] { return localCatalog().issues; }
export function localProjects(): any[] { return localCatalog().projects; }
