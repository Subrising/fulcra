import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { closeWithin } from "./native-close.mjs";

// W1 rebuild scratch home: on a daemon shutdown native.close() never settled (the stopping host no longer answers the
// DaemonClient's subscription releases), so stop() never reached store.close() and the supervisor SIGKILLed the child.
test("a native close that never settles yields to the deadline, so the caller still reaches store.close()", async () => {
  const t0 = Date.now(),
    steps = [];
  const closed = await closeWithin(() => new Promise(() => {}), 200);
  steps.push("store.close");
  assert.equal(closed, false);
  assert.ok(Date.now() - t0 >= 190 && Date.now() - t0 < 2000, "bounded by the deadline");
  assert.deepEqual(steps, ["store.close"]);
});

test("a native close that settles (fulfilled or rejected, even synchronously throwing) returns at once", async () => {
  assert.equal(await closeWithin(async () => {}, 60000), true);
  assert.equal(
    await closeWithin(async () => {
      throw Error("daemon gone");
    }, 60000),
    true,
  );
  assert.equal(
    await closeWithin(() => {
      throw Error("sync");
    }, 60000),
    true,
  );
});

test("stop() bounds native.close() before store.close()", () => {
  const source = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const stop = source.match(/async function stop\(\)[^\n]*/)[0];
  assert.match(
    stop,
    /if \(!await closeWithin\(\(\) => native\.close\(\)\)\) log\.line\(\{ nativeCloseDeadline: true \}\); store\.close\(\);/,
  );
  assert.doesNotMatch(stop, /await native\.close\(\)/, "no unbounded native close");
});
