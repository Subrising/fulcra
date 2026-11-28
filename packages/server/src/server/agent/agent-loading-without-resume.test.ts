import { expect, test, vi } from "vitest";

import { findAgentWithoutResume } from "./agent-loading.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";

// FU-843: read-only answers (slash commands, provider subagents) must never resume a chat that is not loaded.
function deps(live: ManagedAgent | null, record: Partial<StoredAgentRecord> | null) {
  const get = vi.fn(async () => record as StoredAgentRecord | null);
  return {
    get,
    deps: {
      agentManager: { getAgent: vi.fn(() => live ?? undefined) },
      agentStorage: { get },
    },
  };
}

test("a loaded chat is returned without reading storage", async () => {
  const live = { id: "a1" } as ManagedAgent;
  const { deps: d, get } = deps(live, { id: "a1" });
  await expect(findAgentWithoutResume("a1", d)).resolves.toEqual({ kind: "live", agent: live });
  expect(get).not.toHaveBeenCalled();
});

test("a saved chat that is not loaded comes back as its record", async () => {
  const record = { id: "a2", provider: "claude", cwd: "/tmp" };
  const { deps: d } = deps(null, record);
  await expect(findAgentWithoutResume("a2", d)).resolves.toEqual({ kind: "stored", record });
});

test("an archived chat is reported as archived", async () => {
  const { deps: d } = deps(null, { id: "a3", archivedAt: "2026-11-28T00:00:00.000Z" });
  await expect(findAgentWithoutResume("a3", d)).resolves.toEqual({ kind: "archived" });
});

test("an unknown chat is reported as missing", async () => {
  const { deps: d } = deps(null, null);
  await expect(findAgentWithoutResume("nope", d)).resolves.toEqual({ kind: "missing" });
});

test("the lookup offers no way to resume: only getAgent and storage reads are used", async () => {
  const { deps: d } = deps(null, { id: "a4", provider: "claude", cwd: "/tmp" });
  const result = await findAgentWithoutResume("a4", d);
  expect(result.kind).toBe("stored");
  expect(Object.keys(d.agentManager)).toEqual(["getAgent"]);
});
