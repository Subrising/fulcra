import { describe, expect, it } from "vitest";
import {
  buildAgentAttentionNotificationPayload,
  findLatestAssistantMessageFromTimeline,
  findLatestPermissionRequest,
} from "./agent-attention-notification.js";

describe("buildAgentAttentionNotificationPayload", () => {
  it("carries the workspace needed to open a cold agent destination", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });

    expect(payload.data).toEqual({
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      reason: "finished",
    });
  });

  it("builds finished notifications from markdown assistant text", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      assistantMessage: "**Done**. Updated `README.md` and [link](https://example.com).",
    });

    expect(payload).toEqual({
      title: "Agent finished",
      body: "Done. Updated README.md and link.",
      data: {
        serverId: "srv-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        reason: "finished",
      },
    });
  });

  it("summarises a permission by tool name, never by its command text", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "srv-2",
      workspaceId: "workspace-2",
      agentId: "agent-2",
      permissionRequest: {
        id: "perm-1",
        provider: "claude",
        name: "exec",
        kind: "tool",
        title: "**Approve command**",
        description: "Run `git push`",
      },
    });

    expect(payload).toEqual({
      title: "Agent needs permission",
      body: "Wants to use exec",
      data: {
        serverId: "srv-2",
        workspaceId: "workspace-2",
        agentId: "agent-2",
        reason: "permission",
      },
    });
  });

  it("never puts a secret in the body or title, on any text path", () => {
    const sentinel = "FAKE-REVIEW-SENTINEL";
    const base = { serverId: "s", workspaceId: "w", agentId: "a" } as const;
    const everything = (payload: { title: string; body: string }) =>
      JSON.stringify([payload.title, payload.body]);

    const permission = buildAgentAttentionNotificationPayload({
      ...base,
      reason: "permission",
      permissionRequest: {
        id: "p",
        provider: "codex",
        name: "shell",
        kind: "tool",
        title: `TOKEN=${sentinel} npm publish`,
        description: `curl -H "Authorization: Bearer ${sentinel}" https://x`,
        input: { command: `TOKEN=${sentinel}` },
        metadata: { env: `API_KEY=${sentinel}` },
      },
    });
    expect(everything(permission)).not.toContain(sentinel);

    const finished = buildAgentAttentionNotificationPayload({
      ...base,
      reason: "finished",
      agentTitle: `deploy PASSWORD=${sentinel}`,
      assistantMessage: [
        `Ran with GITHUB_TOKEN=${sentinel}, then \`curl --token ${sentinel} https://h\`.`,
        "Key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnop1234 and",
        `https://user:${sentinel}@host/path and ${"a1B2c3D4".repeat(6)}`,
      ].join(" "),
    });
    expect(everything(finished)).not.toContain(sentinel);
    expect(everything(finished)).not.toMatch(/sk-abcdef|ghp_abcdef|a1B2c3D4a1B2/);
  });

  it("uses error-specific defaults when reason is error", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "error",
      serverId: "srv-3",
      workspaceId: "workspace-3",
      agentId: "agent-3",
    });

    expect(payload).toEqual({
      title: "Agent needs attention",
      body: "Encountered an error.",
      data: {
        serverId: "srv-3",
        workspaceId: "workspace-3",
        agentId: "agent-3",
        reason: "error",
      },
    });
  });
});

describe("findLatestAssistantMessageFromTimeline", () => {
  it("joins the latest contiguous assistant chunks", () => {
    expect(
      findLatestAssistantMessageFromTimeline([
        { type: "user_message", text: "start" },
        { type: "assistant_message", text: "Part " },
        { type: "assistant_message", text: "one" },
        { type: "reasoning", text: "thinking..." },
        { type: "assistant_message", text: "Done " },
        { type: "assistant_message", text: "now" },
      ]),
    ).toBe("Done now");
  });
});

describe("findLatestPermissionRequest", () => {
  it("returns the most recently inserted request", () => {
    const pending = new Map([
      ["first", { id: "first", provider: "claude", name: "a", kind: "tool" } as const],
      ["second", { id: "second", provider: "claude", name: "b", kind: "tool" } as const],
    ]);

    expect(findLatestPermissionRequest(pending)?.id).toBe("second");
  });
});
