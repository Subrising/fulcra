import { z } from "zod";
import { defineContract, type ContractReceive } from "./rpc-contract";

const item = z.object({
  id: z.string(),
  item: z.string(),
  kind: z.string(),
  owner: z.string(),
  status: z.string(),
  evidence: z.string(),
  source: z.string(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
  completedSource: z.enum(["record", "git", "file", "observed"]).optional(),
  blockedAt: z.string().optional(),
  blockedApprox: z.boolean().optional(),
  needsHuman: z.boolean().optional(),
});
const job = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  machine: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.number(),
  model: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  result: z.string().nullable(),
});
const branch = z.object({
  workspace: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  state: z.string(),
  ci: z.string(),
  observedAt: z.string().nullable(),
});
export const progressBoardRpc = defineContract({
  name: "progress.board.snapshot",
  input: z.object({}).strict(),
  output: z.object({
    observedAt: z.string(),
    machine: z.string(),
    warnings: z.array(z.string()),
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        ledgerState: z.string(),
        ledgerUpdatedAt: z.string().optional(),
        items: z.array(item),
        jobs: z.array(job),
        branches: z.array(branch),
      }),
    ),
  }),
});
export type ProgressBoard = ContractReceive<typeof progressBoardRpc>;
export type BoardItem = ProgressBoard["projects"][number]["items"][number];

export type BoardJob = ProgressBoard["projects"][number]["jobs"][number];
export const BOARD_GROUPS = ["Next / Open", "In progress", "Needs you", "Blocked", "Done"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];
export type BoardCard = { type: "item"; item: BoardItem } | { type: "job"; job: BoardJob };

export function matchesHumanOwner(owner: string, humanOwners: readonly string[] = []): boolean {
  const name = owner.trim().toLowerCase();
  return (
    name.length > 0 && humanOwners.some((candidate) => candidate.trim().toLowerCase() === name)
  );
}

export function itemGroup(row: BoardItem): BoardGroup {
  const status = row.status.trim().toUpperCase();
  if (status === "DONE" || status.startsWith("MOVED")) return "Done";
  if (status.startsWith("BLOCKED")) return "Blocked";
  if (row.kind.trim().toUpperCase() === "DECIDE" || row.needsHuman) return "Needs you";
  if (status.startsWith("IN PROGRESS")) return "In progress";
  return "Next / Open";
}

// Ledgers do not require dates. Undated completions use ledger order, bounded to the last ten rows.
export function boardColumns(project: ProgressBoard["projects"][number], now: number) {
  const recent = new Set(
    project.items
      .filter((row) => {
        if (itemGroup(row) !== "Done") return false;
        if (!row.completedAt) return true;
        const at = Date.parse(row.completedAt);
        return Number.isFinite(at) && at <= now && now - at <= 14 * 86400000;
      })
      .slice(-10),
  );
  return BOARD_GROUPS.map((group) => ({
    group,
    cards: [
      ...project.jobs
        .filter((job) => (job.status === "done" ? group === "Done" : group === "In progress"))
        .map((job): BoardCard => ({ type: "job", job })),
      ...project.items
        .filter((row) => itemGroup(row) === group && (group !== "Done" || recent.has(row)))
        .map((item): BoardCard => ({ type: "item", item })),
    ],
  }));
}

export function ageLabel(createdAt: string, now: number): string {
  const age = now - Date.parse(createdAt);
  if (!Number.isFinite(age) || age < 0) return "Age unavailable";
  const minutes = Math.floor(age / 60000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (minutes < 1440) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(minutes / 1440);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// Only ledger records and committed row dates can date completed work.
export function completionDate(row: BoardItem): string | undefined {
  if (!["record", "git"].includes(row.completedSource ?? "")) return undefined;
  return Number.isFinite(Date.parse(row.completedAt ?? "")) ? row.completedAt : undefined;
}

export function unknownDone(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((row) => /^DONE\b/i.test(row.status) && !completionDate(row)).toReversed();
}
export function recentDone(items: readonly BoardItem[], now: number, days = 1): BoardItem[] {
  return items
    .filter((row) => {
      const at = Date.parse(completionDate(row) ?? "");
      return (
        /^DONE\b/i.test(row.status) &&
        Number.isFinite(at) &&
        at <= now &&
        now - at <= days * 86400000
      );
    })
    .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!));
}
export function readyItems(items: readonly BoardItem[]): BoardItem[] {
  return items.filter(
    (row) =>
      /^(OPEN|READY|NEXT)\b/i.test(row.status) &&
      !["RULE", "DECIDE"].includes(row.kind.toUpperCase()),
  );
}

// Mirrored ledgers represent the same work. Prefer the newest readable copy in All hosts.
export function combineProjects(
  boards: readonly { id: string; label: string; data: ProgressBoard | null }[],
) {
  const grouped = new Map<
    string,
    {
      project: ProgressBoard["projects"][number];
      jobs: Array<BoardJob & { hostId: string }>;
      datedItems: BoardItem[];
    }
  >();
  for (const board of boards)
    for (const project of board.data?.projects ?? []) {
      const key = project.name.toLowerCase();
      let group = grouped.get(key);
      if (!group) {
        group = { project, jobs: [], datedItems: [] };
        grouped.set(key, group);
      }
      if (
        (Date.parse(project.ledgerUpdatedAt ?? "") || 0) >
        (Date.parse(group.project.ledgerUpdatedAt ?? "") || 0)
      )
        group.project = project;
      group.datedItems.push(
        ...project.items.filter((item) => /^DONE\b/i.test(item.status) && completionDate(item)),
      );
      group.jobs.push(
        ...project.jobs.map((job) => ({ ...job, hostId: board.id, machine: board.label })),
      );
    }
  return [...grouped.values()].map(({ project, jobs, datedItems }) => ({
    ...project,
    jobs,
    items: project.items.map((item) => {
      if (!/^DONE\b/i.test(item.status) || completionDate(item)) return item;
      const dated = datedItems.find(
        (other) =>
          other.id === item.id && other.item === item.item && other.evidence === item.evidence,
      );
      return dated
        ? { ...item, completedAt: dated.completedAt, completedSource: dated.completedSource }
        : item;
    }),
  }));
}
