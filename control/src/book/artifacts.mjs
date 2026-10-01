import { canonical } from './protocol.mjs';
import { artifactInput, validateArtifacts } from '../control/artifacts.mjs';
import { workerArtifacts } from '../control/worker-artifacts.mjs';
export async function readBookArtifacts(receiver, session, input) {
  artifactInput(input);
  if (input.sessionId !== session.id || input.taskId !== session.task || input.expectedGeneration !== session.generation || !['human','delegated'].includes(session.mode)) throw Error('Book artifact ownership changed');
  const before = await receiver.observed(session, true), pinned = receiver.row(session.id);
  if (pinned.generation !== session.generation || pinned.mode !== session.mode || pinned.agent !== session.agent || pinned.cwd !== session.cwd || pinned.task !== session.task) throw Error('Book artifact ownership changed during observation');
  if (before.status === undefined || !Number.isSafeInteger(before.pending)) throw Error('Book artifact native state unavailable');
  const artifacts = !['idle','closed'].includes(before.status) || before.pending || before.archivedAt ? { state: 'busy', untrusted: true, files: [] } : workerArtifacts(session.cwd);
  const after = await receiver.observed(pinned, true), fresh = receiver.row(session.id);
  const identity = o => [o.boot,o.nativeId,o.humanAt,o.lastUserAt,o.status,o.pending,o.archivedAt ?? null];
  if (canonical(pinned) !== canonical(fresh) || canonical(identity(before)) !== canonical(identity(after))) throw Error('Book artifact state changed during read');
  return { sessionId: session.id, taskId: session.task, generation: session.generation, agentId: session.agent, host: 'macbook', observedAt: new Date().toISOString(), accepted: false, artifacts: validateArtifacts(artifacts, session.cwd) };
}
