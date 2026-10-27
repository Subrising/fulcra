import { expect, test } from "vitest";

import { withClaimedRecords } from "./service.js";

test("withClaimedRecords adds the record of a claimed session that boot left on disk", async () => {
  const stored: Record<string, { id: string; archivedAt?: string }> = {
    old: { id: "old", archivedAt: "2026-10-02T00:00:00.000Z" },
  };
  const agents = await withClaimedRecords(
    [{ id: "live" }],
    [{ sessionId: "live" }, { sessionId: "old" }, { sessionId: "old" }, { sessionId: "gone" }],
    async (id) => stored[id] ?? null,
  );
  expect(agents.map((a) => a.id)).toEqual(["live", "old"]);
});
