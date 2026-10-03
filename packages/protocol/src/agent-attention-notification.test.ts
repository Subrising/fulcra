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

  it("keeps a question's text, redacted, since it is the assistant's own prose", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "s",
      workspaceId: "w",
      agentId: "a",
      permissionRequest: {
        id: "q",
        provider: "claude",
        name: "AskUserQuestion",
        kind: "question",
        title: "Which library should we use?",
        description: "Set API_KEY=FAKE-REVIEW-SENTINEL first?",
      },
    });
    expect(payload.body).toContain("Which library should we use?");
    expect(payload.body).not.toContain("FAKE-REVIEW-SENTINEL");
  });

  it("suppresses the entire credential-bearing field, including quoted value suffixes", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "s",
      workspaceId: "w",
      agentId: "a",
      agentTitle: "Deploy documentation",
      assistantMessage: 'Set API_KEY="prefix FAKE-REVIEW-SENTINEL suffix" then continue.',
    });
    expect(payload).toEqual({
      title: "Deploy documentation",
      body: "[redacted]",
      data: { serverId: "s", workspaceId: "w", agentId: "a", reason: "finished" },
    });
  });

  const credentialSentinel = "FAKE-REVIEW-SENTINEL";
  const credentialFixtures = [
    ["uppercase assignment", `TOKEN=${credentialSentinel}`],
    ["lowercase bare token", `token=${credentialSentinel}`],
    ["lowercase bare password", `password=${credentialSentinel}`],
    ["mixed case bare token", `ToKeN=${credentialSentinel}`],
    ["password alias", `passwd=${credentialSentinel}`],
    ["short password alias", `pwd=${credentialSentinel}`],
    ["secret", `secret=${credentialSentinel}`],
    ["hyphenated API key", `api-key=${credentialSentinel}`],
    ["compact API key", `apikey=${credentialSentinel}`],
    ["auth", `auth=${credentialSentinel}`],
    ["credential", `credential=${credentialSentinel}`],
    ["cookie", `cookie=${credentialSentinel}`],
    ["private key", `private_key=${credentialSentinel}`],
    ["prefixed token", `service_access_token=${credentialSentinel}`],
    ["JSON token", `{"token":"${credentialSentinel}"}`],
    ["JSON API key", `{"api_key":"${credentialSentinel}"}`],
    ["JSON password", `{"password":"${credentialSentinel}"}`],
    ["nested JSON", `{"config":{"password": "prefix ${credentialSentinel} suffix"}}`],
    ["escaped JSON key", `{"to\\u006ben":"${credentialSentinel}"}`],
    ["escaped JSON quotes", `{"password":"prefix \\"quoted\\" ${credentialSentinel} suffix"}`],
    ["JSON encoded string", JSON.stringify(JSON.stringify({ token: credentialSentinel }))],
    ["YAML token", `token: ${credentialSentinel}`],
    ["YAML quoted key", `'api_key': 'prefix ${credentialSentinel} suffix'`],
    ["YAML literal value", `password: |\n  prefix\n  ${credentialSentinel}\n  suffix`],
    ["YAML folded value", `token: >-\n  prefix\n  ${credentialSentinel}\n  suffix`],
    ["quoted assignment with spaces", `API_KEY="prefix ${credentialSentinel} suffix"`],
    ["single quoted assignment", `password='prefix ${credentialSentinel} suffix'`],
    ["escaped assignment quotes", `token="prefix \\"quoted\\" ${credentialSentinel} suffix"`],
    ["quoted literal newline", `token="prefix\n${credentialSentinel}\nsuffix"`],
    ["assignment next line", `password=\n  ${credentialSentinel}`],
    ["shell continuation", `token\\\n=${credentialSentinel}`],
    ["unterminated quote", `token="prefix ${credentialSentinel}\nsuffix`],
    ["markdown fenced YAML", `\`\`\`yaml\napi_key: |\n  ${credentialSentinel}\n\`\`\``],
    ["markdown split key", `**api**_key=${credentialSentinel}`],
    ["CLI flag", `--token ${credentialSentinel}`],
    ["CLI quoted flag", `--password='prefix ${credentialSentinel} suffix'`],
    ["authorization header", `Authorization: Bearer ${credentialSentinel}`],
    ["basic auth", `Basic ${credentialSentinel}`],
    ["credential URL", `https://user:${credentialSentinel}@example.invalid/path`],
    ["uppercase noncredential assignment refusal", `CONFIG="prefix ${credentialSentinel} suffix"`],
    ["credential after preview limit", `${"Safe prose. ".repeat(30)}token=${credentialSentinel}`],
  ] as const;

  for (const [name, text] of credentialFixtures) {
    for (const path of [
      "assistant",
      "session title",
      "question title",
      "question description",
    ] as const) {
      it(`suppresses the whole ${path} for ${name}`, () => {
        const question = path === "question title" || path === "question description";
        const payload = buildAgentAttentionNotificationPayload({
          reason: question ? "permission" : "finished",
          serverId: "s",
          workspaceId: "w",
          agentId: "a",
          agentTitle: path === "session title" ? text : "Deploy documentation",
          assistantMessage: path === "assistant" ? text : "Updated README.md.",
          permissionRequest: {
            id: "q",
            provider: "fake-provider",
            name: "AskUserQuestion",
            kind: "question",
            title: path === "question title" ? text : "Choose a library?",
            description: path === "question description" ? text : "Review the choices.",
          },
        });
        const expectedBodies = {
          assistant: "[redacted]",
          "session title": "Updated README.md.",
          "question title": "[redacted]",
          "question description": "Choose a library? - [redacted]",
        };
        expect(payload).toEqual({
          title: path === "session title" ? "[redacted]" : "Deploy documentation",
          body: expectedBodies[path],
          data: {
            serverId: "s",
            workspaceId: "w",
            agentId: "a",
            reason: question ? "permission" : "finished",
          },
        });
        expect(JSON.stringify(payload)).not.toContain(credentialSentinel);
      });
    }
  }

  it("omits a question description that continues a credential from its title", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "s",
      workspaceId: "w",
      agentId: "a",
      permissionRequest: {
        id: "q",
        provider: "fake-provider",
        name: "AskUserQuestion",
        kind: "question",
        title: 'password="prefix',
        description: `${credentialSentinel} suffix"`,
      },
    });
    expect(payload.body).toBe("[redacted]");
    expect(JSON.stringify(payload)).not.toContain(credentialSentinel);
  });

  for (const kind of ["tool", "plan", "mode", "other"] as const) {
    it(`omits raw title, description, input and metadata for ${kind} permissions`, () => {
      const payload = buildAgentAttentionNotificationPayload({
        reason: "permission",
        serverId: "s",
        workspaceId: "w",
        agentId: "a",
        permissionRequest: {
          id: "p",
          provider: "fake-provider",
          name: "shell",
          kind,
          title: credentialSentinel,
          description: credentialSentinel,
          input: { command: credentialSentinel },
          metadata: { secret: credentialSentinel },
        },
      });
      expect(payload.body).toBe("Wants to use shell");
      expect(JSON.stringify(payload)).not.toContain(credentialSentinel);
    });
  }

  for (const [name, text] of [
    ["provider key", "sk-abcdefghijklmnop1234"],
    ["public key", "pk-abcdefghijklmnop1234"],
    ["restricted key", "rk-abcdefghijklmnop1234"],
    ["GitHub token", "ghp_abcdefghijklmnop1234"],
    ["GitHub fine-grained token", "github_pat_abcdefghijklmnop1234"],
    ["Slack token", "xoxb-abcdefghijklmnop1234"],
    ["AWS key", "AKIAabcdefghijklmnop1234"],
    ["Google key", "AIzaabcdefghijklmnop1234"],
    ["JWT", "eyJabcdefghijk.abcdefghijk.abcdefghijk"],
    ["long opaque value", "a1B2c3D4".repeat(6)],
  ] as const) {
    it(`preserves the existing ${name} refusal`, () => {
      const payload = buildAgentAttentionNotificationPayload({
        reason: "finished",
        serverId: "s",
        workspaceId: "w",
        agentId: "a",
        assistantMessage: text,
        agentTitle: text,
      });
      expect(payload.title).toBe("[redacted]");
      expect(payload.body).toBe("[redacted]");
    });
  }

  it("keeps safe question prose, session metadata and bounded previews", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "s",
      workspaceId: "w",
      agentId: "a",
      agentTitle: "Deploy documentation",
      permissionRequest: {
        id: "q",
        provider: "fake-provider",
        name: "AskUserQuestion",
        kind: "question",
        title: "Which library should we use?",
        description: "Choose npm or pnpm.",
      },
    });
    expect(payload).toEqual({
      title: "Deploy documentation",
      body: "Which library should we use? - Choose npm or pnpm.",
      data: { serverId: "s", workspaceId: "w", agentId: "a", reason: "permission" },
    });
    const bounded = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "s",
      workspaceId: "w",
      agentId: "a",
      agentTitle: "x ".repeat(100),
      assistantMessage: "x ".repeat(200),
    });
    expect(bounded.title).toHaveLength(80);
    expect(bounded.body).toHaveLength(220);
    expect(bounded.title).toMatch(/\.\.\.$/);
    expect(bounded.body).toMatch(/\.\.\.$/);
  });

  for (const reason of ["finished", "error", "permission"] as const) {
    it(`redacts a session title for ${reason} without exposing unused assistant text`, () => {
      const payload = buildAgentAttentionNotificationPayload({
        reason,
        serverId: "s",
        workspaceId: "w",
        agentId: "a",
        agentTitle: `password=${credentialSentinel}`,
        assistantMessage: `token=${credentialSentinel}`,
      });
      const expectedBodies = {
        finished: "[redacted]",
        error: "Encountered an error.",
        permission: "Permission requested.",
      };
      expect(payload).toEqual({
        title: "[redacted]",
        body: expectedBodies[reason],
        data: { serverId: "s", workspaceId: "w", agentId: "a", reason },
      });
    });
  }

  it("redacts credential syntax in the tool name itself", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "s",
      workspaceId: "w",
      agentId: "a",
      permissionRequest: {
        id: "p",
        provider: "fake-provider",
        name: `shell token=${credentialSentinel}`,
        kind: "tool",
      },
    });
    expect(payload.body).toBe("[redacted]");
    expect(JSON.stringify(payload)).not.toContain(credentialSentinel);
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
