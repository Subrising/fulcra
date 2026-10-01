import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeTrustedPlugins } from "./trusted-bootstrap.js";
import { trustedClaudeDenyRules } from "./trusted.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

test("P4: completed storage index precedes trusted setup and Claude provider policy", async () => {
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
        list: async () => {
          expect(order).toEqual(["initialized"]);
          order.push("listed");
          return [{ id } as StoredAgentRecord];
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
});

test("P4: unavailable storage index prevents trusted startup", async () => {
  await expect(
    initializeTrustedPlugins(
      {
        initialize: async () => undefined,
        list: async () => {
          throw Error("storage unavailable");
        },
      },
      undefined,
      "/fixture/unused",
    ),
  ).rejects.toThrow("storage unavailable");
});
