import { describe, expect, it } from "vitest";
import { resolveDraftEffort } from "./draft-effort";

const options = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
const models = [
  {
    provider: "claude" as const,
    id: "opus",
    label: "Opus 5.5",
    isDefault: true,
    thinkingOptions: options,
    defaultThinkingOptionId: "medium",
  },
];

describe("draft effort chip", () => {
  it("shows the configured default before a model is explicitly selected", () => {
    expect(resolveDraftEffort(models, "", "")).toEqual({ options, selectedId: "medium" });
  });
  it("keeps an explicit effort and resolves model aliases", () => {
    expect(
      resolveDraftEffort([{ ...models[0]!, aliases: ["default-opus"] }], "default-opus", "high"),
    ).toEqual({ options, selectedId: "high" });
  });
  it("uses the selected model's default instead of the first option", () => {
    expect(resolveDraftEffort(models, "opus", "").selectedId).toBe("medium");
  });
  it("does not invent effort capabilities for unsupported or unresolved models", () => {
    expect(resolveDraftEffort([], "", "")).toEqual({ options: [], selectedId: "" });
    expect(resolveDraftEffort(models, "unknown", "")).toEqual({ options: [], selectedId: "" });
  });
});
