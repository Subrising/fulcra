import { expect, it } from "vitest";
import type { SettingsInputProps } from "./ui.js";
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

it("the public SettingsInput type preserves row defaults and adds an explicit stacked form layout", () => {
  const edits: string[] = [];
  const row: SettingsInputProps = {
    label: "Ordinary setting",
    onChangeText: (value) => edits.push(value),
  };
  const form: SettingsInputProps = { ...row, layout: "stacked" };
  expect(row.layout).toBeUndefined();
  expect(form.layout).toBe("stacked");
  form.onChangeText("retained goal");
  expect(edits).toEqual(["retained goal"]);
});
