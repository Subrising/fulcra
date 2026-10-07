/**
 * @vitest-environment jsdom
 */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: { sessions: Record<string, unknown> }) => unknown) =>
    select({ sessions: {} }),
}));

import { useReviewExplanation } from "./use-generated-change";

// The real hook, not a mock: the review and map screens mock it, which hid a query option that throws on render.
it("builds a valid query for every explanation kind", () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  for (const kind of ["summary", "pseudocode", "module"] as const) {
    const { result } = renderHook(
      () =>
        useReviewExplanation({
          serverId: "s1",
          cwd: "/repo",
          base: "a".repeat(40),
          head: "b".repeat(40),
          path: "src",
          kind,
          enabled: true,
        }),
      { wrapper },
    );
    expect(result.current.error).toBeNull();
  }
});
