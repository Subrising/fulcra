import { loadConfig, privateJson } from "./config.mjs";
export { privateJson } from "./config.mjs";
export const loadPortable = loadConfig;
export const portable = new Proxy({}, { get: (_target, key) => loadConfig()[key] });
export function localTasks(config = portable) {
  if (!config) throw Error("Portable task catalog required");
  const data = privateJson(config.tasks);
  if (
    data.version !== 1 ||
    !Array.isArray(data.issues) ||
    data.issues.length > 1000 ||
    new Set(data.issues.map((r) => r.id)).size !== data.issues.length
  )
    throw Error("Invalid local task catalog");
  return data.issues;
}
// Optional and additive: a catalog written before projects existed has no `projects` key and reads as none,
// so an old task-only installation keeps its exact current behaviour. Membership still comes only from a
// task's own explicit projectId; nothing here infers a project from a task.
export function localProjects(config = portable) {
  if (!config) throw Error("Portable project catalog required");
  const data = privateJson(config.tasks);
  if (data.version !== 1) throw Error("Invalid local task catalog");
  if (data.projects === undefined) return [];
  if (
    !Array.isArray(data.projects) ||
    data.projects.length > 64 ||
    new Set(data.projects.map((r) => r?.id)).size !== data.projects.length
  )
    throw Error("Invalid local project catalog");
  return data.projects;
}
