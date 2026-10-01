// CONTRACTS.md §3.1–§3.2: the decision packet an agent may ask, validated once, in plain JavaScript, so the
// controller (the authority, src/control/decisions.mjs) and the plugin's Zod contracts (decision.ts) enforce
// exactly the same rules. The controller never trusts the plugin's check; the plugin repeats it so a bad
// packet is refused with the same words wherever it is caught.
import { parseRef, personalMatch, plainLanguageCheck, sentenceCount } from './refs.mjs';
export const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const KINDS = Object.freeze(['decision', 'approval', 'question']);
export const STATES = Object.freeze(['open', 'chosen', 'withdrawn', 'superseded', 'expired']);
export const REVERSIBILITY = Object.freeze(['reversible', 'reversible-with-effort', 'irreversible']);
export const CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
// The app platforms `organization.decision-choose` may state (CONTRACTS v1.2 §3.3); the rest of VIA are channels.
export const APP_VIA = Object.freeze(['app-mac', 'app-ios', 'app-android', 'app-windows', 'app-linux', 'app-web']);
export const VIA = Object.freeze(['app-mac', 'app-ios', 'app-android', 'app-windows', 'app-linux', 'app-web', 'discord-openclaw', 'session', 'cli']);
// Bounds from §3.1, named once.
export const LIMITS = Object.freeze({ title: 120, situation: 600, optionTitle: 80, optionSummary: 400, example: 300, benefit: 300, cost: 200, time: 120, risk: 300,
  why: 400, wouldChangeIf: 300, evidence: 16, evidenceLabel: 120, note: 500, options: 3, situationSentences: 3, summarySentences: 2 });
// A question with no options is answered in words; the choice records this reserved option id.
export const FREE_TEXT_OPTION = 'answer';
// The fields an agent may send. Everything else in §3.1 is stamped by the server.
export const ASK_FIELDS = Object.freeze(['kind', 'level', 'projectId', 'taskId', 'askedOf', 'title', 'situation', 'options', 'recommendation', 'evidence', 'action', 'expiresAt']);
export class PacketRefused extends Error {}
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = message => { throw new PacketRefused(message); };
function onlyKeys(value, allowed, where) {
  if (!isObject(value)) refuse(`${where} must be an object`);
  for (const k of Object.keys(value)) if (!allowed.includes(k)) refuse(`${where} has an unknown field "${k}"`);
}
function text(value, max, where, { min = 1 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) refuse(`${where} must be text of ${min}–${max} characters`);
  const personal = personalMatch(value);
  if (personal) refuse(`${where} contains ${personal}; stored text must be portable and personal-data free`);
  return value.trim();
}
const nullable = (value, fn) => value === undefined || value === null ? null : fn(value);
const datetime = (value, where) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) refuse(`${where} must be a date and time with an offset`);
  return new Date(value).toISOString();
};
function action(value) {
  if (value === undefined || value === null) return { type: 'none' };
  if (!isObject(value)) refuse('action must be an object');
  switch (value.type) {
    case 'none': onlyKeys(value, ['type'], 'action'); return { type: 'none' };
    case 'promotion': case 'refresh': case 'environment-change': {
      const idKey = { promotion: 'promotionId', refresh: 'refreshId', 'environment-change': 'environmentId' }[value.type];
      onlyKeys(value, ['type', idKey, 'digest'], 'action');
      if (!UUID.test(value[idKey] ?? '')) refuse(`action.${idKey} must be an id`);
      if (!SHA256.test(value.digest ?? '')) refuse('action.digest must be a sha256');
      return { type: value.type, [idKey]: value[idKey], digest: value.digest };
    }
    case 'change': {
      onlyKeys(value, ['type', 'prRef', 'digest'], 'action');
      if (parseRef(value.prRef)?.kind !== 'pr') refuse('action.prRef must be a pr ref');
      if (!SHA256.test(value.digest ?? '')) refuse('action.digest must be a sha256');
      return { type: 'change', prRef: value.prRef, digest: value.digest };
    }
    default: return refuse('action.type must be none, promotion, refresh, change or environment-change');
  }
}
function option(value, i) {
  const where = `options[${i}]`;
  onlyKeys(value, ['id', 'title', 'summary', 'example', 'impacts', 'destructive'], where);
  if (typeof value.id !== 'string' || !KEY.test(value.id)) refuse(`${where}.id must be a short lower-case key`);
  onlyKeys(value.impacts, ['benefit', 'cost', 'time', 'risk', 'reversibility', 'blastRadius'], `${where}.impacts`);
  const im = value.impacts;
  if (!REVERSIBILITY.includes(im.reversibility)) refuse(`${where}.impacts.reversibility must be reversible, reversible-with-effort or irreversible`);
  const blast = nullable(im.blastRadius, r => ['archmap', 'pr', 'promotion'].includes(parseRef(r)?.kind) ? r : refuse(`${where}.impacts.blastRadius must be an archmap, pr or promotion ref`));
  if (value.destructive !== undefined && typeof value.destructive !== 'boolean') refuse(`${where}.destructive must be true or false`);
  return { id: value.id, title: text(value.title, LIMITS.optionTitle, `${where}.title`), summary: text(value.summary, LIMITS.optionSummary, `${where}.summary`),
    example: nullable(value.example, v => text(v, LIMITS.example, `${where}.example`)),
    impacts: { benefit: text(im.benefit, LIMITS.benefit, `${where}.impacts.benefit`), cost: text(im.cost, LIMITS.cost, `${where}.impacts.cost`), time: text(im.time, LIMITS.time, `${where}.impacts.time`),
      risk: text(im.risk, LIMITS.risk, `${where}.impacts.risk`), reversibility: im.reversibility, blastRadius: blast },
    // §3.2 #3 v1.5 (R-J3-5): an irreversible option always takes the second tap, whatever the asker set.
    destructive: value.destructive === true || im.reversibility === 'irreversible' };
}
// Structure (§3.1) and invariants #1, #2 and #9 (§3.2). `atAsk: false` re-checks a stored packet, whose expiry
// may rightly be past. Returns the normalized packet body and the level 2–3
// plain-language warnings; throws PacketRefused with a sentence the asker can act on.
export function validateAsk(input, { atAsk = true } = {}) {
  onlyKeys(input, ASK_FIELDS, 'packet');
  const kind = KINDS.includes(input.kind) ? input.kind : refuse('kind must be decision, approval or question');
  const level = [1, 2, 3].includes(input.level) ? input.level : refuse('level must be 1, 2 or 3');
  const projectId = nullable(input.projectId, v => UUID.test(v) ? v : refuse('projectId must be an id'));
  const taskId = nullable(input.taskId, v => UUID.test(v) ? v : refuse('taskId must be an id'));
  let askedOf;
  if (input.askedOf === 'human') askedOf = 'human';
  else { onlyKeys(input.askedOf, ['seat'], 'askedOf'); askedOf = KEY.test(input.askedOf.seat ?? '') ? { seat: input.askedOf.seat } : refuse('askedOf must be "human" or a seat'); }
  if (!Array.isArray(input.options) || input.options.length > LIMITS.options) refuse(`options must be a list of at most ${LIMITS.options}`);
  const options = input.options.map(option);
  const recommendation = nullable(input.recommendation, r => {
    onlyKeys(r, ['optionId', 'why', 'confidence', 'wouldChangeIf'], 'recommendation');
    if (!CONFIDENCE.includes(r.confidence)) refuse('recommendation.confidence must be low, medium or high');
    return { optionId: typeof r.optionId === 'string' ? r.optionId : refuse('recommendation.optionId must name an option'), why: text(r.why, LIMITS.why, 'recommendation.why'),
      confidence: r.confidence, wouldChangeIf: text(r.wouldChangeIf, LIMITS.wouldChangeIf, 'recommendation.wouldChangeIf') };
  });
  const evidenceIn = input.evidence ?? [];
  if (!Array.isArray(evidenceIn) || evidenceIn.length > LIMITS.evidence) refuse(`evidence must be a list of at most ${LIMITS.evidence}`);
  const evidence = evidenceIn.map((e, i) => { onlyKeys(e, ['ref', 'label'], `evidence[${i}]`); if (!parseRef(e.ref)) refuse(`evidence[${i}].ref is not a valid ref`); return { ref: e.ref, label: text(e.label, LIMITS.evidenceLabel, `evidence[${i}].label`) }; });
  const packet = { kind, level, projectId, taskId, askedOf, title: text(input.title, LIMITS.title, 'title'), situation: text(input.situation, LIMITS.situation, 'situation'),
    options, recommendation, evidence, action: action(input.action), expiresAt: nullable(input.expiresAt, v => datetime(v, 'expiresAt')) };
  if (atAsk && packet.expiresAt && Date.parse(packet.expiresAt) <= Date.now()) refuse('expiresAt must be in the future');
  // #2: unique option ids, and a recommendation that points at one of them.
  const ids = options.map(o => o.id);
  if (new Set(ids).size !== ids.length) refuse('Option ids must be unique');
  if (recommendation && !ids.includes(recommendation.optionId)) refuse('The recommendation must point at one of the options');
  // #1: option counts by kind and level.
  if (kind === 'decision' && level === 1 && (options.length < 2 || !recommendation)) refuse('A level-1 decision needs 2 or 3 options and a recommendation');
  if (kind === 'decision' && level > 1 && options.length < 1) refuse('A decision needs 1 to 3 options');
  if (kind === 'approval') {
    const set = new Set(ids);
    if (!set.has('approve') || !set.has('reject') || [...set].some(id => !['approve', 'reject', 'defer'].includes(id))) refuse('An approval has exactly the options approve and reject, and optionally defer');
    if (packet.action.type === 'none') refuse('An approval must be bound to an action');
  }
  // §3.2 #4 v1.5 (R-J3-4): only an approval is bound to an action, so only an approve choice can authorize one.
  if (packet.action.type !== 'none' && kind !== 'approval') refuse('Only an approval can be bound to an action');
  if (kind === 'question' && ids.includes(FREE_TEXT_OPTION)) refuse(`"${FREE_TEXT_OPTION}" is reserved for a free-text answer`);
  // #9: written for a busy CEO. Level 1 refuses; levels 2–3 carry the same findings as warnings.
  const findings = plainLanguageFindings(packet);
  if (level === 1) {
    const missing = options.filter(o => !o.example).map(o => o.title);
    if (missing.length) refuse(`Every option in a level-1 packet needs an everyday example; missing for: ${missing.join(', ')}`);
    if (findings.length) refuse(`Not plain language: ${findings.join('; ')}. Put technical detail in evidence, where it appears under Details`);
  }
  return { packet, warnings: level === 1 ? [] : findings };
}
// Every §3.2 #9 finding for the fields the owner reads, as sentences naming the field.
export function plainLanguageFindings(p) {
  const out = [], check = (where, value) => { const found = plainLanguageCheck(value); if (found.length) out.push(`${where} contains ${found.join(', ')}`); };
  check('title', p.title); check('situation', p.situation);
  for (const [i, o] of p.options.entries()) { check(`options[${i}].title`, o.title); check(`options[${i}].summary`, o.summary); if (o.example) check(`options[${i}].example`, o.example); }
  if (p.recommendation) check('recommendation.why', p.recommendation.why);
  if (sentenceCount(p.situation) > LIMITS.situationSentences) out.push(`situation has more than ${LIMITS.situationSentences} sentences`);
  for (const [i, o] of p.options.entries()) if (sentenceCount(o.summary) > LIMITS.summarySentences) out.push(`options[${i}].summary has more than ${LIMITS.summarySentences} sentences`);
  return out;
}
// Canonical JSON (sorted keys, no whitespace): what an action digest is the sha256 of (§3.2 #4).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
// What the bound action names, for the binder that recomputes its digest.
export const actionTarget = a => a.type === 'promotion' ? a.promotionId : a.type === 'refresh' ? a.refreshId : a.type === 'change' ? a.prRef : a.type === 'environment-change' ? a.environmentId : null;
