import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeTrustedPlugins } from "./trusted-bootstrap.js";
import { trustedClaudeDenyRules } from "./trusted.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

// POSIX ownership admission; the paired Win32 case below asserts host refusal.
test.runIf(process.platform !== "win32")(
  "P4: completed storage index precedes trusted setup and Claude provider policy",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trusted-boot-"));
    const home = path.join(root, "home");
    const bundle = path.join(root, "bundle");
    const directory = path.join(bundle, "fixture");
    const id = "11111111-1111-4111-8111-111111111111";
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "fixture" }));
    await writeFile(
      path.join(directory, "index.host.js"),
      `
    export const hostContract='1.1';
    export default server=>{
      const observed=server.inputObservations.require('${id}');
      if(observed.humanAt!==0 || observed.boot!==server.inputObservations.boot) throw Error('incomplete index');
      server.claude.deny(()=>['Read(/fixture/private/**)']);
    };
  `,
    );
    const order: string[] = [];
    let host: Awaited<ReturnType<typeof initializeTrustedPlugins>> | undefined;
    try {
      host = await initializeTrustedPlugins(
        {
          initialize: async () => {
            order.push("initialized");
          },
          knownIds: async () => {
            expect(order).toEqual(["initialized"]);
            order.push("listed");
            return [id];
          },
        },
        bundle,
        home,
      );
      order.push("setup-complete");
      expect(host.requireSequence(id)).toEqual({ boot: host.boot, humanAt: 0 });
      // Same global deny choke point used before Claude's native query/probe.
      expect(trustedClaudeDenyRules()).toContain("Read(/fixture/private/**)");
      order.push("provider-policy");
      expect(order).toEqual(["initialized", "listed", "setup-complete", "provider-policy"]);
    } finally {
      host?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("P4: unavailable storage index prevents trusted startup", async () => {
  await expect(
    initializeTrustedPlugins(
      {
        initialize: async () => undefined,
        knownIds: async () => {
          throw Error("storage unavailable");
        },
      },
      undefined,
      "/fixture/unused",
    ),
  ).rejects.toThrow("storage unavailable");
});

test.runIf(process.platform === "win32")(
  "Windows indexed startup refuses trusted bundle admission",
  async () => {
    const order: string[] = [];
    await expect(
      initializeTrustedPlugins(
        {
          initialize: async () => {
            order.push("initialized");
          },
          knownIds: async () => {
            order.push("listed");
            return [];
          },
        },
        process.cwd(),
        path.join(process.cwd(), "unused-home"),
      ),
    ).rejects.toMatchObject({ code: "TRUSTED_PLUGIN_HOST_UNSUPPORTED" });
    expect(order).toEqual(["initialized", "listed"]);
  },
);

// FU-462: after a restart an archived session is still a known agent, so unarchive, archive and delete pass the
// trusted input check. The archived record stays on disk; only its id is read.
test.runIf(process.platform !== "win32")(
  "FU-462: a trusted bundle knows archived sessions that boot left on disk",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trusted-boot-archived-"));
    const bundle = path.join(root, "bundle");
    const directory = path.join(bundle, "fixture");
    const id = "22222222-2222-4222-8222-222222222222";
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(root, "agents", "project"), { recursive: true });
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "fixture" }));
    await writeFile(
      path.join(directory, "index.host.js"),
      "export const hostContract='1.1'; export default server=>{ server.inputObservations.require('" +
        id +
        "'); };",
    );
    await writeFile(
      path.join(root, "agents", "project", id + ".json"),
      JSON.stringify({
        id,
        provider: "claude",
        cwd: "/tmp/project",
        workspaceId: "ws-1",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        archivedAt: "2026-10-02T00:00:00.000Z",
        labels: {},
        lastStatus: "closed",
        config: null,
      }),
    );
    const storage = new AgentStorage(path.join(root, "agents"), createTestLogger());
    let host: Awaited<ReturnType<typeof initializeTrustedPlugins>> | undefined;
    try {
      host = await initializeTrustedPlugins(storage, bundle, path.join(root, "home"));
      expect(storage.bootstrapRecordsLoaded).toBe(0);
      expect(host.requireSequence(id)).toEqual({ boot: host.boot, humanAt: 0 });
    } finally {
      host?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
