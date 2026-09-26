import { describe, expect, it } from "vitest";
import {
  AGENT_PROVIDER_DEFINITIONS,
  getUnattendedModeId,
  resolveAutomaticApprovalMode,
} from "./provider-manifest";

describe("resolveAutomaticApprovalMode", () => {
  it("picks Claude's classifier mode, not Bypass", () => {
    expect(resolveAutomaticApprovalMode("claude")).toEqual({
      modeId: "auto",
      supported: true,
      reason: null,
    });
    // The security regression this exists to prevent: Bypass skips review entirely and
    // must never be selected as "automatic approval".
    expect(getUnattendedModeId("claude")).toBe("bypassPermissions");
    expect(resolveAutomaticApprovalMode("claude").modeId).not.toBe(getUnattendedModeId("claude"));
  });

  it("picks Codex's auto-review, not the mode literally named 'auto'", () => {
    // Codex's `auto` is "Default Permissions"; a hard-coded literal would pick it and
    // quietly mean something different than it does on Claude.
    expect(resolveAutomaticApprovalMode("codex")).toEqual({
      modeId: "auto-review",
      supported: true,
      reason: null,
    });
    expect(resolveAutomaticApprovalMode("codex").modeId).not.toBe(getUnattendedModeId("codex"));
  });

  it("reports providers with no automatic mode instead of substituting one", () => {
    for (const provider of ["copilot", "opencode", "pi"]) {
      const resolution = resolveAutomaticApprovalMode(provider);
      if (resolution.supported) continue; // a future adapter may declare one honestly
      expect(resolution).toEqual({
        modeId: null,
        supported: false,
        reason: "no_declared_mode",
      });
    }
    expect(resolveAutomaticApprovalMode("not-a-provider")).toEqual({
      modeId: null,
      supported: false,
      reason: "unknown_provider",
    });
  });

  it("never names a mode the live adapter does not offer", () => {
    expect(resolveAutomaticApprovalMode("claude", ["default", "plan"])).toEqual({
      modeId: null,
      supported: false,
      reason: "not_offered_by_adapter",
    });
    expect(resolveAutomaticApprovalMode("claude", ["default", "auto"]).modeId).toBe("auto");
  });

  it("refuses to choose when a manifest declares more than one", () => {
    const ambiguous = [
      {
        id: "ambiguous",
        label: "Ambiguous",
        modes: [
          { id: "one", label: "One", isAutomaticApproval: true },
          { id: "two", label: "Two", isAutomaticApproval: true },
        ],
        models: [],
      },
    ] as unknown as typeof AGENT_PROVIDER_DEFINITIONS;
    expect(resolveAutomaticApprovalMode("ambiguous", undefined, ambiguous)).toEqual({
      modeId: null,
      supported: false,
      reason: "ambiguous_declaration",
    });
  });

  it("keeps automatic approval and unattended as separate declarations", () => {
    for (const definition of AGENT_PROVIDER_DEFINITIONS) {
      for (const mode of definition.modes) {
        expect(mode.isAutomaticApproval === true && mode.isUnattended === true).toBe(false);
      }
    }
  });
});
