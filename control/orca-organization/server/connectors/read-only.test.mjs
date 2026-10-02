import test from "node:test";
import assert from "node:assert/strict";
import { createConnectorService } from "./service.mjs";
test("read-only tracker projections neither migrate credentials nor persist provider observations", async () => {
  const calls = [];
  let external = 0;
  const service = createConnectorService({
    controller: async (method) => {
      calls.push(method);
      if (method === "cc-tracker-mappings")
        return {
          mappings: [
            { id: "mapping", state: "mapped", revision: 1, connector: "github", accountId: null },
          ],
        };
      if (method === "cc-tracker-items") return { items: [] };
      if (method === "cc-links-for") return { links: [] };
      if (method === "trackers-project") return { mapping: null, links: [] };
      if (method === "cc-tracker-legacy-pending") return { pending: [] };
      throw Error("Unexpected mutation " + method);
    },
    registry: { get: () => ({ label: "GitHub" }), describe: () => [] },
    http: () => {
      external++;
      throw Error("No provider read needed");
    },
    importLegacy: async () => {
      external++;
      throw Error("No credential migration");
    },
    scan: async () => {
      external++;
    },
  });
  await service.mappings({ projectId: "project" }, { persist: false });
  const view = await service.view({ projectId: "project" }, { persist: false });
  assert.equal(external, 0);
  assert.ok(
    !calls.some(
      (m) =>
        m === "cc-tracker-items-put" ||
        m === "cc-links-observe" ||
        m === "cc-tracker-import-legacy",
    ),
  );
  assert.equal(view.partial, true);
});
