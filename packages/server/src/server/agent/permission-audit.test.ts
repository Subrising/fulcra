import { expect, test } from "vitest";
import { permissionAudit } from "./permission-audit.js";

test("permission records identify the session, rule, tool, target, and outcome without arguments", () => {
  const agent = {
    id: "agent-1",
    title: "Example job",
    cwd: "/fixture",
    runtimeInfo: { sessionId: "native-1" },
  };
  const request = {
    id: "request-1",
    provider: "codex",
    kind: "tool" as const,
    name: "Bash",
    input: { command: "echo secret-marker" },
  };
  for (const decision of ["allow", "deny", "defer", "failed"] as const) {
    const record = permissionAudit(agent, request, request.id, decision, "example-rule", "daemon");
    expect(record).toMatchObject({
      agentId: agent.id,
      sessionId: "native-1",
      sessionName: "Example job",
      requestId: request.id,
      tool: "Bash",
      decision,
      rule: "example-rule",
      source: "daemon",
    });
    expect(record.target.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isNaN(Date.parse(record.recordedAt))).toBe(false);
    expect(JSON.stringify(record)).not.toContain("secret-marker");
  }
  expect(
    permissionAudit(
      agent,
      { ...request, input: { command: "pwd" } },
      request.id,
      "allow",
      "example-rule",
      "human",
    ).target.inputSha256,
  ).not.toBe(
    permissionAudit(agent, request, request.id, "allow", "example-rule", "human").target
      .inputSha256,
  );
});
