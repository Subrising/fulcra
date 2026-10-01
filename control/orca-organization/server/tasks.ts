import { portable, localIssues } from "./portable";
import type { PaseoApi } from "@getpaseo/client";
import { taskCatalogRpc, usageSchema } from "../shared/tasks";
import { localCall } from "./management";
// These identify the fixed discovery scope; execution authority remains in the controller.
export const COMPANY = (portable.company), PROGRAMME = (portable.programme);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
type Issue = { id: string; companyId: string; parentId?: string | null; assigneeUserId?: string | null; assigneeAgentId?: string | null; status: string; title: string; identifier?: string };
export function eligibleHint(id: string, issues: Map<string, Issue>) {
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(id)) return false; seen.add(id); const row = issues.get(id);
    if (!row || row.companyId !== COMPANY || row.assigneeUserId !== "local-board" || row.assigneeAgentId || !["todo", "in_progress"].includes(row.status)) return false;
    if (id === PROGRAMME) return true;
    if (!uuid(row.parentId)) return false; id = row.parentId;
  }
  return false;
}
// Retained completed tasks still need names. Eligibility remains status-gated in eligibleHint.
export async function readIssues(fetcher = fetch): Promise<unknown[]> {
  if (portable.authority.issueApi === null) return localIssues();
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4000);
  try {
    const response = await fetcher(`${portable.authority.issueApi}/api/companies/${COMPANY}/issues`, { redirect: "error", signal: abort.signal });
    if (!response.ok || !response.body) throw new Error("Task board unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1048576) throw new Error("Task list exceeds limit"); chunks.push(value); } }
    finally { await reader.cancel().catch(() => undefined); }
    const rows: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid task list"); return rows;
  } finally { clearTimeout(timer); }
}
export function projectTasks(raw: unknown[], index: { taskIds: string[]; partial: boolean }, boardAvailable: boolean) {
  const issues = new Map<string, Issue>(), duplicates = new Set<string>(); let partial = index.partial || raw.length > 1000;
  for (const item of raw.slice(0, 1000)) {
    const r = item as Issue;
    if (!r || !uuid(r.id) || r.companyId !== COMPANY || typeof r.title !== "string" || typeof r.status !== "string") { partial = true; continue; }
    if (issues.has(r.id) || duplicates.has(r.id)) { partial = true; duplicates.add(r.id); issues.delete(r.id); continue; } issues.set(r.id, r);
  }
  const retained = new Set(index.taskIds.filter(uuid));
  const ids = [...new Set([PROGRAMME, ...retained, ...[...issues.keys()].filter(id => eligibleHint(id, issues))])];
  ids.sort((a, b) => a === PROGRAMME ? -1 : b === PROGRAMME ? 1 : Number(retained.has(b)) - Number(retained.has(a)) || a.localeCompare(b));
  return { observedAt: new Date().toISOString(), available: true, partial, tasks: ids.map(id => { const r = issues.get(id); return { id, identifier: typeof r?.identifier === "string" ? r.identifier.slice(0, 64) : null, title: r?.title.slice(0, 160) ?? "Retained task", status: r?.status.slice(0, 64) ?? null, retained: retained.has(id), eligibleHint: boardAvailable && eligibleHint(id, issues) }; }), note: boardAvailable ? "Selection does not delegate work. Current authority is checked before an action." : "Task board unavailable. Retained work remains visible for inspection and human control." };
}
export async function readTaskCatalog(read = readIssues, call = localCall) {
  const [board, journal] = await Promise.allSettled([read(), call("task-index")]);
  if (journal.status !== "fulfilled" || !journal.value || !Array.isArray(journal.value.taskIds) || journal.value.taskIds.length > 2048 || journal.value.taskIds.some((id: unknown) => !uuid(id)) || typeof journal.value.partial !== "boolean") throw new Error("Retained task index unavailable; task coverage cannot be established");
  return projectTasks(board.status === "fulfilled" ? board.value : [], journal.value, board.status === "fulfilled");
}
export function taskPage(catalog: Awaited<ReturnType<typeof readTaskCatalog>>, cursor: number) {
  return taskCatalogRpc.output.parse({ ...catalog, total: catalog.tasks.length, tasks: catalog.tasks.slice(cursor, cursor + 32), nextCursor: cursor + 32 < catalog.tasks.length ? cursor + 32 : null });
}
export function singleFlight<T>(read: () => Promise<T>, now = Date.now, ttl = 30000) {
  let cached: T | undefined, expires = 0, flight: Promise<T> | undefined;
  return () => { if (flight) return flight; if (cached !== undefined && now() < expires) return Promise.resolve(cached); flight = read().then(value => { cached = value; expires = now() + ttl; return value; }).finally(() => { flight = undefined; }); return flight; };
}
export function projectUsage(input: unknown, observedAt = new Date().toISOString()) {
  let truncated = false;
  const raw = input as any, text = (v: unknown, n = 128) => { if (typeof v !== "string") return null; if (v.length > n) truncated = true; return v.slice(0, n); };
  const pct = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  const rows = Array.isArray(raw?.providers) ? raw.providers : []; truncated = rows.length > 16;
  const providers = rows.slice(0, 16).map((p: any) => {
    const windows = Array.isArray(p?.windows) ? p.windows : [], balances = Array.isArray(p?.balances) ? p.balances : [];
    truncated ||= windows.length > 16 || balances.length > 16;
    return { id: text(p?.providerId) ?? "unknown", name: text(p?.displayName) ?? "Unknown provider", status: ["available", "unavailable", "error"].includes(p?.status) ? p.status : "error", fetchedAt: text(p?.fetchedAt), source: text(p?.sourceLabel), error: text(p?.error, 512),
      windows: windows.slice(0, 16).map((w: any) => ({ label: text(w?.label) ?? "Usage", used: pct(w?.usedPct), remaining: pct(w?.remainingPct), resetsAt: text(w?.resetsAt) })),
      balances: balances.slice(0, 16).filter((b: any) => { const valid = ["usd", "credits", "requests", "tokens"].includes(b?.unit); if (!valid) truncated = true; return valid; }).map((b: any) => ({ label: text(b.label) ?? "Balance", remaining: typeof b.remaining === "number" && Number.isFinite(b.remaining) ? b.remaining : null, unit: b.unit })),
    };
  });
  return usageSchema.parse({ observedAt, fetchedAt: text(raw?.fetchedAt), available: Array.isArray(raw?.providers), truncated, providers });
}
export function createUsageReader(paseo: PaseoApi, timeoutMs = 4000, now = Date.now) {
  // The underlying flight survives a display timeout; another viewer cannot start a duplicate account request.
  const load = singleFlight(async () => { try { return projectUsage(await paseo.providers.listUsage()); } catch { return projectUsage(null); } }, now);
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([load(), new Promise<ReturnType<typeof projectUsage>>(resolve => { timer = setTimeout(() => resolve(projectUsage(null)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
}
