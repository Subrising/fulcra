import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";

test("supporting daemon advertises optional resume feature even when its enabled setting is false", async () => {
  expect(
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }).autoResumeOnLimit,
  ).toBe(true);
  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: createTestAgentClient("codex") },
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.autoResumeOnLimit).toBe(true);
    await client.patchDaemonConfig({ autoResumeOnLimit: false });
    await client.close();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.autoResumeOnLimit).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
  }
});
