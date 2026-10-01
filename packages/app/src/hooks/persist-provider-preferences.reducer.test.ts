import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { describe, expect, it } from "vitest";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import {
  INITIAL_USER_MODIFIED,
  PENDING_AGENT_FORM_RESOLUTION,
  resolveAgentForm,
} from "@/provider-selection/resolve-agent-form";
import type {
  AgentFormAction,
  AgentFormReducerState,
} from "@/provider-selection/resolve-agent-form";
import { persistProviderPreferences } from "./use-agent-form-state";

// persist-provider-preferences.test.ts passes modeChosenByUser as a literal, so it proves the helper
// honours the flag -- not that the flag is right. The claim is "userModified.modeId is true exactly
// when the user chose the mode", and that mapping lives in the reducer. These drive the real reducer
// and feed its real userModified.modeId into the real helper, so the two halves are tested joined.

const providerDef = (id: string) => AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === id);

const START: AgentFormReducerState = {
  form: { provider: "claude", modeId: "", model: "", thinkingOptionId: "" },
  userModified: INITIAL_USER_MODIFIED,
  resolution: PENDING_AGENT_FORM_RESOLUTION,
};

const drive = (actions: AgentFormAction[], from: AgentFormReducerState = START) =>
  actions.reduce(resolveAgentForm, from);

// Persists exactly as use-agent-form-state.ts does: the mode flag comes from the reducer, never a literal.
async function persistFrom(
  state: AgentFormReducerState,
  saved: FormPreferences = {},
): Promise<FormPreferences> {
  let store = saved;
  await persistProviderPreferences({
    provider: state.form.provider as "claude" | "codex",
    formState: state.form,
    modeChosenByUser: state.userModified.modeId,
    modelChosenByUser: state.userModified.model,
    thinkingChosenByUser: state.userModified.thinkingOptionId,
    availableModels: null,
    updatePreferences: async (update) => {
      store = typeof update === "function" ? update(store) : { ...store, ...update };
      return store;
    },
  });
  return store;
}

describe("reducer -> persistProviderPreferences", () => {
  // Reviewer repro 1: a profile that specifies no mode still marked whatever was resolved -- here the
  // saved "default" (ask) -- as the user's intent, re-writing the ratchet the fix removed.
  it("does not persist a mode a mode-less profile merely resolved", async () => {
    const state = drive([
      {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "claude",
        modelId: "",
        modeId: "",
        thinkingOptionId: "",
        providerDef: providerDef("claude"),
        providerModels: null,
        // Marked, so this fixture still means what it did: a mode the user really chose, which the
        // mode-less profile then inherits. An UNMARKED saved mode is a different case and is covered in
        // resolve-agent-form.test.ts -- it no longer resolves at all.
        providerPrefs: { mode: "default", modeChosenByUser: true },
      },
    ]);
    expect(state.form.modeId).toBe("default");
    expect(state.userModified.modeId).toBe(false);
    const after = await persistFrom(state, {
      providerPreferences: { claude: { mode: "auto", modeChosenByUser: true } },
    });
    expect(after.providerPreferences?.claude?.mode).toBe("auto");
    expect(after.providerPreferences?.claude?.modeChosenByUser).toBe(true);
  });

  it("still persists a mode a profile explicitly supplied", async () => {
    const state = drive([
      {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "claude",
        modelId: "",
        modeId: "plan",
        thinkingOptionId: "",
        providerDef: providerDef("claude"),
        providerModels: null,
      },
    ]);
    expect(state.userModified.modeId).toBe(true);
    expect((await persistFrom(state)).providerPreferences?.claude?.mode).toBe("plan");
  });

  // Reviewer repro 2: picking "plan" on Claude and then switching to Codex wrote Codex's resolved
  // "auto-review" as a Codex choice -- a decision the user never made for that provider.
  it("does not persist a choice made for one provider onto another", async () => {
    const state = drive([
      { type: "SET_MODE_FROM_USER", modeId: "plan" },
      {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "",
        providerDef: providerDef("codex"),
        providerModels: null,
      },
    ]);
    expect(state.form.provider).toBe("codex");
    expect(state.form.modeId).toBe("full-access"); // Codex's built-in default (FIX-8 B)
    expect(state.userModified.modeId).toBe(false);
    expect((await persistFrom(state)).providerPreferences?.codex?.mode).toBeUndefined();
  });

  // The reset must not reach across a no-op provider "change": the pick is still the user's.
  it("keeps the user's mode when the provider does not actually change", async () => {
    const state = drive([
      { type: "SET_MODE_FROM_USER", modeId: "plan" },
      {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "claude",
        modelId: "",
        providerDef: providerDef("claude"),
        providerModels: null,
      },
    ]);
    expect(state.userModified.modeId).toBe(true);
    expect((await persistFrom(state)).providerPreferences?.claude?.mode).toBe("plan");
  });

  // And a deliberate pick after the switch is still honoured.
  it("persists a mode chosen after switching provider", async () => {
    const state = drive([
      { type: "SET_MODE_FROM_USER", modeId: "plan" },
      {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "",
        providerDef: providerDef("codex"),
        providerModels: null,
      },
      { type: "SET_MODE_FROM_USER", modeId: "full-access" },
    ]);
    expect(state.userModified.modeId).toBe(true);
    expect((await persistFrom(state)).providerPreferences?.codex?.mode).toBe("full-access");
  });
});

// The model half, driven through the real reducer for the same reason the mode half is: the claim is
// "userModified.model is true exactly when the user chose the model", and a literal cannot test it.
describe("reducer -> persistProviderPreferences: a resolved model is not a chosen one", () => {
  it("does not persist a model that only came from background resolution", async () => {
    const state = drive([
      {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: null,
        providerModelsByProvider: new Map([
          [
            "claude",
            [
              { provider: "claude", id: "claude-opus-5", label: "Opus 5" },
              { provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true },
            ],
          ],
        ]),
        allowedProviderMap: new Map([["claude", providerDef("claude")!]]),
      },
    ]);
    // Empty, deliberately: nothing was chosen, so the composer labels it with the host's advertised
    // default and submits no model, leaving the session free to follow the host then and later.
    expect(state.form.model).toBe("");
    expect(state.userModified.model).toBe(false);
    // And submitting does not write anything back as a preference, so the host stays free to move it.
    const after = await persistFrom(state);
    expect(after.providerPreferences?.claude?.model).toBeUndefined();
  });

  it("persists a model the user picked", async () => {
    const state = drive([
      {
        type: "SET_MODEL_FROM_USER",
        modelId: "claude-opus-5",
        availableModels: [{ provider: "claude", id: "claude-opus-5", label: "Opus 5" }],
        providerPrefs: undefined,
      },
    ]);
    expect(state.userModified.model).toBe(true);
    const after = await persistFrom(state);
    expect(after.providerPreferences?.claude?.model).toBe("claude-opus-5");
    expect(after.providerPreferences?.claude?.modelChosenByUser).toBe(true);
  });
});
