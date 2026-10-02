import test from "node:test";
import assert from "node:assert/strict";
// Private test configuration first: some plugin modules read it when they load.
import "./portable.fixture";
import { readHistory } from "./history";
test("Mini excerpts share the observed page and refuse cross-view continuation while metadata stays content-free", async () => {
  const f = fixture();
  f.paseo.agents.ref = () => ({
    refresh: f.refresh,
    timeline: {
      refetch: async (a: any) => {
        const p = await f.timeline(a);
        p.entries[49].item = {
          type: "assistant_message",
          text: "Tests exposed a receipt retry bug.",
        } as any;
        return p;
      },
    },
  });
  const metadata = await readHistory(f.a, f.paseo, f.call);
  assert(!("messages" in metadata));
  assert(!JSON.stringify(metadata).includes("receipt retry bug"));
  const report = await readHistory({ ...f.a, includeMessages: true }, f.paseo, f.call);
  assert.equal(report.messages?.[0].text, "Tests exposed a receipt retry bug.");
  assert.equal(report.messages?.[0].id, "100");
  await assert.rejects(
    readHistory({ ...f.a, cursor: metadata.cursor, includeMessages: true }, f.paseo, f.call),
    /cursor identity/,
  );
  await assert.rejects(
    readHistory({ ...f.a, cursor: report.cursor }, f.paseo, f.call),
    /cursor identity/,
  );
  const ref = f.paseo.agents.ref;
  f.paseo.agents.ref = () => ({
    ...ref(),
    refresh: async () => {
      throw Error("offline");
    },
  });
  const failed = await readHistory({ ...f.a, includeMessages: true }, f.paseo, f.call);
  assert.equal(failed.messages, undefined);
  f.paseo.agents.ref = ref;
});
test("Book excerpt responses require explicit support and matching message anchors", async () => {
  const f = fixture("macbook"),
    value: any = {
      sessionId: id(1),
      taskId: task,
      agentId: id(2),
      nativeId: id(3),
      observedAt: new Date().toISOString(),
      hasOlder: false,
      skippedCount: 0,
      withheldPaths: 0,
      activity: [
        { id: "1", kind: "assistant_message", label: "Assistant response", state: null, files: [] },
      ],
      cursor: null,
      messages: [{ id: "1", role: "agent", text: "Draft ready for review.", truncated: false }],
    };
  const read = (v: any, includeMessages?: true) =>
    readHistory({ ...f.a, ...(includeMessages ? { includeMessages } : {}) }, f.paseo, (m, a) =>
      m === "book-activity-page" ? Promise.resolve(v) : f.call(m, a),
    );
  assert.equal((await read(value, true)).messages?.[0].text, "Draft ready for review.");
  for (const bad of [
    { ...value, messages: undefined },
    { ...value, messages: [{ ...value.messages[0], id: "2" }] },
    { ...value, taskId: id(8) },
    { ...value, observedAt: "2000-01-01" },
  ]) {
    const r = await read(bad, true);
    assert.equal(r.messages, undefined);
    assert.match(r.note, /unavailable/);
  }
  assert.equal((await read(value)).messages, undefined);
});
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
  task = id(9),
  epoch = "epoch";
function fixture(host = "mini") {
  const row: any = {
      id: id(1),
      task,
      host,
      cwd: "/owned",
      generation: 1,
      mode: "human",
      ...(host === "macbook" ? { remote: { agentId: id(2) } } : {}),
    },
    calls: string[] = [],
    requests: any[] = [];
  const observed: any = { id: row.id, nativeId: id(3), boot: "boot", humanAt: 0, lastUserAt: null };
  const call = async (method: string, a?: any): Promise<any> => {
    calls.push(method);
    if (method === "list") return [{ ...row }];
    if (method === "observe") return { ...row, observed: { ...observed } };
    if (method === "activity-receipts") return [];
    throw Error("Unsupported receiver action");
  };
  const timeline = async (a: any) => {
    requests.push(a);
    const start = a.cursor ? 1 : 51,
      end = a.cursor ? 50 : 100;
    return {
      agentId: id(1),
      projection: "canonical",
      direction: a.direction,
      epoch,
      hasNewer: !!a.cursor,
      hasOlder: !a.cursor,
      gap: false,
      reset: false,
      staleCursor: false,
      error: null,
      startCursor: { epoch, seq: start },
      endCursor: { epoch, seq: end },
      entries: Array.from({ length: end - start + 1 }, (_, i) => ({
        seqStart: start + i,
        seqEnd: start + i,
        item: {
          type: "tool_call",
          name: "Read",
          status: "completed",
          detail: { type: "read", filePath: "/owned/file", content: "PRIVATE" },
          input: "PRIVATE",
          output: "PRIVATE",
        },
      })),
    };
  };
  const agent: any = {
    id: row.id,
    provider: "claude",
    createdAt: "2026-09-01T00:00:00.000Z",
    persistence: { provider: "claude", sessionId: id(3) },
    runtimeInstanceId: "runtime-1",
    lastUserMessageAt: null,
    labels: { task },
  };
  let refreshes = 0;
  const refresh = async () => {
    refreshes++;
    return { agent: { ...agent, persistence: { ...agent.persistence } }, project: null };
  };
  const paseo: any = { agents: { ref: () => ({ refresh, timeline: { refetch: timeline } }) } };
  return {
    row,
    observed,
    agent,
    refresh,
    refreshCount: () => refreshes,
    calls,
    requests,
    call,
    paseo,
    timeline,
    a: { sessionId: row.id, taskId: task, cursor: null },
  };
}
test("Mini older page uses exact native cursor, bounded order and strips private payloads", async () => {
  const f = fixture(),
    first = await readHistory(f.a, f.paseo, f.call);
  assert.equal(first.activity.length, 50);
  assert.equal(first.activity[0].id, "51");
  assert(first.cursor);
  const next = await readHistory({ ...f.a, cursor: first.cursor }, f.paseo, f.call);
  assert.equal(next.activity[0].id, "1");
  assert.equal(next.cursor, null);
  assert.match(next.note, /Start of available/);
  assert.deepEqual(f.requests[1], {
    limit: 50,
    projection: "canonical",
    direction: "before",
    cursor: { epoch, seq: 51 },
  });
  assert(!JSON.stringify(first).includes("PRIVATE"));
  assert(f.calls.every((m) => ["list", "observe", "activity-receipts"].includes(m)));
});
test("foreign task/cursor and changing Mini native/control identity refuse and cannot expose another page", async () => {
  const f = fixture();
  await assert.rejects(readHistory({ ...f.a, taskId: id(8) }, f.paseo, f.call), /not enrolled/);
  assert.deepEqual(f.calls, ["list"]);
  const first = await readHistory(f.a, f.paseo, f.call);
  for (const field of ["runtimeInstanceId", "createdAt"]) {
    const old = f.agent[field];
    f.agent[field] = "changed";
    await assert.rejects(
      readHistory({ ...f.a, cursor: first.cursor }, f.paseo, f.call),
      /cursor identity/,
    );
    f.agent[field] = old;
  }
  {
    const old = f.agent.persistence.sessionId;
    f.agent.persistence.sessionId = id(7);
    await assert.rejects(
      readHistory({ ...f.a, cursor: first.cursor }, f.paseo, f.call),
      /cursor identity/,
    );
    f.agent.persistence.sessionId = old;
  }
  const oldCwd = f.row.cwd;
  f.row.cwd = "/changed";
  await assert.rejects(
    readHistory({ ...f.a, cursor: first.cursor }, f.paseo, f.call),
    /cursor identity/,
  );
  f.row.cwd = oldCwd;
  let reads = 0;
  const ref = f.paseo.agents.ref;
  f.paseo.agents.ref = () => ({
    ...ref(),
    refresh: async () => {
      const r = await f.refresh();
      if (++reads === 2) r.agent.lastUserMessageAt = "2026-09-30T00:00:00.000Z";
      return r;
    },
  });
  await assert.rejects(
    readHistory({ ...f.a, cursor: first.cursor }, f.paseo, f.call),
    /identity changed during page/,
  );
  f.paseo.agents.ref = ref;
});
test("page gap/reset/stale flags and changed enrollment preserve explicit errors; receipts outage is visible", async () => {
  for (const flag of ["gap", "reset", "staleCursor"]) {
    const f = fixture();
    f.paseo.agents.ref = () => ({
      refresh: f.refresh,
      timeline: { refetch: async (a: any) => ({ ...(await f.timeline(a)), [flag]: true }) },
    });
    const fallback = await readHistory(f.a, f.paseo, f.call);
    assert.equal(fallback.activity.length, 0);
    assert.equal(fallback.cursor, null);
    assert.match(fallback.note, /unavailable.*receipts retained/);
  }
  const f = fixture();
  let lists = 0;
  await assert.rejects(
    readHistory(f.a, f.paseo, async (m, a) =>
      m === "list" && ++lists === 2 ? [{ ...f.row, generation: 2 }] : f.call(m, a),
    ),
    /route changed/,
  );
  const result = await readHistory(f.a, f.paseo, async (m, a) => {
    if (m === "activity-receipts") throw Error("offline");
    return f.call(m, a);
  });
  assert.match(result.note, /Receipt metadata unavailable/);
});
test("signed Book page capability and task route stay explicit across old receiver, malformed and stale responses", async () => {
  const f = fixture("macbook");
  const fallback = await readHistory(f.a, f.paseo, f.call);
  assert.equal(fallback.cursor, null);
  assert.match(fallback.note, /unsupported.*receipts retained/);
  assert(!f.calls.includes("book-activity"));
  const value: any = {
    sessionId: id(1),
    taskId: task,
    agentId: id(2),
    nativeId: id(3),
    observedAt: new Date().toISOString(),
    hasOlder: false,
    skippedCount: 0,
    withheldPaths: 0,
    activity: [
      { id: "1", kind: "user_message", label: "User instruction", state: null, files: [] },
    ],
    cursor: null,
  };
  const run = (v: any) =>
    readHistory(f.a, f.paseo, (m, a) =>
      m === "book-activity-page" ? Promise.resolve(v) : f.call(m, a),
    );
  assert.equal((await run(value)).activity.length, 1);
  for (const change of [
    { taskId: id(8) },
    { agentId: id(8) },
    { cursor: { scope: "x", seq: 1, epoch } },
    { hasOlder: true },
    { observedAt: "2000-01-01" },
    { extra: "PRIVATE" },
  ]) {
    const r = await run({ ...value, ...change });
    assert.equal(r.activity.length, 0);
    assert.match(r.note, /unavailable/);
  }
});

test("latest outages preserve receipts while older errors remain failures and coverage is explicit", async () => {
  for (const host of ["mini", "macbook"]) {
    const f = fixture(host),
      receipt = {
        id: id(7),
        kind: "send",
        state: "delivered",
        notification: "consumed",
        evidenceHash: null,
      };
    const call = async (m: string, a: any) =>
      m === "activity-receipts" ? [receipt] : f.call(m, a);
    if (host === "mini") {
      const ref = f.paseo.agents.ref;
      f.paseo.agents.ref = () => ({
        ...ref(),
        refresh: async () => {
          throw Error("offline");
        },
      });
    }
    const r = await readHistory(f.a, f.paseo, call);
    assert.equal(r.receipts.length, 1);
    assert.equal(r.activity.length, 0);
    assert.equal(r.cursor, null);
    assert.match(r.note, /coverage unverified/);
    await assert.rejects(
      readHistory({ ...f.a, cursor: { scope: "a".repeat(64), epoch, seq: 51 } }, f.paseo, call),
    );
  }
  const f = fixture();
  for (const entries of [
    [],
    [{ seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "PRIVATE" } }],
  ]) {
    f.paseo.agents.ref = () => ({
      refresh: f.refresh,
      timeline: {
        refetch: async () => ({
          agentId: f.row.id,
          projection: "canonical",
          direction: "tail",
          epoch,
          hasOlder: false,
          hasNewer: false,
          entries,
          startCursor: entries.length ? { epoch, seq: 1 } : null,
          endCursor: entries.length ? { epoch, seq: 1 } : null,
        }),
      },
    });
    assert.match((await readHistory(f.a, f.paseo, f.call)).note, /coverage unverified/);
  }
});

test("older Book routes retain validated tool pages when message requests are unsupported", async () => {
  const f = fixture("macbook"),
    requests: any[] = [],
    cursor = { scope: "a".repeat(64), epoch: "book-history", seq: 50 };
  const value: any = {
    sessionId: id(1),
    taskId: task,
    agentId: id(2),
    nativeId: id(3),
    observedAt: new Date().toISOString(),
    hasOlder: true,
    skippedCount: 0,
    withheldPaths: 0,
    activity: [{ id: "50", kind: "tool_call", label: "Read", state: "completed", files: [] }],
    cursor,
  };
  const call = async (m: string, a: any) => {
    if (m !== "book-activity-page") return f.call(m, a);
    requests.push(a);
    if (a.includeMessages) throw Error("Unsupported message request");
    return a.cursor
      ? { ...value, hasOlder: false, cursor: null, activity: [{ ...value.activity[0], id: "1" }] }
      : value;
  };
  const first = await readHistory({ ...f.a, includeMessages: true }, f.paseo, call);
  assert.equal(first.activity[0].id, "50");
  assert.equal(first.messages, undefined);
  assert.deepEqual(first.cursor, cursor);
  assert.match(first.note, /Conversation messages unavailable; showing verified tool history/);
  const older = await readHistory(
    { ...f.a, cursor: first.cursor, includeMessages: true },
    f.paseo,
    call,
  );
  assert.equal(older.activity[0].id, "1");
  assert.equal(older.cursor, null);
  assert.deepEqual(
    requests.map((a) => a.includeMessages),
    [true, undefined, true, undefined],
  );
  assert.deepEqual(requests[3], { ...f.a, cursor });
  for (const invalid of [
    { ...value, taskId: id(8) },
    { ...value, agentId: id(8) },
    { ...value, observedAt: "2000-01-01" },
    { ...value, messages: [{ id: "50", role: "agent", text: "PRIVATE", truncated: false }] },
  ]) {
    const r = await readHistory({ ...f.a, includeMessages: true }, f.paseo, async (m, a: any) =>
      m === "book-activity-page"
        ? a.includeMessages
          ? Promise.reject(Error("unsupported"))
          : invalid
        : f.call(m, a),
    );
    assert.equal(r.activity.length, 0);
    assert(!JSON.stringify(r).includes("PRIVATE"));
  }
});

test("U5-D09: under the real read-only management gate, a local session shows its native activity (the controller observe is never called)", async () => {
  const { withManagementInvocation } = await import("./management-context.mjs");
  const f = fixture();
  const invoked: string[] = [];
  const context = {
    management: {
      invoke: async (command: any) => {
        invoked.push(command.method);
        return f.call(command.method, command.input ?? undefined);
      },
    },
  };
  const result: any = await withManagementInvocation(context, true, () =>
    readHistory(f.a, f.paseo),
  );
  assert.equal(result.activity.length, 50);
  assert.doesNotMatch(result.note, /Native tool activity unavailable/);
  assert(!invoked.includes("observe"));
  assert.equal(f.refreshCount(), 2);
});
