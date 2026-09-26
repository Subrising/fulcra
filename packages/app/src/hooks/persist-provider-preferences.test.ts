import { describe, expect, it } from "vitest";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { persistProviderPreferences } from "./use-agent-form-state";

// Runs persistProviderPreferences against an in-memory preference store and returns what it saved.
async function persist(args: {
  saved: FormPreferences;
  resolvedModeId: string;
  modeChosenByUser: boolean;
  modelChosenByUser?: boolean;
  thinkingChosenByUser?: boolean;
}): Promise<FormPreferences> {
  let store = args.saved;
  await persistProviderPreferences({
    provider: "claude",
    formState: {
      provider: "claude",
      modeId: args.resolvedModeId,
      model: "claude-opus-5",
      thinkingOptionId: "",
    },
    modeChosenByUser: args.modeChosenByUser,
    modelChosenByUser: args.modelChosenByUser ?? false,
    thinkingChosenByUser: args.thinkingChosenByUser ?? false,
    availableModels: null,
    updatePreferences: async (update) => {
      store = typeof update === "function" ? update(store) : { ...store, ...update };
      return store;
    },
  });
  return store;
}

describe("persistProviderPreferences -- a resolved mode is not a chosen one", () => {
  it("does not save a mode the user never picked", async () => {
    // The form resolved to "default" (ask) from some default. Nobody chose it.
    const after = await persist({ saved: {}, resolvedModeId: "default", modeChosenByUser: false });
    expect(after.providerPreferences?.claude?.mode).toBeUndefined();
  });

  it("does not overwrite an earlier explicit choice with a resolved mode", async () => {
    // The ratchet this fixes: the user chose auto once; a later session resolved to "default"
    // and, on submit, was written back as if chosen -- after which every session started in ask.
    const saved: FormPreferences = { providerPreferences: { claude: { mode: "auto" } } };
    const after = await persist({ saved, resolvedModeId: "default", modeChosenByUser: false });
    expect(after.providerPreferences?.claude?.mode).toBe("auto");
  });

  it("saves a mode the user actually picked", async () => {
    const after = await persist({ saved: {}, resolvedModeId: "auto", modeChosenByUser: true });
    expect(after.providerPreferences?.claude?.mode).toBe("auto");
  });

  // The model half of the same ratchet, fixed one release later. Submitting used to write the resolved
  // model back unconditionally, so the first session that came up on an older model pinned that model
  // into the profile -- after which it outranked whatever the host advertised as its default, on every
  // new chat, forever. That is how a fleet stays on a previous release while its host has moved on.
  it("does not save a model the user never picked", async () => {
    const after = await persist({ saved: {}, resolvedModeId: "auto", modeChosenByUser: false });
    expect(after.providerPreferences?.claude?.model).toBeUndefined();
    expect(after.providerPreferences?.claude?.modelChosenByUser).toBeUndefined();
  });

  it("does not overwrite an earlier explicit model choice with a resolved one", async () => {
    const saved: FormPreferences = {
      providerPreferences: { claude: { model: "claude-fable-5-1", modelChosenByUser: true } },
    };
    const after = await persist({ saved, resolvedModeId: "auto", modeChosenByUser: false });
    expect(after.providerPreferences?.claude?.model).toBe("claude-fable-5-1");
    expect(after.providerPreferences?.claude?.modelChosenByUser).toBe(true);
  });

  it("saves a model the user actually picked, and marks it as chosen", async () => {
    const after = await persist({
      saved: {},
      resolvedModeId: "auto",
      modeChosenByUser: false,
      modelChosenByUser: true,
    });
    expect(after.providerPreferences?.claude?.model).toBe("claude-opus-5");
    expect(after.providerPreferences?.claude?.modelChosenByUser).toBe(true);
  });

  it("marks a mode the user picked, so it can outrank the provider default later", async () => {
    const after = await persist({ saved: {}, resolvedModeId: "plan", modeChosenByUser: true });
    expect(after.providerPreferences?.claude?.mode).toBe("plan");
    expect(after.providerPreferences?.claude?.modeChosenByUser).toBe(true);
  });

  it("does not record an effort the form merely resolved", async () => {
    // The third form of the same ratchet: a session that came up High wrote High into the profile, and it
    // then outranked the model's own default effort -- Medium, for the current default model -- forever.
    let store: FormPreferences = {};
    await persistProviderPreferences({
      provider: "claude",
      formState: {
        provider: "claude",
        modeId: "auto",
        model: "claude-opus-5",
        thinkingOptionId: "high",
      },
      modeChosenByUser: false,
      modelChosenByUser: true,
      thinkingChosenByUser: false,
      availableModels: null,
      updatePreferences: async (update) => {
        store = typeof update === "function" ? update(store) : { ...store, ...update };
        return store;
      },
    });
    expect(store.providerPreferences?.claude?.thinkingByModel).toBeUndefined();
    expect(store.providerPreferences?.claude?.thinkingChosenByModel).toBeUndefined();
    // The model the user did pick is still recorded.
    expect(store.providerPreferences?.claude?.model).toBe("claude-opus-5");
  });

  it("records an effort the user picked, marked against that model", async () => {
    let store: FormPreferences = {};
    await persistProviderPreferences({
      provider: "claude",
      formState: {
        provider: "claude",
        modeId: "auto",
        model: "claude-opus-5",
        thinkingOptionId: "medium",
      },
      modeChosenByUser: false,
      modelChosenByUser: false,
      thinkingChosenByUser: true,
      availableModels: null,
      updatePreferences: async (update) => {
        store = typeof update === "function" ? update(store) : { ...store, ...update };
        return store;
      },
    });
    // Keyed by the model, and marked against it, so it is honoured for that model and no other.
    expect(store.providerPreferences?.claude?.thinkingByModel).toEqual({
      "claude-opus-5": "medium",
    });
    expect(store.providerPreferences?.claude?.thinkingChosenByModel).toEqual({
      "claude-opus-5": true,
    });
    // And the model itself is still not recorded: the user chose an effort, not a model.
    expect(store.providerPreferences?.claude?.model).toBeUndefined();
  });
});
