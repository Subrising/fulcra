import {
  agentInsights,
  projectOf,
  type AgentInsights,
  type AgentRecordFacts,
  type ProjectFacts,
} from "./agents.js";
import {
  deliveryInsights,
  parseGhPullRequests,
  type DeliveryInsights,
  type PullRequestRecord,
} from "./delivery.js";
import { readInsightsEvents } from "./recorder.js";

// Insights for one project or for all of them: delivery from the forge's pull request records (read with `gh`,
// cached for a few minutes per repository) and agents from the host's own records and insights log. Read-only.

const DAY = 24 * 60 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;
const MAX_PROJECTS = 12;

export interface InsightsDeps {
  paseoHome: string;
  listProjects: () => Promise<(ProjectFacts & { kind: string })[]>;
  listWorkspaces: () => Promise<{ workspaceId: string; projectId: string }[]>;
  listAgentRecords: () => Promise<AgentRecordFacts[]>;
  /** `gh` in a folder; resolves stdout. */
  runGh: (args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;
  /** The forge repository a folder belongs to ("owner/name"), or null when it has none. */
  repositoryOf: (cwd: string) => Promise<string | null>;
  now?: () => number;
}

export interface InsightsResult {
  days: number;
  scope: { projectId: string | null; name: string };
  projects: { projectId: string; name: string }[];
  delivery: (DeliveryInsights & { repositories: number; capped: boolean }) | null;
  deliveryUnavailable: boolean;
  agents: AgentInsights;
}

/** The most pull requests read per list; a list that reaches it is reported as capped, never silently cut. */
export const PULL_REQUEST_LIST_LIMIT = 1000;

interface PullRequestFetch {
  prs: PullRequestRecord[];
  capped: boolean;
}

const cache = new Map<string, { at: number; fetch: PullRequestFetch }>();

/**
 * Every pull request that matters for the window and the one before it: opened, merged or closed since then (a long
 * pull request merged in the window counts, however old), plus everything still open.
 */
async function pullRequests(
  deps: InsightsDeps,
  cwd: string,
  repo: string,
  days: number,
  now: number,
): Promise<PullRequestFetch> {
  const key = `${repo}\0${days}`;
  const known = cache.get(key);
  if (known && now - known.at < CACHE_MS) return known.fetch;
  const since = new Date(now - 2 * days * DAY).toISOString().slice(0, 10);
  const fields = "number,createdAt,mergedAt,closedAt,state,isDraft,author,reviews";
  const limit = String(PULL_REQUEST_LIST_LIMIT);
  const search = (query: string) =>
    deps.runGh(
      ["pr", "list", "--state", "all", "--limit", limit, "--search", query, "--json", fields],
      { cwd },
    );
  const lists = await Promise.all([
    search(`created:>=${since}`),
    search(`merged:>=${since}`),
    search(`closed:>=${since}`),
    deps.runGh(["pr", "list", "--state", "open", "--limit", limit, "--json", fields], { cwd }),
  ]);
  const byNumber = new Map<number, PullRequestRecord>();
  let capped = false;
  for (const list of lists) {
    const rows = parseGhPullRequests(list.stdout);
    if (rows.length >= PULL_REQUEST_LIST_LIMIT) capped = true;
    for (const pr of rows) byNumber.set(pr.number, pr);
  }
  const fetch = { prs: [...byNumber.values()], capped };
  cache.set(key, { at: now, fetch });
  return fetch;
}

export async function getInsights(input: {
  deps: InsightsDeps;
  projectId: string | null;
  days: number;
}): Promise<InsightsResult> {
  const { deps, days } = input;
  const now = deps.now?.() ?? Date.now();
  const projects = (await deps.listProjects()).slice(0, 200);
  const scoped =
    input.projectId === null ? projects : projects.filter((p) => p.projectId === input.projectId);
  const workspaces = await deps.listWorkspaces();
  const workspaceProject = new Map(workspaces.map((w) => [w.workspaceId, w.projectId]));

  // Delivery: every distinct forge repository among the scoped projects.
  const seen = new Set<string>();
  const prs: PullRequestRecord[] = [];
  let unavailable = false;
  let capped = false;
  for (const project of scoped.filter((p) => p.kind === "git").slice(0, MAX_PROJECTS)) {
    const repo = await deps.repositoryOf(project.rootPath).catch(() => null);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    try {
      const fetched = await pullRequests(deps, project.rootPath, repo, days, now);
      prs.push(...fetched.prs);
      capped ||= fetched.capped;
    } catch {
      unavailable = true;
    }
  }
  const delivery =
    seen.size > 0 && prs.length > 0
      ? { ...deliveryInsights({ prs, days, now }), repositories: seen.size, capped }
      : null;

  // One project: only its sessions and their events count.
  const allRecords = await deps.listAgentRecords();
  const records =
    input.projectId === null
      ? allRecords
      : allRecords.filter((r) => projectOf(r, projects, workspaceProject) === input.projectId);
  const ids = new Set(records.map((r) => r.id));
  const events = (await readInsightsEvents(deps.paseoHome)).filter(
    (e) => e.type === "recording-started" || (e.agentId !== undefined && ids.has(e.agentId)),
  );
  const agents = agentInsights({ records, events, projects, workspaceProject, days, now });
  const scopeName = input.projectId === null ? "" : (scoped[0]?.name ?? "");
  return {
    days,
    scope: { projectId: input.projectId, name: scopeName },
    projects: projects.map((p) => ({ projectId: p.projectId, name: p.name })),
    delivery,
    deliveryUnavailable: unavailable && delivery === null,
    agents,
  };
}
