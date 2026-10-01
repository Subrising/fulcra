import type { Fleet } from "../shared/fleet";
import { readableUpdate } from "./readable-update";

type Node = Fleet["nodes"][number];
/** Names are presentation only. Navigation always retains the original IDs. */
export function workName(value: string | null | undefined, fallback = "Task name unavailable") {
  if (!value?.trim() || /^(?:Retained task(?: · .*)?|Saved conversation|Book conversation|[a-f\d]{8,64}(?:-[a-f\d]+)*)$/i.test(value.trim())) return fallback;
  return readableUpdate(value).trim() || fallback;
}
export function sessionName(node: Node, fleet?: Fleet) {
  const host = node.host || "saved";
  const unnamed = `Untitled ${host} conversation`;
  const title = workName(node.title, unnamed);
  if (title !== unnamed || !fleet) return title;
  const peers = fleet.nodes.filter(n => n.task === node.task && n.host === node.host && workName(n.title, unnamed) === unnamed).sort((a, b) => a.id.localeCompare(b.id));
  return peers.length > 1 ? `${unnamed} ${peers.findIndex(n => n.id === node.id) + 1}` : unnamed;
}
export function sessionStatus(node: Node, stale = false) {
  if (node.pending) return "Needs you · permission pending";
  if (stale || node.status === "unavailable") return "Status unavailable";
  if (node.error || node.status === "error") return "Needs attention";
  if (node.status === "running") return "Working now";
  if (node.status === "idle") return "Idle";
  if (node.status === "closed") return "Saved";
  if (node.status === "initializing") return "Starting conversation";
  return "Status unavailable";
}
export function sessionRole(node: Node, fleet: Fleet) {
  if (fleet.supervisionAvailable !== true) return "Leadership unavailable";
  const parents = fleet.supervisors?.filter(s => s.task === node.task && s.id !== node.id && s.workers.some(w => w.workerId === node.id && w.ownership === "linked")) ?? [];
  const leader = fleet.supervisors?.some(s => s.id === node.id && s.task === node.task);
  if (parents.length) return `${leader ? "Worker / leader" : "Worker"} for ${parents.map(p => { const n = fleet.nodes.find(n => n.id === p.id); return n ? sessionName(n, fleet) : "unavailable leader"; }).join(", ")}`;
  return leader ? "Lead orchestrator" : "No leader recorded";
}
