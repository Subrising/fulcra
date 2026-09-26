import { describe, expect, it } from "vitest";
import { AGENT_PROVIDER_DEFINITIONS } from "./provider-manifest";
import type { AgentProviderModeDefinition } from "./provider-manifest";

// An ask-style mode stops and prompts before acting. Detected from what the mode says about
// itself rather than from a list of ids, because the id that means "ask" differs per provider:
// it is "default" on Claude and "ask" elsewhere, and "default" on another provider need not
// mean ask at all. A new provider gets checked without this test being updated.
const isAskStyle = (mode: AgentProviderModeDefinition): boolean =>
  /always ask/i.test(mode.label) || /prompts for permission/i.test(mode.description);

const modeById = (
  modes: AgentProviderModeDefinition[],
  id: string,
): AgentProviderModeDefinition | undefined => modes.find((mode) => mode.id === id);

describe("built-in provider default modes", () => {
  // GOAL.md requires a persisted Auto default for every session-creation path. Voice is a
  // session-creation path, and Claude's voice default was "auto" everywhere except here.
  it("never defaults a session or a voice session to an ask-style mode", () => {
    const offenders: string[] = [];
    for (const provider of AGENT_PROVIDER_DEFINITIONS) {
      const surfaces: [string, string | null | undefined][] = [
        ["session", provider.defaultModeId],
        ["voice", provider.voice?.defaultModeId],
      ];
      for (const [surface, modeId] of surfaces) {
        if (modeId === null || modeId === undefined) continue;
        const mode = modeById(provider.modes, modeId);
        // A default naming a mode the provider does not have is its own bug, and would
        // otherwise slip past the ask check by resolving to nothing.
        expect(
          mode,
          `${provider.id} ${surface} default "${modeId}" is not one of its modes`,
        ).toBeDefined();
        if (mode && isAskStyle(mode)) {
          offenders.push(`${provider.id} ${surface} -> "${modeId}" (${mode.label})`);
        }
      }
    }
    expect(offenders, "a built-in provider starts sessions in an ask-style mode").toEqual([]);
  });

  // Without this, the test above would pass just as happily if isAskStyle stopped matching
  // anything at all. Claude's "default" is the mode the voice default used to point at.
  it("detects ask-style modes, so the check above is not vacuous", () => {
    const claude = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === "claude");
    const ask = claude && modeById(claude.modes, "default");
    expect(ask?.label).toBe("Always Ask");
    expect(ask && isAskStyle(ask)).toBe(true);
    const auto = claude && modeById(claude.modes, "auto");
    expect(auto && isAskStyle(auto)).toBe(false);
  });

  it("keeps Claude's voice default on auto, the mode this regressed from", () => {
    const claude = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === "claude");
    expect(claude?.voice?.defaultModeId).toBe("auto");
    // "auto" must stay a real Claude mode, not just a string that reads well.
    expect(modeById(claude?.modes ?? [], "auto")?.isAutomaticApproval).toBe(true);
  });
});
