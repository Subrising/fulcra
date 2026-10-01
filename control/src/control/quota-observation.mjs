// Pure quota observations: safe to import before first-run configuration exists.
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const denied = limit => limit.spendControlReached === true || nonempty(limit.rateLimitReachedType);
export function quotaBinding(q) {
  if (q?.provider !== 'codex' || !nonempty(q.sessionId) || !nonempty(q.model) || !(q.serviceTier === null || nonempty(q.serviceTier)) || !/^codex:[a-f0-9]{64}$/.test(q.accountScope ?? '')) return null;
  return { provider: q.provider, sessionId: q.sessionId, model: q.model, serviceTier: q.serviceTier, accountScope: q.accountScope };
}
export function quotaDecision(q, expected, now = Date.now()) {
  const binding = quotaBinding(q), unknown = reason => ({ state: 'unknown', reason });
  if (!binding) return unknown('Quota identity unavailable');
  if (expected && canonical(binding) !== canonical(expected)) return { state: 'changed', reason: 'Quota account or session configuration changed' };
  const at = Date.parse(q.observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(at) || at > now || now - at > 30000) return unknown('Fresh quota observation required');
  if (q.ordinaryUsageAllowed === false) return { state: 'waiting', reason: 'Provider denies ordinary usage' };
  if (q.ordinaryUsageAllowed !== true || !Array.isArray(q.limits)) return unknown('Ordinary usage permission unavailable');
  if (q.limits.some(limit => !limit || typeof limit !== 'object' || !(limit.model === null || nonempty(limit.model)) || ![true, false, null].includes(limit.spendControlReached) || !(limit.rateLimitReachedType === null || nonempty(limit.rateLimitReachedType)))) return unknown('Quota limits unavailable');
  if (q.limits.some(limit => limit.model === binding.model && denied(limit))) return { state: 'waiting', reason: 'Provider denies selected model usage' };
  if (q.limits.some(limit => !limit.model && denied(limit))) return unknown('Exhausted quota cannot be mapped to a model');
  // Percentages and reset times are observations, never a permission to resume.
  return { state: 'ready', reason: 'Provider permits ordinary usage; no selected-model denial observed' };
}
