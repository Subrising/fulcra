import type {
  AgentMode,
  AgentModelDefinition,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { openScheduleForm, type ScheduleFormModel } from "./schedule-form-model";
import { buildProjectOptionId, type ScheduleProjectTarget } from "./schedule-project-targets";
import { updateSelectionPreferences } from "./selection-preferences";

// The schedule form writes the SAME providerPreferences.<provider>.mode key the new-session form
// reads, so the ratchet ran here too: a mode the form merely resolved was saved as user intent on
// every submit. These drive the real schedule form model into the real persist path, so the mapping
// from "the user picked it" to "it is written" is covered rather than assumed.

const HOSTS = [
  { serverId: "host-a", label: "Host A", supportsWorkspaceMultiplicity: true },
] as const;
const MODES: AgentMode[] = [
  { id: "load-test", label: "Load test" },
  { id: "approval-test", label: "Approval test" },
];
const MODELS: AgentModelDefinition[] = [
  { provider: "mock", id: "model-a", label: "Model A", isDefault: true },
];
const PROJECT_TARGETS: ScheduleProjectTarget[] = [
  {
    optionId: buildProjectOptionId("host-a", "project-a"),
    serverId: "host-a",
    serverName: "Host A",
    projectViewKey: "project-a",
    projectName: "Project A",
    cwd: "/repo/a",
    isGit: true,
  },
];

const providerSnapshot = (): { entries: ProviderSnapshotEntry[] } => ({
  entries: [
    {
      provider: "mock",
      label: "Mock",
      status: "ready",
      enabled: true,
      fetchedAt: "2026-07-01T00:00:00.000Z",
      models: MODELS,
      modes: MODES,
      defaultModeId: "load-test",
    },
  ],
});

// Opens a create form, selects the project, and lets the provider snapshot resolve a mode -- the
// state a user reaches by opening the sheet and touching nothing about the mode.
function openResolved(preferences: FormPreferences = {}): ScheduleFormModel {
  const form = openScheduleForm({
    mode: "create",
    hosts: HOSTS,
    defaults: { serverId: "host-a", projectTargets: PROJECT_TARGETS, preferences },
  });
  form.setProject(PROJECT_TARGETS[0].optionId, { label: "Project A" });
  form.applyProviderSnapshot("host-a", providerSnapshot());
  // Choosing a model selects the provider, and the model resolves a mode for it -- the
  // pickModeForProvider path. The user picked a model; nobody picked a mode.
  form.setModel("mock", "model-a");
  return form;
}

// Exactly what schedule-form-sheet.tsx does on submit.
const persist = (form: ScheduleFormModel, saved: FormPreferences): FormPreferences => {
  const state = form.getState();
  return updateSelectionPreferences({
    preferences: saved,
    provider: state.selectedProvider ?? "mock",
    model: state.selectedModel,
    mode: state.selectedMode,
    modeChosenByUser: form.getModeChosenByUser(),
    modelChosenByUser: form.getModelChosenByUser(),
    thinkingChosenByUser: form.getThinkingChosenByUser(),
    thinkingOptionId: state.selectedThinkingOptionId,
    isolation: state.isolation,
  });
};

describe("schedule form -> providerPreferences", () => {
  it("does not write a mode the form merely resolved", () => {
    const form = openResolved();
    expect(form.getState().selectedMode).toBe("load-test");
    expect(form.getModeChosenByUser()).toBe(false);
    const after = persist(form, {});
    expect(after.providerPreferences?.mock?.mode).toBeUndefined();
    form.close();
  });

  it("does not overwrite an earlier explicit choice with a resolved mode", () => {
    // The ratchet itself: a saved choice replaced by whatever this sheet happened to resolve.
    const saved: FormPreferences = { providerPreferences: { mock: { mode: "approval-test" } } };
    const form = openResolved(saved);
    expect(form.getModeChosenByUser()).toBe(false);
    expect(persist(form, saved).providerPreferences?.mock?.mode).toBe("approval-test");
    form.close();
  });

  it("writes a mode the user actually picked", () => {
    const form = openResolved();
    form.setSessionMode("approval-test");
    expect(form.getModeChosenByUser()).toBe(true);
    expect(persist(form, {}).providerPreferences?.mock?.mode).toBe("approval-test");
    form.close();
  });

  // The model half of the same ratchet: the form resolves a model from the host's default, and writing
  // that back made it outrank the host's default on every later session -- including new chats, which
  // read this same key.
  it("does not write a model the form merely resolved", () => {
    // Deliberately NOT openResolved(), which picks a model: this is a form that only ever resolved one
    // from the snapshot, which is the state every schedule starts in.
    const form = openScheduleForm({
      mode: "create",
      hosts: HOSTS,
      defaults: { serverId: "host-a", projectTargets: PROJECT_TARGETS, preferences: {} },
    });
    form.setProject(PROJECT_TARGETS[0].optionId, { label: "Project A" });
    form.applyProviderSnapshot("host-a", providerSnapshot());
    expect(form.getModelChosenByUser()).toBe(false);
    expect(persist(form, {}).providerPreferences?.mock?.model).toBeUndefined();
    form.close();
  });

  it("writes a model the user picked, marked as chosen", () => {
    const form = openResolved();
    expect(form.getModelChosenByUser()).toBe(true);
    const after = persist(form, {});
    expect(after.providerPreferences?.mock?.model).toBe("model-a");
    expect(after.providerPreferences?.mock?.modelChosenByUser).toBe(true);
    form.close();
  });
});
