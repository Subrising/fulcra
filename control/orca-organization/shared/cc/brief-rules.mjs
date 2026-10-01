// CONTRACTS.md §4 (project brief). Shared by the controller (src/control/briefs.mjs), which validates every
// published brief, and the plugin's Zod contract (brief.ts). `noPersonal` refuses; `plainLanguageCheck` only
// warns, so an orchestrator is told what a busy reader would stumble on without losing the update.
import { parseRef, personalMatch, plainLanguageCheck } from './refs.mjs';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEALTH = Object.freeze(['on-track', 'at-risk', 'blocked', 'idle']);
export const SEVERITY = Object.freeze(['low', 'medium', 'high']);
export const BRIEF_LIMITS = Object.freeze({ headline: 140, now: 600, items: 5, itemText: 200, mitigation: 200, evidence: 8, evidenceLabel: 120 });
// What an author writes. version, revision, author and writtenAt are the server's.
export const AUTHORED_FIELDS = Object.freeze(['projectId', 'health', 'headline', 'now', 'next', 'needsYou', 'risks', 'shipped', 'evidence']);
// §4.1 stale: written more than 24 h ago, or the project was active more than 6 h after it was written.
export const STALE_AGE_MS = 24 * 3600000;
export const STALE_ACTIVITY_MS = 6 * 3600000;
export class BriefRefused extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, names) => plain(v) && Object.keys(v).sort().join() === [...names].sort().join();

export function validateBrief(input) {
  if (!plain(input) || Object.keys(input).some(k => !AUTHORED_FIELDS.includes(k)) || AUTHORED_FIELDS.some(k => !(k in input)))
    throw new BriefRefused(`A brief has exactly these fields: ${AUTHORED_FIELDS.join(', ')}`);
  const warnings = [];
  const text = (value, field, max, { allowEmpty = false } = {}) => {
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new BriefRefused(`${field} must be ${allowEmpty ? '' : 'non-empty '}text of at most ${max} characters`);
    const personal = personalMatch(value); if (personal) throw new BriefRefused(`${field} contains ${personal}`);
    const found = plainLanguageCheck(value); if (found.length) warnings.push({ field, found });
    return value.trim();
  };
  const list = (value, field, max, each) => {
    if (!Array.isArray(value) || value.length > max) throw new BriefRefused(`${field} is a list of at most ${max} items`);
    return value.map((item, i) => each(item, `${field}[${i}]`));
  };
  if (typeof input.projectId !== 'string' || !UUID.test(input.projectId)) throw new BriefRefused('projectId must be a project id');
  if (!HEALTH.includes(input.health)) throw new BriefRefused(`health is one of ${HEALTH.join(', ')}`);
  const L = BRIEF_LIMITS;
  const brief = {
    projectId: input.projectId, health: input.health,
    headline: text(input.headline, 'headline', L.headline),
    now: text(input.now, 'now', L.now),
    next: list(input.next, 'next', L.items, (x, f) => {
      if (!exact(x, ['text', 'by'])) throw new BriefRefused(`${f} has exactly text and by`);
      if (x.by !== null && (typeof x.by !== 'string' || !DATE.test(x.by) || Number.isNaN(Date.parse(x.by)))) throw new BriefRefused(`${f}.by is a date (YYYY-MM-DD) or null`);
      return { text: text(x.text, `${f}.text`, L.itemText), by: x.by };
    }),
    needsYou: list(input.needsYou, 'needsYou', L.items, (x, f) => {
      if (!exact(x, ['text', 'decision'])) throw new BriefRefused(`${f} has exactly text and decision`);
      if (x.decision !== null && (typeof x.decision !== 'string' || !UUID.test(x.decision))) throw new BriefRefused(`${f}.decision is a decision id or null`);
      return { text: text(x.text, `${f}.text`, L.itemText), decision: x.decision };
    }),
    risks: list(input.risks, 'risks', L.items, (x, f) => {
      if (!exact(x, ['text', 'severity', 'mitigation'])) throw new BriefRefused(`${f} has exactly text, severity and mitigation`);
      if (!SEVERITY.includes(x.severity)) throw new BriefRefused(`${f}.severity is one of ${SEVERITY.join(', ')}`);
      return { text: text(x.text, `${f}.text`, L.itemText), severity: x.severity, mitigation: text(x.mitigation, `${f}.mitigation`, L.mitigation, { allowEmpty: true }) };
    }),
    shipped: list(input.shipped, 'shipped', L.items, (x, f) => {
      if (!exact(x, ['text', 'ref'])) throw new BriefRefused(`${f} has exactly text and ref`);
      if (x.ref !== null && !parseRef(x.ref)) throw new BriefRefused(`${f}.ref is a reference or null`);
      return { text: text(x.text, `${f}.text`, L.itemText), ref: x.ref };
    }),
    // Evidence is where ids belong (behind "Details"), so only the label is held to plain language.
    evidence: list(input.evidence, 'evidence', L.evidence, (x, f) => {
      if (!exact(x, ['ref', 'label'])) throw new BriefRefused(`${f} has exactly ref and label`);
      if (!parseRef(x.ref)) throw new BriefRefused(`${f}.ref is not a valid reference`);
      return { ref: x.ref, label: text(x.label, `${f}.label`, L.evidenceLabel) };
    }),
  };
  return { brief, warnings };
}

// `now` and the two times are epoch ms or ISO strings. No brief is never stale: there is nothing to be out of date.
export function briefStale({ writtenAt, lastActivityAt = null, now = Date.now() }) {
  const ms = v => typeof v === 'number' ? v : Date.parse(v);
  if (writtenAt == null) return false;
  const written = ms(writtenAt), current = ms(now);
  if (!Number.isFinite(written)) return true;
  if (current - written > STALE_AGE_MS) return true;
  const active = lastActivityAt == null ? NaN : ms(lastActivityAt);
  return Number.isFinite(active) && active - written > STALE_ACTIVITY_MS;
}
