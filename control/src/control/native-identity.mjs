import { uuid } from './authority.mjs';
// These are consistency checks on Paseo's record, not independent transcript provenance.
// Native request/tool identity, BOOT and timeline continuity remain separate checks.
export function nativeIdentity(a) {
  const runtimeId = a.runtimeInfo?.sessionId ?? null, persistenceId = a.persistence?.sessionId ?? null;
  let conflict = null;
  if (a.runtimeInfo?.provider != null && a.runtimeInfo.provider !== a.provider) conflict = 'Inconsistent runtime provider';
  if (runtimeId !== null && !uuid(runtimeId)) conflict = 'Invalid runtime native identity';
  if (persistenceId !== null && (!uuid(persistenceId) || a.persistence.provider !== a.provider || a.persistence.metadata?.cwd !== a.cwd)) conflict = 'Inconsistent persistence identity, provider or directory';
  if (runtimeId && persistenceId && runtimeId !== persistenceId) conflict = 'Runtime and persistence identities conflict';
  return { nativeId: conflict ? null : runtimeId ?? persistenceId, source: conflict ? 'conflict' : runtimeId ? (persistenceId ? 'both' : 'runtime') : persistenceId ? 'persistence' : 'unavailable', runtimeId, persistenceId, conflict };
}
