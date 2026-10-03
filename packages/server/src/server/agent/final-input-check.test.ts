import { expect, test } from "vitest";
import {
  createFinalInputCheck,
  assertFinalInputCheck,
  commitFinalInputCheck,
  recordFinalInputHandoff,
  waitForFinalInputHandoff,
} from "./final-input-check.js";

test("early/repeated refusal checks do not consume; concrete handoff commits once", async () => {
  let allowed = true,
    checks = 0,
    commits = 0;
  const handle = createFinalInputCheck(
    () => {
      checks++;
      if (!allowed) throw new Error("revoked");
    },
    () => {
      commits++;
    },
  );
  assertFinalInputCheck(handle);
  assertFinalInputCheck(handle);
  expect(commits).toBe(0);
  commitFinalInputCheck(handle);
  expect(() => commitFinalInputCheck(handle)).toThrow("already committed");
  expect(commits).toBe(1);
  recordFinalInputHandoff(handle);
  await waitForFinalInputHandoff(handle);
  allowed = false;
  expect(() => commitFinalInputCheck(handle)).toThrow("revoked");
  expect(checks).toBe(5);
  expect(commits).toBe(1);
});

test("refusal before handoff leaves commitment unspent", async () => {
  let allowed = true,
    commits = 0;
  const handle = createFinalInputCheck(
    () => {
      if (!allowed) throw new Error("stopped");
    },
    () => {
      commits++;
    },
  );
  assertFinalInputCheck(handle);
  allowed = false;
  expect(() => commitFinalInputCheck(handle)).toThrow("stopped");
  await expect(waitForFinalInputHandoff(handle)).rejects.toThrow("stopped");
  expect(commits).toBe(0);
});
