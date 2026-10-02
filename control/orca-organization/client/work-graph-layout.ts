import { workName, sessionName, sessionStatus, sessionRole } from "./work-labels";
import type { Fleet } from "../shared/fleet";
import type { historyRpc } from "../shared/history";
import type { TrackerView } from "../shared/trackers";
export type Page = ReturnType<typeof historyRpc.output.parse>;
export interface GraphPage {
  data: Page | undefined;
  historical: boolean;
  stale: boolean;
  loading: boolean;
}
export interface WorkNode {
  id: string;
  kind: "task" | "session" | "event" | "file" | "tracker-issue";
  title: string;
  detail: string;
  target: string;
  x: number;
  y: number;
  url?: string;
}
export interface WorkEdge {
  id: string;
  from: string;
  to: string;
  kind: "membership" | "supervision" | "event" | "reported" | "tracks";
  active: boolean;
}
export const CARD = { width: 240, height: 84 },
  LIMITS = { nodes: 578, edges: 642 };
// J3: tracker items are additive, with their own ceilings, in a column right of reported paths.
export const TRACKER_LIMITS = { nodes: 64, edges: 128 },
  TRACKER_X = 1312;
export function edgeSegments(a: WorkNode, b: WorkNode, kind: WorkEdge["kind"]) {
  const x = a.x + CARD.width,
    y = a.y + CARD.height / 2,
    endY = b.y + CARD.height / 2;
  const points =
    kind === "supervision"
      ? [
          [x, y],
          [x + 36, y],
          [x + 36, endY + (a.id === b.id ? 24 : 0)],
          [b.x + CARD.width, endY],
        ]
      : [
          [x, y],
          [b.x, endY],
        ];
  return points.slice(1).map((p, i) => [points[i][0], points[i][1], p[0], p[1]] as const);
}
export function workGraph(
  fleet: Fleet,
  shown: Fleet["nodes"],
  selected: string | null,
  page?: GraphPage,
  trackers?: TrackerView,
) {
  const nodes: WorkNode[] = [],
    edges: WorkEdge[] = [],
    unique = [...new Map(shown.slice(0, 64).map((n) => [n.id, n])).values()].sort(
      (a, b) => a.task.localeCompare(b.task) || a.id.localeCompare(b.id),
    );
  const add = (node: WorkNode) => {
    nodes.push(node);
    return node.id;
  };
  const link = (from: string, to: string, kind: WorkEdge["kind"], active = true) => {
    const id = JSON.stringify([from, to, kind, active]);
    if (!edges.some((e) => e.id === id)) edges.push({ id, from, to, kind, active });
  };
  for (const [index, n] of unique.entries()) {
    const taskId = "task:" + n.task,
      sessionId = "session:" + n.id,
      y = 40 + index * 112;
    if (!nodes.some((t) => t.id === taskId)) {
      const task = fleet.tasks.find((t) => t.id === n.task);
      add({
        id: taskId,
        kind: "task",
        target: n.task,
        title: task
          ? `${task.identifier ?? "Task"} · ${workName(task.title)}`
          : "Task name unavailable",
        detail: "Enrolled task membership",
        x: 24,
        y,
      });
    }
    const parents = fleet.edges
      .slice(0, 128)
      .filter((e) => e.to === n.id)
      .slice(0, 2)
      .map(
        (e) =>
          `${e.active ? "Active supervision" : "Saved link"} from ${sessionName(fleet.nodes.find((p) => p.id === e.from) ?? { ...n, title: "Unavailable session" }, fleet).slice(0, 64)}`,
      );
    add({
      id: sessionId,
      kind: "session",
      target: n.id,
      title: sessionName(n, fleet),
      detail: `${sessionRole(n, fleet)} · ${sessionStatus(n)} · ${n.host} · ${n.provider}${n.error ? " · observation error" : ""}${parents.length ? " · " + parents.join("; ") + " (see list for all links)" : ""}`,
      x: 340,
      y,
    });
    link(taskId, sessionId, "membership");
  }
  for (const e of fleet.edges.slice(0, 128))
    if (unique.some((n) => n.id === e.from) && unique.some((n) => n.id === e.to))
      link("session:" + e.from, "session:" + e.to, "supervision", e.active);
  const chosen = unique.find((n) => n.id === selected),
    source = nodes.find((n) => n.id === "session:" + selected);
  if (chosen && source && page?.data?.sessionId === chosen.id && page.data.taskId === chosen.task) {
    let y = source.y;
    for (const [index, event] of page.data.activity.slice(0, 50).entries()) {
      const id = JSON.stringify(["event", chosen.task, chosen.id, event.id, index]);
      add({
        id,
        kind: "event",
        target: id,
        title: event.label,
        detail: event.state ?? event.kind,
        x: 680,
        y,
      });
      link(source.id, id, "event");
      const files = event.files.slice(0, 8);
      for (const [j, file] of files.entries()) {
        const fileId = JSON.stringify([id, "path", file, j]);
        add({
          id: fileId,
          kind: "file",
          target: fileId,
          title: file,
          detail: "Reported path · change unverified",
          x: 996,
          y: y + j * 100,
        });
        link(id, fileId, "reported");
      }
      y += Math.max(1, files.length) * 100;
    }
  }
  // Only LINKED tracker items appear, and only when their subject (a task/workstream or a session) is on the
  // graph. Titles are plain text from the server; the URL is the server-constructed one.
  if (trackers) {
    const present = new Set(nodes.map((n) => n.id)),
      items = new Map(trackers.items.map((i) => [i.key, i]));
    let placed = 0,
      tracks = 0;
    for (const l of trackers.links.slice(0, 256)) {
      const subject = (l.subject.kind === "task" ? "task:" : "session:") + l.subject.id,
        it = items.get(l.itemKey),
        id = "tracker:" + l.itemKey;
      if (!present.has(subject) || !it) continue;
      if (!present.has(id)) {
        if (placed >= TRACKER_LIMITS.nodes) continue;
        add({
          id,
          kind: "tracker-issue",
          target: l.itemKey,
          url: it.url,
          title: `${it.ref} · ${it.title ?? "not yet observed"}`,
          detail: `${l.itemKey.split(":")[0]} · ${it.state}${it.stale ? " · STALE" : ""}${it.fromPreviousMapping ? " · previous mapping" : ""}`,
          x: TRACKER_X,
          y: 40 + placed * 112,
        });
        present.add(id);
        placed += 1;
      }
      if (tracks < TRACKER_LIMITS.edges) {
        const before = edges.length;
        link(subject, id, "tracks", !it.fromPreviousMapping);
        tracks += edges.length - before;
      }
    }
  }
  return {
    nodes,
    edges,
    width: Math.max(640, ...nodes.map((n) => n.x + CARD.width + 24)),
    height: Math.max(320, ...nodes.map((n) => n.y + CARD.height + 24)),
  };
}
export function graphOffset(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { width: number; height: number },
  zoom: number,
) {
  const clamp = (n: number, max: number) =>
    Number.isFinite(n) ? Math.max(0, Math.min(n, Math.max(0, max))) : 0;
  return {
    x: clamp(x, width * zoom - viewport.width),
    y: clamp(y, height * zoom - viewport.height),
  };
}
