// G1 LaunchPad: pull requests and issues across every mapped repo, split into "Waiting on you" and "Waiting on
// others", as a pure function of reads the Command Centre already makes (each project's tracker view, the connected
// accounts). Nothing here writes or reaches a tracker. What a tracker item carries decides what can be said: its
// assignee, state, kind, age and linked work. Review requests, requested changes and failing checks are not part of a
// tracker item yet, so they are not guessed at; the page says so once.
import type { TrackerView, Integrations } from "../shared/cc/connectors";

export type LaunchKind = "pr" | "issue";
export interface LaunchItem {
  key: string;
  projectId: string;
  project: string;
  repo: string;
  kind: LaunchKind;
  ref: string;
  title: string;
  state: "open" | "in-progress";
  url: string;
  updatedAt: string;
  assignee: string | null;
  mine: boolean;
  stale: boolean;
  sessionId: string | null;
  site: string | null;
}
export type LaunchAge = "any" | "day" | "week" | "older";
export interface LaunchFilters {
  repo: string | null;
  project: string | null;
  kind: LaunchKind | null;
  age: LaunchAge;
}
export const NO_FILTERS: LaunchFilters = { repo: null, project: null, kind: null, age: "any" };
export interface Launchpad {
  you: LaunchItem[];
  others: LaunchItem[];
  snoozed: LaunchItem[];
  repos: string[];
  projects: { id: string; name: string }[];
  kinds: LaunchKind[];
  total: number;
  shown: number;
  knowsYou: boolean;
  gaps: string[];
  /** M4: every unsnoozed item waiting on you, whatever the filters; Today's "Needs you" counts include it. */
  youTotal: number;
  /** M5: what to say when nothing is listed: items, nothing linked, linked but never refreshed, or refreshed and empty. */
  status: "items" | "no-trackers" | "never-refreshed" | "empty";
}
export interface LaunchpadInputs {
  now: number;
  projects: { id: string; name: string }[];
  views: Record<string, TrackerView | undefined>;
  failed: string[]; // project ids whose tracker view could not be read
  integrations: Integrations | undefined;
  snoozedUntil: Record<string, number>; // item key -> until (ms)
  filters: LaunchFilters;
}

const DAY = 86_400_000;
const repoOf = (url: string, fallback: string) => {
  const m = /^https:\/\/[^/]+\/([^/\s]+\/[^/\s#?]+)/.exec(url);
  return m ? m[1] : fallback;
};
const sessionOf = (links: TrackerView["items"][number]["links"]) => {
  for (const l of links) {
    if (l.state !== "active") continue;
    for (const end of [l.from, l.to]) {
      const m = /^session:([0-9a-f-]{36})$/.exec(end);
      if (m) return m[1];
    }
  }
  return null;
};
// M6: "you" is a stable login, per connector and site, never a display name and never pooled across connectors. The host
// names a connected GitHub account "<login> (GitHub)" from the API's `login` (product integrations/providers.ts), and lists
// this Mac's own `gh` sign-in as a `cli` account named by the bare login (U7 W4); GitHub items carry the assignee's login
// (connectors/github.mjs), so the two are the same identifier. Jira and Bitbucket give the app only display names on both
// sides, which can belong to more than one person. For those, nothing is counted as yours and the page says why.
const LOGIN_CONNECTORS = new Set(["github"]);
const DEFAULT_SITE: Record<string, string> = { github: "github.com" };
const identityKey = (connector: string, site: string | null) =>
  `${connector}@${(site ?? DEFAULT_SITE[connector] ?? "").toLowerCase()}`;
const LABEL: Record<string, string> = {
  github: "GitHub",
  jira: "Jira",
  "jira-dc": "Jira",
  bitbucket: "Bitbucket",
  "bitbucket-dc": "Bitbucket",
};
const loginOf = (displayName: string) =>
  displayName
    .trim()
    .replace(/ \(GitHub\)$/, "")
    .toLowerCase();
const siteOf = (ref: string) =>
  /^(?:issue|pr):[a-z][a-z0-9-]{1,31}@([A-Za-z0-9.-]{1,253}):/.exec(ref)?.[1]?.toLowerCase() ??
  null;

export function ageOf(updatedAt: string, now: number): Exclude<LaunchAge, "any"> {
  const t = Date.parse(updatedAt),
    d = Number.isFinite(t) ? now - t : Infinity;
  return d <= DAY ? "day" : d <= 7 * DAY ? "week" : "older";
}
export function matches(item: LaunchItem, f: LaunchFilters, now: number) {
  return (
    (!f.repo || item.repo === f.repo) &&
    (!f.project || item.projectId === f.project) &&
    (!f.kind || item.kind === f.kind) &&
    (f.age === "any" || ageOf(item.updatedAt, now) === f.age)
  );
}

/** The known logins of connected accounts, per connector and site (only connectors whose account name is a login). */
function loginsOf(integrations: Integrations | undefined) {
  const logins = new Map<string, Set<string>>();
  for (const a of integrations?.accounts ?? []) {
    if (a.state !== "connected" || !LOGIN_CONNECTORS.has(a.connector)) continue;
    const key = identityKey(a.connector, a.site);
    logins.set(key, (logins.get(key) ?? new Set()).add(loginOf(a.displayName)));
  }
  return logins;
}
/** One plain line per connector whose login is unknown: nothing from it is counted as yours. */
function identityGaps(unknown: Set<string>): string[] {
  const lines = [...unknown].sort().map((connector) => {
    if (connector === "github")
      return "Can't tell which GitHub items are yours: this Mac isn't signed in to GitHub, and no GitHub account is connected in Settings. Sign in with `gh auth login` or connect GitHub in Settings to see what's waiting on you.";
    const label = LABEL[connector] ?? connector;
    return `Can't tell which ${label} items are yours: ${label} only gives the app a display name, which can belong to more than one person. They show under Waiting on others.`;
  });
  return [...new Set(lines)];
}
function statusOf(listed: number, trackers: TrackerView["trackers"]): Launchpad["status"] {
  if (listed) return "items";
  if (!trackers.length) return "no-trackers";
  return trackers.every((t) => t.observedAt === null) ? "never-refreshed" : "empty";
}

export function buildLaunchpad(i: LaunchpadInputs): Launchpad {
  const logins = loginsOf(i.integrations);
  const unknown = new Set<string>(); // connectors with items but no known login
  let knowsYou = false; // at least one item is from a connector whose login is known
  const all: LaunchItem[] = [];
  for (const p of i.projects) {
    for (const row of i.views[p.id]?.items ?? []) {
      const it = row.item;
      if (it.kind === "ticket" || (it.state !== "open" && it.state !== "in-progress")) continue;
      const own = logins.get(identityKey(it.connector, siteOf(it.key)));
      if (own) knowsYou = true;
      else unknown.add(it.connector);
      all.push({
        key: `${p.id}:${it.key}`,
        projectId: p.id,
        project: p.name,
        repo: repoOf(it.url, p.name),
        kind: it.kind as LaunchKind,
        ref: it.ref,
        title: it.title,
        state: it.state,
        url: it.url,
        updatedAt: it.updatedAt,
        assignee: it.assignee,
        mine: !!own && !!it.assignee && own.has(it.assignee.toLowerCase()),
        stale: row.stale,
        sessionId: sessionOf(row.links),
        site: siteOf(it.key),
      });
    }
  }
  const byNewest = (a: LaunchItem, b: LaunchItem) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const awake = all.filter((x) => !((i.snoozedUntil[x.key] ?? 0) > i.now));
  const snoozed = all.filter((x) => (i.snoozedUntil[x.key] ?? 0) > i.now).sort(byNewest);
  const shown = awake.filter((x) => matches(x, i.filters, i.now)).sort(byNewest);
  const gaps: string[] = [];
  if (i.failed.length)
    gaps.push(
      `Pull requests and issues for ${i.failed.length === 1 ? "one project" : `${i.failed.length} projects`} could not be read just now.`,
    );
  gaps.push(...identityGaps(unknown));
  if (knowsYou && !all.some((x) => x.mine))
    gaps.push(
      "None of these are assigned to your connected account, so everything shows under Waiting on others.",
    );
  if (all.some((x) => x.stale))
    gaps.push(
      "Some of these were last checked a while ago; refresh a project's tracking to update them.",
    );
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  const status = statusOf(
    all.length,
    i.projects.flatMap((p) => i.views[p.id]?.trackers ?? []),
  );
  return {
    you: shown.filter((x) => x.mine),
    others: shown.filter((x) => !x.mine),
    snoozed,
    repos: uniq(all.map((x) => x.repo)).sort(),
    projects: i.projects.filter((p) => all.some((x) => x.projectId === p.id)),
    kinds: uniq(all.map((x) => x.kind)).sort() as LaunchKind[],
    total: awake.length,
    shown: shown.length,
    knowsYou,
    gaps,
    youTotal: awake.filter((x) => x.mine).length,
    status,
  };
}
