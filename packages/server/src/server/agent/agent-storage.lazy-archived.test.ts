import { afterEach, beforeEach, describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, deferrableArchivedId } from "./agent-storage.js";

function rawRecord(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  return {
    id,
    provider: "claude",
    cwd: "/tmp/project",
    workspaceId: "ws-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    ...overrides,
  };
}

function writeRecord(baseDir: string, record: { id: string }) {
  const dir = path.join(baseDir, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
}

describe("AgentStorage archived records at boot (FU-462)", () => {
  let baseDir: string;
  let live: string[];
  let archived: string[];

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(os.tmpdir(), "agent-storage-lazy-"));
    live = [];
    archived = [];
    for (let i = 0; i < 24; i++) {
      const record = rawRecord();
      live.push(record.id);
      writeRecord(baseDir, record);
    }
    for (let i = 0; i < 176; i++) {
      const record = rawRecord({ archivedAt: "2026-10-02T00:00:00.000Z" });
      archived.push(record.id);
      writeRecord(baseDir, record);
    }
  });

  afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

  test("boot parses the 24 live records and leaves the 176 archived ones on disk", async () => {
    const storage = new AgentStorage(baseDir, createTestLogger());
    await storage.initialize();
    expect(storage.bootstrapRecordsLoaded).toBe(24);
    expect(storage.bootstrapRecordsSkipped).toBe(176);
    expect((await storage.listLoaded()).map((r) => r.id).sort()).toEqual([...live].sort());
  });

  test("an archived record loads on demand through get and getCached", async () => {
    const storage = new AgentStorage(baseDir, createTestLogger());
    await storage.initialize();
    expect((await storage.get(archived[0]!))?.archivedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(storage.getCached(archived[1]!)?.id).toBe(archived[1]);
    expect(await storage.listLoaded()).toHaveLength(26);
  });

  test("list returns every record, archived ones included", async () => {
    const storage = new AgentStorage(baseDir, createTestLogger());
    await storage.initialize();
    expect(await storage.list()).toHaveLength(200);
  });

  test("a write to an archived record keeps its archive mark", async () => {
    const storage = new AgentStorage(baseDir, createTestLogger());
    await storage.initialize();
    await storage.setTitle(archived[0]!, "renamed");
    const record = await storage.get(archived[0]!);
    expect(record?.title).toBe("renamed");
    expect(record?.archivedAt).toBe("2026-10-02T00:00:00.000Z");
  });

  test("deferrableArchivedId keeps records that boot reads", () => {
    const base = rawRecord({ archivedAt: "2026-10-02T00:00:00.000Z" });
    expect(deferrableArchivedId(base)).toBe(base.id);
    expect(deferrableArchivedId({ ...base, archivedAt: null })).toBeNull();
    expect(deferrableArchivedId({ ...base, workspaceId: undefined })).toBeNull();
    expect(deferrableArchivedId({ ...base, finishNotice: { status: "pending" } })).toBeNull();
    expect(deferrableArchivedId({ ...base, previousFinishNotices: [] })).toBe(base.id);
    expect(deferrableArchivedId({ ...base, owner: { kind: "daemon" } })).toBeNull();
  });
});
