import { expect, test, vi } from "vitest";
import {
  createFinalInputCheck,
  hasFinalInputHandoff,
  assertFinalInputCheck,
  commitFinalInputCheck,
  recordFinalInputHandoff,
  waitForFinalInputHandoff,
  requiresProviderInputHandoff,
} from "./final-input-check.js";

test("a handoff timeout revokes a delayed transport check before recovery can retry", async () => {
  vi.useFakeTimers();
  try {
    let sent = 0;
    const handle = createFinalInputCheck(
      () => undefined,
      () => {
        sent++;
      },
    );
    const outcome = waitForFinalInputHandoff(handle).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ message: "Final notice handoff timed out" });
    expect(() => commitFinalInputCheck(handle)).toThrow("Final notice handoff timed out");
    expect(sent).toBe(0);
    recordFinalInputHandoff(handle);
    expect(hasFinalInputHandoff(handle)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a longer handoff wait lets a waking session take its input after 30 s", async () => {
  vi.useFakeTimers();
  try {
    const handle = createFinalInputCheck(() => undefined);
    const outcome = waitForFinalInputHandoff(handle, 120_000).then(
      () => "handed off",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    commitFinalInputCheck(handle);
    recordFinalInputHandoff(handle);
    expect(await outcome).toBe("handed off");
  } finally {
    vi.useRealTimers();
  }
});

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
  expect(hasFinalInputHandoff(handle)).toBe(false);
  recordFinalInputHandoff(handle);
  expect(hasFinalInputHandoff(handle)).toBe(true);
  await waitForFinalInputHandoff(handle);
  allowed = false;
  expect(() => commitFinalInputCheck(handle)).toThrow("revoked");
  expect(hasFinalInputHandoff(handle)).toBe(true);
  expect(checks).toBe(5);
  expect(commits).toBe(1);
});

test("manager-only queue checks cannot commit native authority", () => {
  const native = createFinalInputCheck(() => undefined);
  const queue = createFinalInputCheck(() => undefined, undefined, true);
  expect(requiresProviderInputHandoff(native)).toBe(true);
  expect(requiresProviderInputHandoff(queue)).toBe(false);
  expect(() =>
    createFinalInputCheck(
      () => undefined,
      () => undefined,
      true,
    ),
  ).toThrow("cannot commit native authority");
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
  expect(hasFinalInputHandoff(handle)).toBe(false);
  recordFinalInputHandoff(handle);
  expect(hasFinalInputHandoff(handle)).toBe(false);
  await expect(waitForFinalInputHandoff(handle)).rejects.toThrow("stopped");
  expect(commits).toBe(0);
});
