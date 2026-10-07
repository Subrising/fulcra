// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingPermission } from "@/types/shared";

const f = vi.hoisted(() => ({ pending: new Map<string, unknown>() }));
vi.mock("@/agent-stream/view", () => ({
  PermissionRequestCard: ({ permission }: { permission: { key: string } }) => (
    <div data-testid="question-card">{permission.key}</div>
  ),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({ sessions: { srv_a: { pendingPermissions: f.pending } } }),
}));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));
import { AgentQuestions, pendingQuestionsFor } from "./agent-questions";

afterEach(cleanup);
const ask = (key: string, agentId: string, kind: string) =>
  ({ key, agentId, request: { kind } }) as unknown as PendingPermission;

it("shows only that agent's questions; tool approvals stay in the chat", async () => {
  const pending = new Map([
    ["q1", ask("q1", "agent-1", "question")],
    ["p1", ask("p1", "agent-1", "tool")],
    ["q2", ask("q2", "agent-2", "question")],
  ]);
  expect(pendingQuestionsFor(pending, "agent-1").map((p) => p.key)).toEqual(["q1"]);
  expect(pendingQuestionsFor(undefined, "agent-1")).toEqual([]);
  f.pending = pending;
  render(<AgentQuestions serverId="srv_a" agentId="agent-1" testID="questions" />);
  expect((await screen.findAllByTestId("question-card")).map((n) => n.textContent)).toEqual(["q1"]);
});

it("renders nothing when the agent has no question", () => {
  f.pending = new Map([["p1", ask("p1", "agent-1", "tool")]]);
  const view = render(<AgentQuestions serverId="srv_a" agentId="agent-1" />);
  expect(view.container.textContent).toBe("");
});
