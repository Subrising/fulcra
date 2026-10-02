export async function permissionResultFor(agent, callId, cursor) {
  if (typeof callId !== "string" || !cursor?.epoch || !Number.isSafeInteger(cursor.seq))
    throw Error("Permission tool correlation missing");
  let next = cursor,
    bytes = 0,
    caughtUp = false;
  for (let n = 0; n < 10; n++) {
    const page = await agent.timeline.refetch({
      direction: "after",
      cursor: next,
      projection: "canonical",
      limit: 100,
    });
    if (page.epoch !== cursor.epoch || page.gap || page.reset || page.staleCursor || page.error)
      throw Error("Permission tool timeline continuity changed");
    for (const e of page.entries) {
      if (e.item?.type === "tool_call" && e.item.callId === callId && e.item.status !== "running")
        return { state: e.item.status, callId, epoch: page.epoch, sequence: e.seqEnd };
      if (e.seqEnd > next.seq) next = { epoch: page.epoch, seq: e.seqEnd };
    }
    bytes += Buffer.byteLength(JSON.stringify(page.entries));
    caughtUp = !page.hasNewer;
    if (!page.hasNewer || bytes > 1048576) break;
    if (!page.entries.length) throw Error("Permission timeline cursor made no progress");
  }
  return { state: "pending", cursor: next, caughtUp };
}
