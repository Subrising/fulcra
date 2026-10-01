import { supervisorSchema, type Supervisor } from "../shared/management";

// U5-D04: the controller's manager summary, read ENTRY BY ENTRY. One record that does not parse (or repeats an id) is
// set aside and counted, never allowed to blank the whole supervision view; `available` is false only when the summary
// itself could not be read. At most `limit` supervisors are returned; the rest are counted as truncated.
export interface SupervisorRead {
  available: boolean;
  supervisors: Supervisor[];
  issues: { unreadable: number; ids: string[]; truncated: number };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readSupervisors(value: unknown, limit = 32): SupervisorRead {
  const issues = { unreadable: 0, ids: [] as string[], truncated: 0 };
  if (!Array.isArray(value)) return { available: false, supervisors: [], issues };
  const seen = new Set<string>(), supervisors: Supervisor[] = [];
  for (const entry of value) {
    const parsed = supervisorSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) {
      issues.unreadable += 1;
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string" && UUID.test(id) && issues.ids.length < 8 && !issues.ids.includes(id)) issues.ids.push(id);
      continue;
    }
    seen.add(parsed.data.id);
    if (supervisors.length < limit) supervisors.push(parsed.data); else issues.truncated += 1;
  }
  return { available: true, supervisors, issues };
}
