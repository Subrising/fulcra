// CONTRACTS.md §2.2 (links, allowed pairs, provenance). Plain JavaScript, shared by the controller (which
// stores and refuses) and the plugin (which infers and renders), so the allowed-pairs table exists once.
import { parseRef, noPersonal } from "./refs.mjs";
export const RELATIONS = Object.freeze([
  "worked-by",
  "produced",
  "fixes",
  "implements",
  "reviewed-by",
  "deployed",
  "decided-by",
  "supersedes",
]);
export const PROVENANCE = Object.freeze(["manual", "reported", "inferred"]);
export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);
export const LINK_STATES = Object.freeze(["active", "removed"]);
export const EVIDENCE_MAX = 300;
// relation -> [from kinds, to kinds]. Everything else is refused.
export const ALLOWED_PAIRS = Object.freeze({
  "worked-by": [
    ["issue", "pr"],
    ["session", "task"],
  ],
  produced: [
    ["session", "task"],
    ["commit", "pr", "archmap", "deploy"],
  ],
  fixes: [["pr"], ["issue"]],
  implements: [
    ["pr", "commit"],
    ["decision", "task"],
  ],
  "reviewed-by": [["pr", "commit", "task"], ["session"]],
  deployed: [["deploy"], ["commit"]],
  "decided-by": [["task", "promotion", "env"], ["decision"]],
  supersedes: [["session"], ["session"]],
});
export const NOT_ALLOWED = "That kind of link is not allowed";
// Null when the pair is allowed, else the plain reason.
export function pairProblem(from, relation, to) {
  const f = parseRef(from),
    t = parseRef(to);
  if (!f || !t) return "That link names something Fulcra cannot identify";
  if (!Object.hasOwn(ALLOWED_PAIRS, relation)) return NOT_ALLOWED;
  const [froms, tos] = ALLOWED_PAIRS[relation];
  if (!froms.includes(f.kind) || !tos.includes(t.kind)) return NOT_ALLOWED;
  if (from === to) return NOT_ALLOWED;
  return null;
}
export const allowedPair = (from, relation, to) => pairProblem(from, relation, to) === null;
// Precedence (§2.2): manual beats everything; otherwise reported beats inferred, then higher confidence.
const PROVENANCE_RANK = { inferred: 1, reported: 2, manual: 3 },
  CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };
export const strength = (l) => PROVENANCE_RANK[l.provenance] * 10 + CONFIDENCE_RANK[l.confidence];
// What an automatic (reported/inferred) observation may do to the stored row:
//   'insert'  no row yet;
//   'upgrade' the row is automatic, active and weaker;
//   'keep'    anything else. A manual row is never touched, and a removed row is never re-inferred.
export function automaticWrite(existing, incoming) {
  if (!existing) return "insert";
  if (existing.provenance === "manual" || existing.state === "removed") return "keep";
  return strength(incoming) > strength(existing) ? "upgrade" : "keep";
}
export function evidenceProblem(evidence) {
  if (typeof evidence !== "string" || !evidence.trim() || evidence.length > EVIDENCE_MAX)
    return "Evidence must be a short sentence";
  if (!noPersonal(evidence)) return "Evidence contains personal or host-specific data";
  return null;
}
