import { expect, test } from "vitest";

import { workerArchivedAt } from "./host-link-runtime.js";

test("workerArchivedAt reads storage for a session the boot directory does not hold", () => {
  const stored = { archivedAt: "2026-10-02T00:00:00.000Z" };
  expect(workerArchivedAt(undefined, () => stored)).toBe(true);
  expect(workerArchivedAt(undefined, () => ({ archivedAt: null }))).toBe(false);
  expect(workerArchivedAt(undefined, () => null)).toBe(false);
  expect(workerArchivedAt({ archivedAt: "2026-10-03T00:00:00.000Z" }, () => null)).toBe(true);
});
