import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
// Private test configuration first: some plugin modules read it when they load.
import "./portable.fixture";
import { COMPANY, PROGRAMME } from "./tasks";
import {
  eligibleHint,
  projectTasks,
  taskPage,
  readIssues,
  readTaskCatalog,
  projectUsage,
  createUsageReader,
  singleFlight,
} from "./tasks";
const row = (id = PROGRAMME) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
  title: "Real task",
  identifier: "AIN-74",
});
test("inactive or deleted retained tasks stay selectable; discovery grants no authority and pages without loss", () => {
  const child = randomUUID(),
    deleted = randomUUID();
  const data = projectTasks(
    [row(), { ...row(child), status: "blocked" }],
    { taskIds: [child, deleted], partial: false },
    true,
  );
  assert.equal(data.tasks.find((t) => t.id === child)?.eligibleHint, false);
  assert.equal(data.tasks.find((t) => t.id === deleted)?.retained, true);
  const many = projectTasks(
      [row(), ...Array.from({ length: 499 }, () => row(randomUUID()))],
      { taskIds: [deleted], partial: false },
      true,
    ),
    ids: string[] = [];
  assert.equal(many.tasks.length, 501);
  assert.equal(many.tasks.filter((t) => t.eligibleHint).length, 500);
  assert.equal(taskPage(many, 0).nextCursor, 32);
  assert.equal(taskPage(many, 32).nextCursor, 64);
  assert.equal(taskPage(many, 480).nextCursor, null);
  for (let cursor = 0; cursor < many.tasks.length; cursor += 32)
    ids.push(...taskPage(many, cursor).tasks.map((t) => t.id));
  assert.equal(new Set(ids).size, many.tasks.length);
  assert.equal(ids[0], PROGRAMME);
  assert.equal(ids[1], deleted);
});
test("ancestry hints reject absent parents, cycles, changed owners, duplicate identities and oversized lists", () => {
  const child = randomUUID();
  for (const changed of [
    { ...row(child), parentId: randomUUID() },
    { ...row(child), parentId: child },
    { ...row(child), parentId: "invalid" },
    { ...row(child), assigneeUserId: "other" },
    { ...row(child), status: "done" },
  ])
    assert.equal(
      eligibleHint(
        child,
        new Map([
          [PROGRAMME, row()],
          [child, changed],
        ]),
      ),
      false,
    );
  const duplicated = projectTasks(
    [row(), row(child), row(child), row(child), null],
    { taskIds: [], partial: false },
    true,
  );
  assert.equal(
    duplicated.tasks.some((t) => t.id === child),
    false,
  );
  assert.equal(duplicated.partial, true);
  assert.equal(
    projectTasks(
      Array.from({ length: 1001 }, () => row()),
      { taskIds: [], partial: false },
      true,
    ).partial,
    true,
  );
});
test("bounded board read bounds bytes; board outage preserves retained IDs and journal outage is explicit", async () => {
  let url = "";
  const fetched = await readIssues((async (input: any) => {
    url = String(input);
    return new Response(JSON.stringify([row()]));
  }) as typeof fetch);
  assert.equal(url, `http://127.0.0.1:3200/api/companies/${COMPANY}/issues`);
  assert.equal(fetched.length, 1);
  await assert.rejects(
    readIssues((async () => new Response("x".repeat(2097152))) as typeof fetch),
    /limit/,
  );
  assert.deepEqual(
    await readIssues((async () => new Response("[]" + " ".repeat(1048574))) as typeof fetch),
    [],
  );
  await assert.rejects(
    readIssues((async () => new Response("{}")) as typeof fetch),
    /Invalid task list/,
  );
  await assert.rejects(
    readIssues((async () => new Response("offline", { status: 503 })) as typeof fetch),
    /unavailable/,
  );
  const id = randomUUID();
  const retained = await readTaskCatalog(
    async () => {
      throw Error("Board offline");
    },
    async () => ({ taskIds: [id], partial: false }),
  );
  assert.equal(retained.tasks.find((t) => t.id === id)?.retained, true);
  assert.match(retained.note, /unavailable/);
  await assert.rejects(
    readTaskCatalog(
      async () => [],
      async () => {
        throw Error("Socket offline");
      },
    ),
    /index unavailable/,
  );
  for (const invalid of [
    null,
    {},
    { taskIds: null, partial: false },
    { taskIds: ["invalid"], partial: false },
    { taskIds: [], partial: null },
    { taskIds: Array.from({ length: 2049 }, () => id), partial: true },
  ])
    await assert.rejects(
      readTaskCatalog(
        async () => [],
        async () => invalid,
      ),
      /index unavailable/,
    );
});
test("usage preserves missing source time and null percentages, and strictly bounds hostile reports", () => {
  const p = projectUsage({
    fetchedAt: "response-time",
    providers: [
      {
        providerId: "claude",
        displayName: "Claude",
        status: "error",
        windows: Array.from({ length: 1000 }, () => ({
          label: "Weekly",
          usedPct: null,
          remainingPct: Infinity,
        })),
        balances: [],
        error: "x".repeat(1000),
        secret: "not-published",
      },
    ],
  });
  assert.equal(p.fetchedAt, "response-time");
  assert.equal(p.providers[0].fetchedAt, null);
  assert.equal(p.providers[0].source, null);
  assert.equal(p.providers[0].windows.length, 16);
  assert.equal(p.providers[0].windows[0].remaining, null);
  assert.equal(p.truncated, true);
  assert.equal(p.providers[0].error!.length, 512);
  assert(!JSON.stringify(p).includes("not-published"));
  assert.equal(projectUsage(null).available, false);
});
test("view timeouts share one underlying usage request; SDK failure releases it and later refresh recovers", async () => {
  let calls = 0,
    now = 0,
    reject!: (error: Error) => void;
  const pending = new Promise((_, fail) => {
    reject = fail;
  });
  const paseo = {
    providers: {
      listUsage: () => {
        calls++;
        return calls === 1 ? pending : Promise.resolve({ providers: [] });
      },
    },
  } as unknown as PaseoApi;
  const read = createUsageReader(paseo, 5, () => now);
  const [one, two] = await Promise.all([read(), read()]);
  assert.equal(one.available, false);
  assert.equal(two.available, false);
  assert.equal(calls, 1);
  reject(new Error("SDK request deadline"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  now = 30001;
  assert.equal((await read()).available, true);
  assert.equal(calls, 2);
});
test("two catalogue viewers coalesce and retain the original timestamp", async () => {
  let calls = 0,
    now = 0;
  const value = { observedAt: "original" };
  const read = singleFlight(
    async () => {
      calls++;
      return value;
    },
    () => now,
  );
  assert.deepEqual(await Promise.all([read(), read()]), [value, value]);
  assert.equal(calls, 1);
  now = 30001;
  await read();
  assert.equal(calls, 2);
  now = 60001;
  await read();
  assert.equal(calls, 3);
});
test("authority hints accept a complete allowed lineage and reject malformed field types and excessive depth", () => {
  const ids = Array.from({ length: 9 }, () => randomUUID()),
    rows = new Map([[PROGRAMME, row()]]);
  ids.forEach((id, n) => rows.set(id, { ...row(id), parentId: n ? ids[n - 1] : PROGRAMME }));
  assert.equal(eligibleHint(ids[6], rows), true);
  assert.equal(eligibleHint(ids[7], rows), false);
  for (const invalid of [
    { title: null },
    { status: null },
    { companyId: randomUUID() },
    { id: "invalid" },
  ]) {
    const p = projectTasks(
      [row(), { ...row(ids[0]), ...invalid }],
      { taskIds: [], partial: false },
      true,
    );
    assert.equal(p.partial, true);
    assert.equal(p.tasks.length, 1);
  }
});
test("usage boundary values preserve actual source, balances and exact display limits without false truncation", () => {
  const provider = {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    fetchedAt: "source-time",
    sourceLabel: "Native usage",
    windows: Array.from({ length: 16 }, (_, n) => ({
      label: String(n),
      usedPct: 0,
      remainingPct: 100,
      resetsAt: "reset-time",
    })),
    balances: [{ label: "Credits", remaining: 0, unit: "usd" }],
  };
  const p = projectUsage({ providers: Array.from({ length: 16 }, () => provider) });
  assert.equal(p.truncated, false);
  assert.equal(p.providers.length, 16);
  assert.equal(p.providers[0].source, "Native usage");
  assert.equal(p.providers[0].fetchedAt, "source-time");
  assert.deepEqual(p.providers[0].windows[0], {
    label: "0",
    used: 0,
    remaining: 100,
    resetsAt: "reset-time",
  });
  assert.deepEqual(p.providers[0].balances, [{ label: "Credits", remaining: 0, unit: "usd" }]);
  assert.equal(
    projectUsage({ providers: [{ ...provider, balances: [{ unit: "secret" }] }] }).truncated,
    true,
  );
  assert.equal(
    projectUsage({ providers: [{ ...provider, displayName: "x".repeat(129) }] }).truncated,
    true,
  );
  const exact = projectUsage({
    providers: [
      {
        ...provider,
        displayName: "x".repeat(128),
        balances: Array.from({ length: 16 }, () => ({
          label: "Credits",
          remaining: 0,
          unit: "usd",
        })),
      },
    ],
  });
  assert.equal(exact.truncated, false);
  assert.equal(exact.providers[0].balances.length, 16);
});
test("all retained tasks precede discovered candidates with deterministic ordering across pages", () => {
  const retained = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    candidate = "00000000-0000-4000-8000-000000000000";
  const a = projectTasks(
    [row(), row(candidate)],
    { taskIds: [...retained].toReversed(), partial: false },
    true,
  );
  assert.deepEqual(
    a.tasks.map((t) => t.id),
    [PROGRAMME, ...retained, candidate],
  );
});

test("completed and reassigned retained tasks keep names beyond four without entering active discovery", async () => {
  const retained = Array.from({ length: 8 }, () => randomUUID()),
    unrelated = randomUUID();
  const raw = [
    row(),
    ...retained.map((id, i) => ({
      ...row(id),
      title: `Completed work ${i}`,
      status: "done",
      assigneeUserId: "previous-owner",
    })),
    { ...row(unrelated), status: "done" },
  ];
  const result = await readTaskCatalog(
    async () => raw,
    async () => ({ taskIds: retained, partial: false }),
  );
  for (const [i, id] of retained.entries()) {
    const task = result.tasks.find((t) => t.id === id)!;
    assert.equal(task.title, `Completed work ${i}`);
    assert.equal(task.eligibleHint, false);
  }
  assert(!result.tasks.some((t) => t.id === unrelated));
});
