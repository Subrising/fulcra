export const defaultTask = "";
const validTask = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const selectedTasks = new Map<string, string>();
const validHost = (host: string) => !!host && host.length <= 256;
const key = (host: string) => JSON.stringify(["orca.selected-task.v1", host]);
function storage(host: string, web: boolean): BrowserStorage | undefined {
  if (!web || !validHost(host)) return;
  try {
    return (globalThis as { localStorage?: BrowserStorage }).localStorage;
  } catch {
    return;
  }
}
export function readSelectedTask(host: string, web: boolean): string {
  if (!validHost(host)) return defaultTask;
  let id: unknown;
  try {
    id = storage(host, web)?.getItem(key(host));
  } catch {
    /* Use this host's in-memory selection. */
  }
  return validTask(id) ? id : (selectedTasks.get(host) ?? defaultTask);
}
export function rememberSelectedTask(host: string, web: boolean, id: string): void {
  if (!validTask(id) || !validHost(host)) return;
  selectedTasks.set(host, id);
  try {
    storage(host, web)?.setItem(key(host), id);
  } catch {
    /* Selection still works when storage is unavailable. */
  }
}
