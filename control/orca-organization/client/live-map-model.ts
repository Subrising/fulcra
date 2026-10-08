import type { PluginObservedAgentDirectory, PluginObservedAgent } from "@getpaseo/plugin/client";
import type { Fleet } from "../shared/fleet";
import type { RemitsView } from "../shared/cc/remit";
import { LIMITS, freshness, type Row } from "./work-map-model";

export type ActivityFilter = "active" | "all" | PluginObservedAgent["activity"];
const key = (serverId: string, agentId: string) => `${serverId}:${agentId}`;
const words: Record<PluginObservedAgent["activity"], string> = {
  working: "model turn active",
  idle: "idle — not done",
  permission: "waiting for permission",
  error: "error",
  unknown: "activity unknown",
  unavailable: "host disconnected; cached observation",
};
export const EMPTY_NATIVE: PluginObservedAgentDirectory = Object.freeze({
  entries: Object.freeze([]),
  total: 0,
  truncated: 0,
  source: "native-cache",
});

/** Join exact controller IDs to bound native host/agent IDs. Ambiguous identities never choose a first match. */
export function liveMapRows(input: {
  rows: readonly Row[];
  fleet?: Fleet;
  remits?: RemitsView;
  native: PluginObservedAgentDirectory;
  activity: ActivityFilter;
  host: string;
  project: string;
  search: string;
  now: number;
}): { rows: Row[]; hidden: number; truncated: number } {
  const observed = input.native.entries.map((entry) =>
    entry.activity === "working" &&
    freshness(entry.observedAt ?? undefined, input.now, false, false) === "stale"
      ? { ...entry, activity: "unknown" as const }
      : entry,
  );
  const byNative = new Map(observed.map((entry) => [key(entry.serverId, entry.agentId), entry]));
  const projectSearch = input.project.trim().toLowerCase();
  const search = input.search.trim().toLowerCase();
  const activityMatch = (activity: PluginObservedAgent["activity"] | undefined) =>
    input.activity === "all" ||
    (input.activity === "active"
      ? !!activity && ["working", "permission", "error"].includes(activity)
      : activity === input.activity);
  const nativeMatch = (entry: PluginObservedAgent) =>
    (!input.host || entry.serverId === input.host) &&
    activityMatch(entry.activity) &&
    (!projectSearch || entry.workspace?.projectName.toLowerCase().includes(projectSearch)) &&
    (!search ||
      [entry.title, entry.provider, entry.model, entry.hostName, entry.workspace?.projectName].some(
        (value) => value?.toLowerCase().includes(search),
      ));
  let hidden = 0;
  const rows: Row[] = [];
  const namedProjects = new Map(
    input.rows
      .filter((row) => row.kind === "project")
      .map((row) => [row.target.projectId, row.title]),
  );
  const knownPrimes = new Set(
    input.rows.filter((row) => row.kind === "prime").map((row) => row.id),
  );
  for (const source of input.rows) {
    let row = source;
    if (
      projectSearch &&
      row.target.projectId &&
      !namedProjects.get(row.target.projectId)?.toLowerCase().includes(projectSearch)
    ) {
      hidden++;
      continue;
    }
    if (row.kind === "project") {
      const owner =
        !input.remits?.error && !input.remits?.stale
          ? input.remits?.projects.find((project) => project.projectId === row.target.projectId)
              ?.owner
          : undefined;
      const parent = owner?.primeSeat ? `prime:${owner.primeSeat}` : null;
      const related = [...(row.related ?? [])];
      if (parent && knownPrimes.has(parent)) related.push({ from: parent, kind: "ownership" });
      row = {
        ...row,
        related,
        detail: `${row.detail} · ${parent ? `responsible main assistant: ${owner!.primeSeat}` : "responsible main assistant not recorded in this observation"}`,
      };
    }
    const matches = row.target.sessionId
      ? (input.fleet?.nodes.filter((node) => node.id === row.target.sessionId) ?? [])
      : [];
    const node = matches.length === 1 ? matches[0] : undefined;
    const target =
      node?.serverId && node.agentId ? { serverId: node.serverId, agentId: node.agentId } : null;
    const native = target ? byNative.get(key(target.serverId, target.agentId)) : undefined;
    if (row.kind === "session") {
      const name = row.target.projectId ? namedProjects.get(row.target.projectId) : undefined;
      if (
        (input.host && target?.serverId !== input.host) ||
        !activityMatch(native?.activity) ||
        (projectSearch &&
          !name?.toLowerCase().includes(projectSearch) &&
          !native?.workspace?.projectName.toLowerCase().includes(projectSearch))
      ) {
        hidden++;
        continue;
      }
    }
    const observation = native
      ? `${native.hostName} · ${words[native.activity]} · ${native.provider}${native.model ? ` / ${native.model}` : " / model unavailable"} · ${native.connection}`
      : target
        ? `${node!.host} · native activity not observed`
        : row.target.sessionId
          ? "Native host/agent identity unavailable"
          : "";
    rows.push({
      ...row,
      target: { ...row.target, ...target },
      activity: native?.activity,
      observedAt: native?.observedAt ?? node?.observedAt ?? undefined,
      connection: native?.connection,
      responsibility:
        row.kind === "prime"
          ? row.title
          : row.target.projectId
            ? `Recorded project: ${namedProjects.get(row.target.projectId) ?? "project name unavailable"}`
            : "Responsibility not recorded in this view",
      projectName: row.target.projectId
        ? namedProjects.get(row.target.projectId)
        : native?.workspace?.projectName,
      creationParent: native?.creatorAgentId
        ? (byNative.get(key(native.serverId, native.creatorAgentId))?.title ??
          "Creation parent not observed")
        : "No native creation parent observed",
      changesAvailable: Boolean(
        native?.connection === "online" && native.workspace?.changesAvailable,
      ),
      detail: [row.detail, observation].filter(Boolean).join(" · "),
      label: [row.label, native ? observation : ""].filter(Boolean).join(", "),
    });
  }
  // Controller membership is bounded. Unmatched native sessions stay explicitly unassigned IN THIS VIEW.
  const represented = new Set(
    rows.flatMap((row) =>
      row.target.serverId && row.target.agentId
        ? [key(row.target.serverId, row.target.agentId)]
        : [],
    ),
  );
  const enrolled = new Set(
    (input.fleet?.nodes ?? []).flatMap((node) =>
      node.serverId && node.agentId ? [key(node.serverId, node.agentId)] : [],
    ),
  );
  const unmatched = observed.filter(
    (entry) => !represented.has(key(entry.serverId, entry.agentId)),
  );
  const visible = unmatched.filter(nativeMatch);
  hidden += unmatched.length - visible.length;
  for (const [group, linked] of [
    ["observed-branches", true],
    ["native-unassigned", false],
  ] as const) {
    const entries = visible.filter(
      (entry) => enrolled.has(key(entry.serverId, entry.agentId)) === linked,
    );
    if (!entries.length) continue;
    const title = linked
      ? "Native work · outside expanded branches"
      : "Native sessions · not assigned in this view";
    rows.push({
      id: group,
      kind: "unplaced",
      depth: 1,
      parent: null,
      title,
      detail: linked
        ? "Enrolled work from cached native events; expand its project to see recorded relationships"
        : "No recorded responsibility link in this bounded observation",
      glyph: "?",
      label: title,
      expandable: false,
      expanded: true,
      attention: 0,
      link: null,
      target: {},
    });
    for (const entry of entries) {
      const controller = input.fleet?.nodes.filter(
        (node) => node.serverId === entry.serverId && node.agentId === entry.agentId,
      );
      // Fleet project labels/creator inheritance are not membership proof. Only a checked map row can place it.
      const projectId =
        controller?.length === 1
          ? input.rows.find(
              (row) => row.target.sessionId === controller[0].id && row.target.projectId,
            )?.target.projectId
          : undefined;
      const projectName = projectId ? namedProjects.get(projectId) : undefined;
      const creator = entry.creatorAgentId
        ? byNative.get(key(entry.serverId, entry.creatorAgentId))
        : undefined;
      rows.push({
        id: `native:${key(entry.serverId, entry.agentId)}`,
        kind: "session",
        depth: 2,
        parent: group,
        title: entry.title,
        detail: `${entry.hostName} · ${words[entry.activity]} · ${entry.provider}${entry.model ? ` / ${entry.model}` : " / model unavailable"} · ${entry.connection}${entry.workspace ? ` · ${entry.workspace.projectName} / ${entry.workspace.kind}` : " · workspace unavailable"}`,
        glyph: entry.activity === "working" ? "●" : entry.activity === "permission" ? "◐" : "?",
        label: `${entry.title}, ${entry.hostName}, ${words[entry.activity]}, ${linked ? "outside expanded branches" : "responsibility not recorded in this view"}`,
        expandable: false,
        expanded: false,
        attention: ["permission", "error"].includes(entry.activity) ? 1 : 0,
        link: "membership",
        target: { serverId: entry.serverId, agentId: entry.agentId },
        activity: entry.activity,
        observedAt: entry.observedAt ?? undefined,
        connection: entry.connection,
        responsibility: projectName
          ? `Recorded project: ${projectName}`
          : "Responsibility not recorded in this view",
        projectName: projectName ?? entry.workspace?.projectName,
        creationParent:
          creator?.title ??
          (entry.creatorAgentId ? "Creation parent not observed" : "No creation parent recorded"),
        changesAvailable:
          entry.connection === "online" && Boolean(entry.workspace?.changesAvailable),
      });
    }
  }
  let display = rows;
  if (input.activity !== "all") {
    const tasksWithSessions = new Set(
      rows.filter((row) => row.kind === "session").map((row) => row.target.taskId),
    );
    display = rows.filter(
      (row) => row.kind !== "workstream" || tasksWithSessions.has(row.target.taskId),
    );
    hidden += rows.length - display.length;
  }
  const truncated = Math.max(0, display.length - LIMITS.rows);
  return { rows: display.slice(0, LIMITS.rows), hidden, truncated };
}
