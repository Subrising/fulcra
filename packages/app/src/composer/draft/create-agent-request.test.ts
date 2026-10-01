import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { requestWorkspaceDraftAgent } from "./create-agent-request";

function fakeClient() {
  const createAgent = vi.fn(async () => ({ id: "agent-1" }));
  return { client: { createAgent } as unknown as DaemonClient, createAgent };
}
const base = {
  workspaceId: "workspace-1",
  config: { provider: "claude", cwd: "/project" },
  text: "",
  clientMessageId: "message-1",
};

describe("requestWorkspaceDraftAgent", () => {
  it("sends the role as the fulcra.role label", async () => {
    const { client, createAgent } = fakeClient();
    await requestWorkspaceDraftAgent(client, { ...base, role: "implementation" });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ labels: { "fulcra.role": "implementation" } }),
    );
  });

  it("sends no labels without a role, exactly as before", async () => {
    const { client, createAgent } = fakeClient();
    await requestWorkspaceDraftAgent(client, base);
    await requestWorkspaceDraftAgent(client, { ...base, role: null });
    for (const [options] of createAgent.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(Object.hasOwn(options, "labels")).toBe(false);
    }
  });
});
