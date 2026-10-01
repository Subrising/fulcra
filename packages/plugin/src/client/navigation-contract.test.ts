import { expect, it } from "vitest";
import type { PluginSurfaceProps } from "./contracts.js";
type Navigation = NonNullable<PluginSurfaceProps["navigation"]>;
it("older navigation objects remain valid and the new method is feature detected", () => {
  const legacy: Navigation = { openAgent() {}, openWorkspace() {} };
  expect(legacy.openArchitectureChange).toBeUndefined();
  const calls: unknown[] = [];
  const current: Navigation = {
    ...legacy,
    openArchitectureChange: (input) => {
      calls.push(input);
    },
  };
  current.openArchitectureChange?.({ workspaceId: "workspace", pullRequest: 3 });
  current.openArchitectureChange?.({
    workspaceId: "workspace",
    commit: { base: "a".repeat(40), head: "b".repeat(40) },
  });
  expect(calls).toHaveLength(2);
});
