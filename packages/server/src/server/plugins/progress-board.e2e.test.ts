import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { beforeAll, afterAll } from "vitest";
import { DaemonClient } from "../../../../client/src/daemon-client.js";
import { createPaseoApi } from "@getpaseo/client";
import { ProgressBoardService } from "../../../../../control/orca-organization/server/progress-board/service";
import { boardSchema } from "../../../../../control/orca-organization/shared/progress-board";
let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
let client: DaemonClient;
let api: ReturnType<typeof createPaseoApi>;
const services: ProgressBoardService[] = [];
const roots: string[] = [];
beforeAll(async () => {
  daemon = await createTestPaseoDaemon();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.2",
    clientId: "progress-board-service-test",
    clientType: "cli",
  });
  await client.connect();
  api = createPaseoApi(client);
});
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
  await api?.dispose();
  await client?.close();
  await daemon?.close();
});
async function fixture(text?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "board-service-"));
  roots.push(root);
  if (text !== undefined) {
    await mkdir(path.join(root, "sample"));
    await writeFile(path.join(root, "sample", "OPEN-ITEMS.md"), text);
  }
  const service = new ProgressBoardService(root, path.join(root, "results.json"));
  services.push(service);
  return { root, service };
}
const ledger =
  "| id | item | kind | owner | status | evidence | source |\n| --- | --- | --- | --- | --- | --- | --- |\n| FU-1 | Synthetic task | BUILD | Worker | OPEN | | Test |\n";
test("reads the real daemon directory and a synthetic ledger", async () => {
  const { service } = await fixture(ledger);
  const board = boardSchema.parse(await service.read(api, "Test host"));
  expect(board.projects[0].items[0].id).toBe("FU-1");
  expect(board.projects[0].jobs).toEqual([]);
});
test("handles an empty directory, malformed file and missing directory", async () => {
  const empty = await fixture();
  expect((await empty.service.read(api, "Host")).projects).toEqual([]);
  const bad = await fixture("not a table");
  expect((await bad.service.read(api, "Host")).projects[0].notice).toContain("malformed");
  const absent = new ProgressBoardService(path.join(empty.root, "absent"), null);
  services.push(absent);
  expect((await absent.read(api, "Host")).notice).toContain("unavailable");
});
test("wakes on a ledger event and reads the changed table", async () => {
  const { root, service } = await fixture(ledger);
  const first = await service.read(api, "Host");
  const event = service.watchRevision(first.revision);
  await writeFile(path.join(root, "sample", "OPEN-ITEMS.md"), ledger.replace("OPEN", "NEXT"));
  expect((await event).revision).toBeGreaterThan(first.revision);
  expect((await service.read(api, "Host")).projects[0].items[0].lane).toBe("Next");
});
test("saves one-line results and wakes observers", async () => {
  const { root, service } = await fixture();
  const first = await service.read(api, "Host");
  const event = service.watchRevision(first.revision);
  await service.recordResult("synthetic-job", "Checks passed.");
  expect((await event).revision).toBeGreaterThan(first.revision);
  expect(JSON.parse(await readFile(path.join(root, "results.json"), "utf8"))).toEqual({
    "synthetic-job": "Checks passed.",
  });
});
test("rejects large ledgers without returning partial rows", async () => {
  const { service } = await fixture("x".repeat(512 * 1024 + 1));
  expect((await service.read(api, "Host")).projects[0]).toMatchObject({
    items: [],
    notice: "The ledger exceeds the size limit.",
  });
});
test("teardown releases a waiting observer", async () => {
  const { service } = await fixture();
  const first = await service.read(api, "Host");
  const event = service.watchRevision(first.revision);
  service.close();
  await expect(event).resolves.toEqual({ revision: first.revision });
});
