import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { processTable, descendants, waitForExit } from "./trial/exit-proof.mjs";
test("H2 returns per-lifetime proof only after every recorded owned process exits", async () => {
  const a = { pid: 41, ppid: 1, uid: 5, start: "first" },
    b = { pid: 42, ppid: 41, uid: 5, start: "second" };
  let reads = 0;
  const proof = await waitForExit([a, b], {
    read: () => (++reads < 2 ? [b] : []),
    pause: async () => {},
    timeoutMs: 100,
  });
  assert.equal(proof.allExited, true);
  assert.equal(proof.processes.length, 2);
  assert.ok(proof.processes.every((p) => p.exited));
});
test("H2 refuses survivors and process-query failure; reused PID is not the old lifetime", async () => {
  const a = { pid: 41, ppid: 1, uid: 5, start: "first" };
  await assert.rejects(waitForExit([a], { read: () => [a], timeoutMs: 0 }), /still running/);
  await assert.rejects(
    waitForExit([a], {
      read: () => {
        throw Error("ps unavailable");
      },
    }),
    /ps unavailable/,
  );
  assert.equal(
    (await waitForExit([a], { read: () => [{ ...a, start: "replacement" }] })).allExited,
    true,
  );
  assert.deepEqual(
    descendants(
      [
        a,
        { pid: 42, ppid: 41, uid: 5, start: "child" },
        { pid: 43, ppid: 1, uid: 5, start: "foreign" },
      ],
      [a],
    ).map((p) => p.pid),
    [41, 42],
  );
});
test("H2 actual disposable child exit produces a PID/start receipt", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const owner = processTable().find((p) => p.pid === child.pid);
  assert.ok(owner);
  const exited = once(child, "exit");
  child.kill();
  await exited;
  const proof = await waitForExit([owner]);
  assert.equal(proof.allExited, true);
  assert.equal(proof.processes[0].start, owner.start);
});
