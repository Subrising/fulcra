import { describe, expect, it } from "vitest";
import { CreateAgentPreferencesService } from "./service";
import {
  applyAgentProfilePreferences,
  mergeCreateAgentSelectionPreferences,
  mergeProviderPreferences,
  parseFormPreferences,
} from "./preferences";
import { FakeCreateAgentPreferenceStorage } from "./test-utils/fake-preference-storage";

describe("create agent preferences", () => {
  it("keeps the selected mode after saving model and thinking", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const modelWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { model: "gpt-5.5", thinkingByModel: { "gpt-5.5": "high" } },
      }),
    );
    await storage.nextWrite();

    const modeWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { mode: "full-access" },
      }),
    );

    expect(storage.pendingWriteCount()).toBe(1);
    storage.finishOldestWrite();
    await modelWrite;

    await storage.nextWrite();
    storage.finishOldestWrite();
    await modeWrite;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          thinkingByModel: { "gpt-5.5": "high" },
          mode: "full-access",
        },
      },
    });
  });

  it("does not commit a failed write or leak it into the next update", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const failedWrite = preferences.update({ provider: "claude" });
    await storage.nextWrite();
    storage.failOldestWrite(new Error("disk full"));
    await expect(failedWrite).rejects.toThrow("disk full");

    expect(await preferences.load()).toEqual({});

    const successfulWrite = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await successfulWrite;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
  });

  it("flushes the full create-agent selection into provider preferences", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const saveSelection = preferences.update((current) =>
      mergeCreateAgentSelectionPreferences({
        preferences: current,
        provider: "codex",
        modelId: "gpt-5.5",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    );

    await storage.nextWrite();
    storage.finishOldestWrite();
    await saveSelection;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          modelChosenByUser: true,
          mode: "full-access",
          modeChosenByUser: true,
          thinkingByModel: { "gpt-5.5": "high" },
          thinkingChosenByModel: { "gpt-5.5": true },
          featureValues: { fast_mode: true },
        },
      },
    });
  });

  it("does not erase a saved mode when a later partial update has no mode", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.5",
              mode: "full-access",
              thinkingByModel: { "gpt-5.5": "high" },
            },
          },
        },
        provider: "codex",
        updates: {
          model: "gpt-5.6",
          mode: undefined,
          thinkingByModel: undefined,
          featureValues: undefined,
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.6",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
        },
      },
    });
  });

  it("erases a saved mode when a complete selection explicitly has no mode", () => {
    expect(
      mergeCreateAgentSelectionPreferences({
        preferences: {
          provider: "pi",
          providerPreferences: { pi: { model: "anthropic/sonnet", mode: "full-access" } },
        },
        provider: "pi",
        modelId: "anthropic/sonnet",
        modeId: null,
      }),
    ).toEqual({
      provider: "pi",
      providerPreferences: { pi: { model: "anthropic/sonnet", modelChosenByUser: true } },
    });
  });

  it("repairs the previous provider while applying a profile", () => {
    expect(
      applyAgentProfilePreferences({
        preferences: {
          provider: "pi",
          providerPreferences: {
            pi: { model: "anthropic/sonnet", mode: "full-access" },
            mock: { model: "ten-second-stream", mode: "load-test" },
          },
        },
        previousProvider: "pi",
        previousProviderModeIds: [],
        provider: "mock",
        modelId: "one-minute-stream",
        modeId: "approval-test",
        thinkingOptionId: "",
        featureValues: {},
      }),
    ).toEqual({
      provider: "mock",
      providerPreferences: {
        pi: { model: "anthropic/sonnet" },
        mock: {
          model: "one-minute-stream",
          modelChosenByUser: true,
          mode: "approval-test",
          modeChosenByUser: true,
          featureValues: {},
        },
      },
    });
  });

  // The marker describes the model CURRENTLY stored, so a write that does not claim the model was chosen
  // has to clear it. Leaving it would let the next resolved model inherit an earlier pick's authority --
  // the same ratchet, one step removed -- and the value it pins is exactly the one the host wanted to move.
  it("clears the chosen marker when a later write does not claim a choice", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          providerPreferences: { codex: { model: "gpt-5.5", modelChosenByUser: true } },
        },
        provider: "codex",
        updates: { model: "gpt-5.4" },
      }).providerPreferences?.codex,
    ).toEqual({ model: "gpt-5.4" });
  });

  it("leaves the marker alone when a write touches neither the model nor the marker", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          providerPreferences: { codex: { model: "gpt-5.5", modelChosenByUser: true } },
        },
        provider: "codex",
        updates: { thinkingByModel: { "gpt-5.5": "high" } },
      }).providerPreferences?.codex,
    ).toEqual({
      model: "gpt-5.5",
      modelChosenByUser: true,
      thinkingByModel: { "gpt-5.5": "high" },
    });
  });

  // A profile written by an older build has a model and no marker. It parses, and the resolution path
  // treats it as "not chosen" -- see resolve-agent-form.test.ts. Nothing here rejects or rewrites it.
  it("loads a model saved before the marker existed, without inventing one", () => {
    expect(
      parseFormPreferences({ providerPreferences: { claude: { model: "claude-opus-5" } } }),
    ).toEqual({ providerPreferences: { claude: { model: "claude-opus-5" } } });
  });

  // The same three rules for the mode and the per-model effort. Each marker is separate on purpose: a
  // single "the user configured something" flag would let choosing a mode revive a model nobody picked.
  it("clears the chosen marker for a mode a later write does not claim", () => {
    expect(
      mergeProviderPreferences({
        preferences: { providerPreferences: { claude: { mode: "auto", modeChosenByUser: true } } },
        provider: "claude",
        updates: { mode: "default" },
      }).providerPreferences?.claude,
    ).toEqual({ mode: "default" });
  });

  it("drops both the mode and its marker when a write erases the mode", () => {
    expect(
      mergeProviderPreferences({
        preferences: { providerPreferences: { claude: { mode: "auto", modeChosenByUser: true } } },
        provider: "claude",
        updates: { mode: null },
      }).providerPreferences?.claude,
    ).toEqual({});
  });

  it("marks the effort per model, and one model's effort does not unmark another's", () => {
    const after = mergeProviderPreferences({
      preferences: {
        providerPreferences: {
          claude: {
            thinkingByModel: { "claude-opus-5": "high", "claude-opus-5-5": "high" },
            thinkingChosenByModel: { "claude-opus-5": true, "claude-opus-5-5": true },
          },
        },
      },
      provider: "claude",
      // An effort resolved for 5.5 only: it clears 5.5's mark and leaves Opus 5's choice alone.
      updates: { thinkingByModel: { "claude-opus-5-5": "medium" } },
    }).providerPreferences?.claude;
    expect(after?.thinkingByModel).toEqual({
      "claude-opus-5": "high",
      "claude-opus-5-5": "medium",
    });
    expect(after?.thinkingChosenByModel).toEqual({ "claude-opus-5": true });
  });

  it("loads a mode and an effort saved before the markers existed, without inventing one", () => {
    expect(
      parseFormPreferences({
        providerPreferences: {
          claude: { mode: "default", thinkingByModel: { "claude-opus-5": "high" } },
        },
      }),
    ).toEqual({
      providerPreferences: {
        claude: { mode: "default", thinkingByModel: { "claude-opus-5": "high" } },
      },
    });
  });

  it("loads invalid stored preferences as empty preferences", () => {
    expect(parseFormPreferences({ providerPreferences: { codex: { mode: 42 } } })).toEqual({});
  });

  it("strips the explicitly supported legacy location fields", () => {
    expect(
      parseFormPreferences({
        workingDir: "/old/workspace",
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.4-mini",
            mode: "full-access",
            thinkingOptionId: "high",
          },
        },
        serverId: "old-host",
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4-mini",
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "high" },
        },
      },
    });
  });

  it("rejects unknown persisted fields outside the explicit legacy shape", () => {
    expect(parseFormPreferences({ provider: "codex", surprise: true })).toEqual({});
  });

  it("persists and reloads the workspace isolation choice", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      isolation: "worktree",
    });
  });

  it("preserves legacy favourites across preference writes until host migration", async () => {
    const favoriteModels = [{ provider: "claude", modelId: "opus" }];
    const storage = new FakeCreateAgentPreferenceStorage({ stored: { favoriteModels } });
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ favoriteModels, isolation: "worktree" });
  });

  it("treats stored preferences without an isolation choice as undefined", () => {
    expect(parseFormPreferences({ provider: "codex" }).isolation).toBeUndefined();
  });

  it("rejects an unknown isolation value as invalid stored preferences", () => {
    expect(parseFormPreferences({ provider: "codex", isolation: "sandbox" })).toEqual({});
  });

  it("persists and reloads a terminal launch target", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ launchTarget: { kind: "terminal", profileId: "claude" } });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({
      launchTarget: { kind: "terminal", profileId: "claude" },
    });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      launchTarget: { kind: "terminal", profileId: "claude" },
    });
  });

  it("treats stored preferences without a launch target as undefined, defaulting to chat", () => {
    expect(parseFormPreferences({ provider: "codex" }).launchTarget).toBeUndefined();
  });

  it("rejects a terminal launch target missing a profileId as invalid stored preferences", () => {
    expect(parseFormPreferences({ launchTarget: { kind: "terminal" } })).toEqual({});
  });

  it("rejects an unknown launch target kind as invalid stored preferences", () => {
    expect(parseFormPreferences({ launchTarget: { kind: "shell" } })).toEqual({});
  });

  it("remembers the role, and reads a role this build does not know as none without losing the rest", () => {
    expect(parseFormPreferences({ provider: "claude", role: "planning" })).toEqual({
      provider: "claude",
      role: "planning",
    });
    expect(parseFormPreferences({ provider: "claude", role: "reviewer" })).toEqual({
      provider: "claude",
    });
    expect(parseFormPreferences({ provider: "claude" })).toEqual({ provider: "claude" });
  });
});
