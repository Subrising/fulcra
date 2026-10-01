// CONTRACTS.md §5 (prime remit). Plain JavaScript for the same reason as refs.mjs and decision-rules.mjs: the
// controller (src/control/remits.mjs) enforces these rules server-side, and the plugin's Zod contract (remit.ts)
// runs them again so a malformed record is never rendered as if it were valid.
import { personalMatch } from './refs.mjs';
export const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REMIT_STATES = Object.freeze(['active', 'ended']);
export const REMIT_ACTIONS = Object.freeze(['assigned', 'moved', 'ended', 'domain-set']);
// Same minimum as a seat note (bindings.mjs), and the contract's maximum.
export const REMIT_LIMITS = Object.freeze({ noteMin: 12, note: 500, label: 80 });
export class RemitRefused extends Error {}
const keys = (a, names) => a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === names;

// The reason for a change, trimmed. Shown in the history, so it is plain words with nothing personal in it.
export function remitNote(note) {
  if (typeof note !== 'string' || note.trim().length < REMIT_LIMITS.noteMin || note.length > REMIT_LIMITS.note) throw new RemitRefused(`Give a reason of ${REMIT_LIMITS.noteMin} to ${REMIT_LIMITS.note} characters`);
  const personal = personalMatch(note); if (personal) throw new RemitRefused(`The reason contains ${personal}`);
  return note.trim();
}
// { kind: "project", projectId } | { kind: "domain", domain, label }, exactly.
export function remitScope(scope) {
  if (keys(scope, 'kind,projectId') && scope.kind === 'project' && typeof scope.projectId === 'string' && UUID.test(scope.projectId)) return { kind: 'project', projectId: scope.projectId };
  if (keys(scope, 'domain,kind,label') && scope.kind === 'domain' && typeof scope.domain === 'string' && KEY.test(scope.domain)
    && typeof scope.label === 'string' && scope.label.trim() && scope.label.length <= REMIT_LIMITS.label) {
    const personal = personalMatch(scope.label); if (personal) throw new RemitRefused(`The area name contains ${personal}`);
    return { kind: 'domain', domain: scope.domain, label: scope.label.trim() };
  }
  throw new RemitRefused('A remit covers one project, or one named area of work');
}
// The key the one-owner rule is enforced on (a partial unique index over active rows).
export const scopeKey = scope => scope.kind === 'project' ? `project:${scope.projectId}` : `domain:${scope.domain}`;

// §5.2 owner resolution: an active project remit, else the active remit for the project's area, else nobody.
// `remits` may hold ended rows; only active ones count. `domains` maps projectId -> domain key (or null).
export function resolveOwner(projectId, remits, domains) {
  const active = remits.filter(r => r.state === 'active');
  const direct = active.find(r => r.scope.kind === 'project' && r.scope.projectId === projectId);
  if (direct) return { kind: 'project', primeSeat: direct.primeSeat, remitId: direct.id };
  const domain = domains.get(projectId) ?? null;
  const area = domain ? active.find(r => r.scope.kind === 'domain' && r.scope.domain === domain) : undefined;
  if (area) return { kind: 'domain', primeSeat: area.primeSeat, remitId: area.id };
  return { kind: 'unassigned', primeSeat: null, remitId: null };
}
