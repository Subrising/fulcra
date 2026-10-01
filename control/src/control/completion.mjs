import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export async function completionFor(agent, messageId, saved) {
  if (!saved?.cursor?.epoch || !Number.isSafeInteger(saved.cursor.seq)) throw Error('Durable pre-send timeline cursor required');
  const progress = structuredClone(saved); let bytes = 0, ended = false, more = true;
  for (let n = 0; n < 10; n++) {
    const page = await agent.timeline.refetch({ direction: 'after', cursor: progress.cursor, projection: 'canonical', limit: 100 });
    if (page.epoch !== progress.cursor.epoch || page.gap || page.reset || page.staleCursor || page.error) throw Error('Completion timeline epoch or continuity changed');
    for (const e of page.entries) {
      if (e.seqEnd <= progress.cursor.seq) continue;
      if (!progress.found && e.item?.type === 'user_message' && e.item.clientMessageId === `orca-control:${messageId}`) { progress.found = true; progress.promptSequence = e.seqStart; progress.turnId = e.turnId ?? null; }
      else if (progress.found && e.item?.type === 'user_message') { ended = true; break; }
      else if (progress.found && e.item?.type === 'assistant_message' && e.turnId === progress.turnId) {
        const separator = progress.messageId && progress.messageId !== e.item.messageId ? '\n' : '', text = separator + e.item.text;
        progress.outputPreview = ((progress.outputPreview ?? '') + text).slice(-8192); progress.outputLength = (progress.outputLength ?? 0) + text.length;
        progress.outputEvidenceHash = hash((progress.outputEvidenceHash ?? '') + JSON.stringify([e.seqStart,e.item.messageId,text])); progress.messageId = e.item.messageId ?? null;
      }
      progress.cursor = { epoch: page.epoch, seq: e.seqEnd };
    }
    bytes += Buffer.byteLength(JSON.stringify(page.entries)); more = page.hasNewer;
    if (ended || !more || bytes >= 1048576) break;
    if (!page.entries.length) throw Error('Timeline cursor made no progress');
  }
  if (!ended && !more) {
    const tail = await agent.timeline.refetch({ limit: 1, projection: 'canonical' });
    if (tail.epoch !== progress.cursor.epoch || tail.gap || tail.reset || tail.staleCursor || tail.error) throw Error('Completion timeline changed during final observation');
    const idle = ['idle','closed','error'].includes(tail.agent?.status) && !tail.agent?.pendingPermissions?.length;
    ended = !!progress.found && idle && tail.window.maxSeq <= progress.cursor.seq;
    // DESIGN-R R-M16. Once the host (R3a) reports a dead turn as idle, "quiet and idle" no longer means the turn
    // finished. A host-recorded interruption of the turn our prompt started ends it as INTERRUPTED, never as
    // completion: ended stays true (nothing more will arrive) and `interrupted` says why.
    const mark = tail.agent?.interruptedTurn;
    if (ended && mark && progress.found && (mark.lastUserMessageAt == null || mark.lastUserMessageAt === (tail.agent?.lastUserMessageAt ?? null))) progress.interrupted = true;
    if (!progress.found && idle && tail.window.maxSeq <= progress.cursor.seq) throw Error('Correlated prompt absent from native timeline');
  }
  return { progress, epoch: progress.cursor.epoch, promptSequence: progress.promptSequence ?? null, turnId: progress.turnId ?? null, ended, interrupted: !!progress.interrupted, outputObserved: !!progress.outputLength, outputEvidenceHash: progress.outputEvidenceHash ?? null, outputPreview: progress.outputPreview ?? '', outputTruncated: progress.outputLength > 8192, note: 'Incremental native evidence; turn ended does not establish success or task acceptance' };
}
