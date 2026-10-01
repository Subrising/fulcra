import { describe, expect, it } from "vitest";
import {
  resolveAgentForm,
  resolveFormState,
  resolveFormStateFromProviderModels,
  resolveEffectiveModel,
  resolveThinkingOptionId,
  mergeSelectedComposerPreferences,
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  resolveDefaultModel,
  INITIAL_USER_MODIFIED,
  PENDING_AGENT_FORM_RESOLUTION,
  type AgentFormReducerState,
  type AgentFormResolutionState,
  type ProviderModelsByProvider,
  type UserModifiedFields,
} from "./resolve-agent-form";
import { mergeRoleInitialValues, roleInitialValues } from "./role-defaults";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import {
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
} from "./provider-selection";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";

const TEST_CODEX_DEFINITION: AgentProviderDefinition = {
  id: "codex",
  label: "Codex",
  description: "Codex test provider",
  defaultModeId: "auto",
  modes: [
    { id: "auto", label: "Auto", icon: "ShieldAlert", colorTier: "moderate" },
    { id: "full-access", label: "Full Access", icon: "ShieldAlert", colorTier: "dangerous" },
  ],
};

const TEST_CLAUDE_DEFINITION: AgentProviderDefinition = {
  id: "claude",
  label: "Claude",
  description: "Claude test provider",
  defaultModeId: "default",
  modes: [
    { id: "default", label: "Always Ask", icon: "ShieldCheck", colorTier: "safe" },
    { id: "acceptEdits", label: "Accept File Edits", icon: "ShieldAlert", colorTier: "moderate" },
    { id: "plan", label: "Plan Mode", icon: "ShieldCheck", colorTier: "planning" },
    { id: "bypassPermissions", label: "Bypass", icon: "ShieldAlert", colorTier: "dangerous" },
  ],
};

const TEST_PI_DEFINITION: AgentProviderDefinition = {
  id: "pi",
  label: "Pi",
  description: "Pi test provider",
  defaultModeId: null,
  modes: [],
};

const CODEX_MODELS: AgentModelDefinition[] = [
  {
    provider: "codex",
    id: "gpt-5.3-codex",
    label: "gpt-5.3-codex",
    isDefault: true,
    defaultThinkingOptionId: "xhigh",
    thinkingOptions: [
      { id: "low", label: "low" },
      { id: "xhigh", label: "xhigh", isDefault: true },
    ],
  },
];

const ALIASED_CODEX_MODELS: AgentModelDefinition[] = [
  { ...CODEX_MODELS[0], aliases: ["gpt-5.3-codex-legacy"] },
];

function makeProviderMap(
  ...definitions: AgentProviderDefinition[]
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map(definitions.map((d) => [d.id, d]));
}

const codexProviderMap = makeProviderMap(TEST_CODEX_DEFINITION);
const claudeProviderMap = makeProviderMap(TEST_CLAUDE_DEFINITION);
const bothProviderMap = makeProviderMap(TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION);

function makeState(
  overrides: Partial<AgentFormReducerState["form"]> = {},
  modified: Partial<UserModifiedFields> = {},
  resolution: AgentFormResolutionState = PENDING_AGENT_FORM_RESOLUTION,
): AgentFormReducerState {
  return {
    form: {
      provider: null,
      modeId: "",
      model: "",
      thinkingOptionId: "",

      ...overrides,
    },
    userModified: { ...INITIAL_USER_MODIFIED, ...modified },
    resolution,
  };
}

function makeProviderModelsByProvider(
  entries: Array<[AgentProvider, AgentModelDefinition[] | null]>,
): ProviderModelsByProvider {
  return new Map(entries);
}

describe("resolveDefaultModel", () => {
  it("returns null for empty or null input", () => {
    expect(resolveDefaultModel(null)).toBeNull();
    expect(resolveDefaultModel([])).toBeNull();
  });

  it("returns the model marked isDefault", () => {
    const models: AgentModelDefinition[] = [
      { provider: "codex", id: "a", label: "A", isDefault: false },
      { provider: "codex", id: "b", label: "B", isDefault: true },
    ];
    expect(resolveDefaultModel(models)?.id).toBe("b");
  });

  it("falls back to the first model when none is marked default", () => {
    const models: AgentModelDefinition[] = [
      { provider: "codex", id: "a", label: "A", isDefault: false },
      { provider: "codex", id: "b", label: "B", isDefault: false },
    ];
    expect(resolveDefaultModel(models)?.id).toBe("a");
  });
});

describe("model aliases", () => {
  it("canonicalizes a retired preferred model and restores thinking from its alias key", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex-legacy",
            modelChosenByUser: true,
            thinkingByModel: { "gpt-5.3-codex-legacy": "low" },
            thinkingChosenByModel: { "gpt-5.3-codex-legacy": true },
          },
        },
      },
      ALIASED_CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("prefers thinking stored under the canonical model id over an alias", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex-legacy",
            modelChosenByUser: true,
            thinkingByModel: {
              "gpt-5.3-codex": "xhigh",
              "gpt-5.3-codex-legacy": "low",
            },
            thinkingChosenByModel: { "gpt-5.3-codex": true, "gpt-5.3-codex-legacy": true },
          },
        },
      },
      ALIASED_CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("prefers an exact configured model id over another model's alias", () => {
    const configuredAlias: AgentModelDefinition = {
      provider: "codex",
      id: "gpt-5.3-codex-legacy",
      label: "Gateway legacy model",
      defaultThinkingOptionId: "medium",
      thinkingOptions: [{ id: "medium", label: "medium", isDefault: true }],
    };
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { model: configuredAlias.id, modelChosenByUser: true } },
      },
      [...ALIASED_CODEX_MODELS, configuredAlias],
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex-legacy");
    expect(resolved.thinkingOptionId).toBe("medium");
  });
});

describe("resolveThinkingOptionId", () => {
  it("returns empty string when model has no thinking options", () => {
    const modelsWithoutThinking: AgentModelDefinition[] = [
      { provider: "claude", id: "claude-sonnet-4-6", label: "Sonnet 4.6", isDefault: true },
    ];
    expect(
      resolveThinkingOptionId({
        availableModels: modelsWithoutThinking,
        modelId: "claude-sonnet-4-6",
        requestedThinkingOptionId: "",
      }),
    ).toBe("");
  });

  it("returns the requested option when it is valid", () => {
    expect(
      resolveThinkingOptionId({
        availableModels: CODEX_MODELS,
        modelId: "gpt-5.3-codex",
        requestedThinkingOptionId: "low",
      }),
    ).toBe("low");
  });

  it("falls back to defaultThinkingOptionId when requested option is invalid", () => {
    expect(
      resolveThinkingOptionId({
        availableModels: CODEX_MODELS,
        modelId: "gpt-5.3-codex",
        requestedThinkingOptionId: "invalid",
      }),
    ).toBe("xhigh");
  });

  it("falls back to first option when no default and requested is invalid", () => {
    const modelsNoDefault: AgentModelDefinition[] = [
      {
        provider: "codex",
        id: "m",
        label: "M",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ];
    expect(
      resolveThinkingOptionId({
        availableModels: modelsNoDefault,
        modelId: "m",
        requestedThinkingOptionId: "",
      }),
    ).toBe("low");
  });
});

describe("mergeSelectedComposerPreferences", () => {
  it("stores the selected model for the selected provider", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {},
        provider: "codex",
        updates: { model: "gpt-5.4", modelChosenByUser: true },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: { codex: { model: "gpt-5.4", modelChosenByUser: true } },
    });
  });

  it("preserves existing provider preferences when the selected model changes", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            codex: {
              mode: "full-access",
              thinkingByModel: { "gpt-5.4-mini": "medium" },
              featureValues: { fast_mode: true },
            },
            claude: { model: "claude-sonnet-4-6", modelChosenByUser: true },
          },
        },
        provider: "codex",
        updates: { model: "gpt-5.4", modelChosenByUser: true },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          modelChosenByUser: true,
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "medium" },
          featureValues: { fast_mode: true },
        },
        claude: { model: "claude-sonnet-4-6", modelChosenByUser: true },
      },
    });
  });

  it("stores mode and thinking preferences without dropping the selected model", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4",
              modelChosenByUser: true,
              mode: "auto",
              thinkingByModel: { "gpt-5.4-mini": "low" },
            },
          },
        },
        provider: "codex",
        updates: {
          mode: "full-access",
          thinkingByModel: { "gpt-5.4": "xhigh" },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          modelChosenByUser: true,
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "low", "gpt-5.4": "xhigh" },
        },
      },
    });
  });
});

describe("buildProviderDefinitions", () => {
  it("returns empty array when snapshot data is unavailable", () => {
    expect(buildProviderDefinitions(undefined)).toEqual([]);
    expect(buildProviderDefinitions([])).toEqual([]);
  });

  it("builds provider definitions from snapshot metadata", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "zai",
        status: "ready",
        enabled: true,
        label: "ZAI",
        description: "Claude with ZAI config",
        defaultModeId: "default",
        modes: [
          {
            id: "default",
            label: "Default",
            description: "Safe mode",
            icon: "ShieldCheck",
            colorTier: "safe",
          },
        ],
      },
    ];

    expect(buildProviderDefinitions(entries)).toEqual([
      {
        id: "zai",
        label: "ZAI",
        description: "Claude with ZAI config",
        defaultModeId: "default",
        modes: [
          {
            id: "default",
            label: "Default",
            description: "Safe mode",
            icon: "ShieldCheck",
            colorTier: "safe",
          },
        ],
      },
    ]);
  });
});

// J6: a fresh draft starts on the host's own defaults instead of "Select model". Everything below comes from
// the host's provider snapshot; nothing names a provider, model, mode or effort in the app.
const J6_CLAUDE_MODELS: AgentModelDefinition[] = [
  {
    provider: "claude",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    isDefault: true,
    defaultThinkingOptionId: "medium",
    thinkingOptions: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
    ],
  },
  {
    provider: "claude",
    id: "claude-opus-5",
    label: "Opus 5",
    defaultThinkingOptionId: "high",
    thinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High", isDefault: true },
    ],
  },
];
const J6_CODEX_MODELS: AgentModelDefinition[] = [
  { ...CODEX_MODELS[0]!, id: "gpt-5.5", label: "GPT-5.5" },
];

function j6HostEntry(provider: "claude" | "codex"): ProviderSnapshotEntry {
  return provider === "claude"
    ? {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: "Claude",
        defaultModeId: "auto",
        modes: [
          { id: "default", label: "Always Ask", icon: "ShieldCheck", colorTier: "safe" },
          { id: "auto", label: "Auto", icon: "ShieldAlert", colorTier: "moderate" },
        ],
        models: J6_CLAUDE_MODELS,
      }
    : {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: "Codex",
        defaultModeId: "auto-review",
        modes: [
          { id: "auto-review", label: "Auto Review", icon: "ShieldCheck", colorTier: "safe" },
          { id: "full-access", label: "Full Access", icon: "ShieldAlert", colorTier: "dangerous" },
        ],
        models: J6_CODEX_MODELS,
      };
}

function j6Resolve(input: {
  hostOrder: ("claude" | "codex")[];
  preferences?: FormPreferences;
  initialValues?: { provider: AgentProvider };
}) {
  const entries = input.hostOrder.map(j6HostEntry);
  const allowedProviderMap = buildProviderDefinitionMapForStatuses({
    snapshotEntries: entries,
    providerDefinitions: buildProviderDefinitions(entries),
    statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
  });
  const providerModels: ProviderModelsByProvider = new Map(
    entries.map((entry) => [entry.provider, entry.models ?? null]),
  );
  const form = resolveFormStateFromProviderModels(
    input.initialValues,
    input.preferences ?? {},
    providerModels,
    INITIAL_USER_MODIFIED,
    makeState().form,
    allowedProviderMap,
  );
  // What the composer shows and submits for this form (see provider-selection.ts).
  const selection = {
    provider: form.provider,
    modelId: form.model,
    modeId: form.modeId,
    thinkingOptionId: form.thinkingOptionId,
    availableModels: (form.provider ? providerModels.get(form.provider) : null) ?? [],
    modeOptions: [],
  };
  const effectiveModelId = resolveEffectiveComposerModelId(selection);
  return {
    form,
    effectiveModelId,
    effectiveThinkingOptionId: resolveEffectiveComposerThinkingOptionId(
      selection,
      effectiveModelId,
    ),
  };
}

describe("J6: fresh draft defaults", () => {
  it("a fresh draft starts on the host's first provider with its default model, mode and effort", () => {
    const { form, effectiveModelId, effectiveThinkingOptionId } = j6Resolve({
      hostOrder: ["claude", "codex"],
    });

    expect(form.provider).toBe("claude");
    expect(form.modeId).toBe("auto");
    expect(effectiveModelId).toBe("claude-opus-5-5");
    expect(effectiveThinkingOptionId).toBe("medium");
    // Still unpinned: an empty model follows the host's default, then and later.
    expect(form.model).toBe("");
  });

  it("follows the host's provider order rather than a provider named in the app", () => {
    const { form, effectiveModelId } = j6Resolve({ hostOrder: ["codex", "claude"] });

    expect(form.provider).toBe("codex");
    expect(form.modeId).toBe("auto-review");
    expect(effectiveModelId).toBe("gpt-5.5");
  });

  it("a remembered provider still wins over the host's first provider", () => {
    const { form, effectiveModelId } = j6Resolve({
      hostOrder: ["claude", "codex"],
      preferences: { provider: "codex" },
    });

    expect(form.provider).toBe("codex");
    expect(form.modeId).toBe("auto-review");
    expect(effectiveModelId).toBe("gpt-5.5");
  });

  it("an explicit provider still wins over the host's first provider", () => {
    const { form } = j6Resolve({
      hostOrder: ["claude", "codex"],
      initialValues: { provider: "codex" },
    });

    expect(form.provider).toBe("codex");
  });

  it("a remembered model choice still wins over the host's default model and its effort", () => {
    const { form, effectiveModelId, effectiveThinkingOptionId } = j6Resolve({
      hostOrder: ["claude", "codex"],
      preferences: {
        providerPreferences: { claude: { model: "claude-opus-5", modelChosenByUser: true } },
      },
    });

    expect(form.provider).toBe("claude");
    expect(effectiveModelId).toBe("claude-opus-5");
    expect(effectiveThinkingOptionId).toBe("high");
  });

  it("keeps a draft unset when the host offers no usable provider", () => {
    const resolved = resolveFormState(
      undefined,
      {},
      null,
      INITIAL_USER_MODIFIED,
      makeState().form,
      new Map(),
    );

    expect(resolved.provider).toBeNull();
    expect(resolved.modeId).toBe("");
    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
  });
});

describe("resolveFormState", () => {
  it("does not auto-select a model on fresh drafts without preferences", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
  });

  it("auto-selects the model's default thinking option when model is preferred but thinking is not", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
      },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("falls back to model default when saved thinking preference is invalid", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
      },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("normalizes legacy model id 'default' from initial values to the provider default model", () => {
    const resolved = resolveFormState(
      { model: "default" },
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it("keeps an explicit initial thinking option when it is valid", () => {
    const resolved = resolveFormState(
      { model: "gpt-5.3-codex", thinkingOptionId: "low" },
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("falls back to the first thinking option when model exposes options without a provider default", () => {
    const claudeWithThinking: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "default",
        label: "Default (Sonnet 4.6)",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
      },
    ];

    const resolved = resolveFormState(
      undefined,
      {
        provider: "claude",
        providerPreferences: { claude: { model: "default", modelChosenByUser: true } },
      },
      claudeWithThinking,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,

      claudeProviderMap,
    );

    expect(resolved.model).toBe("default");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("preserves the remembered provider when it is absent from the available catalogue", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      claudeProviderMap,
    );

    expect(resolved.provider).toBe("codex");
  });

  it("preserves a user-selected provider and model while that provider is loading during refresh", () => {
    const loadingEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "loading",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
        models: [{ provider: "claude", id: "default", label: "Default", isDefault: true }],
      },
    ];
    const providerDefinitions = buildProviderDefinitions(loadingEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: loadingEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {},
      null,
      {
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
      },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("preserves the saved mode while provider modes are absent from a loading snapshot", () => {
    const loadingEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "loading",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(loadingEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: loadingEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            mode: "full-access",
            modeChosenByUser: true,
            model: "gpt-5.3-codex",
            modelChosenByUser: true,
          },
        },
      },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
  });

  it("preserves a saved mode that is not in the current mode list", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            mode: "workspace-write",
            modeChosenByUser: true,
            model: "gpt-5.3-codex",
            modelChosenByUser: true,
          },
        },
      },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("workspace-write");
  });

  it("falls back when the provider cannot advertise its preferred default mode", () => {
    const providerMap = makeProviderMap({
      ...TEST_CODEX_DEFINITION,
      defaultModeId: "auto-review",
      modes: TEST_CODEX_DEFINITION.modes,
    });

    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,
      providerMap,
    );

    expect(resolved.modeId).toBe("auto");
  });

  it("preserves saved intent even when a provider is disabled", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: false,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(entries);
    const selectableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: entries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
    });

    const resolved = resolveFormState(
      undefined,
      { provider: "claude" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      selectableProviderMap,
    );

    expect(resolved.provider).toBe("claude");
    expect(resolved.modeId).toBe("");
  });

  it("excludes disabled providers from the selectable provider map without removing them from snapshot definitions", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: false,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(entries);

    const selectableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: entries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
    });

    expect([...selectableProviderMap.keys()]).toEqual(["codex"]);
    expect(providerDefinitions.map((d) => d.id)).toEqual(["codex", "claude"]);
  });

  it("preserves a user-selected provider when the refreshed snapshot marks it unavailable", () => {
    const unavailableEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "unavailable",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
        models: [{ provider: "claude", id: "default", label: "Default", isDefault: true }],
      },
    ];
    const providerDefinitions = buildProviderDefinitions(unavailableEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: unavailableEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {},
      null,
      {
        ...INITIAL_USER_MODIFIED,
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
      },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("does not force fallback provider when allowed provider map is empty", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      new Map<AgentProvider, AgentProviderDefinition>(),
    );

    expect(resolved.provider).toBe("codex");
  });
});

it("keeps the explicit model when a refreshed catalogue no longer lists it", () => {
  const resolved = resolveFormState(
    undefined,
    {
      provider: "codex",
      providerPreferences: { codex: { model: "gpt-6-astra", modelChosenByUser: true } },
    },
    CODEX_MODELS,
    INITIAL_USER_MODIFIED,
    makeState().form,
    codexProviderMap,
  );
  expect(resolved.model).toBe("gpt-6-astra");
  // Label/persistence lookup must not reinterpret the submitted ID as another model.
  expect(resolveEffectiveModel(CODEX_MODELS, resolved.model)).toBeNull();
});

describe("resolveAgentForm", () => {
  describe("resolution state", () => {
    it.each(["error", "unavailable"] as const)(
      "restores a remembered model after opening against a %s provider snapshot",
      (status) => {
        const preferences: FormPreferences = {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
        };
        const snapshotEntries: ProviderSnapshotEntry[] = [
          {
            provider: "codex",
            enabled: true,
            status,
            models: [],
          },
        ];
        const opened = resolveAgentForm(makeState(), {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", []]]),
          allowedProviderMap: buildProviderDefinitionMapForStatuses({
            snapshotEntries,
            providerDefinitions: buildProviderDefinitions(snapshotEntries),
            statuses: new Set(["ready", "loading"]),
          }),
        });
        const recovered = resolveAgentForm(opened, {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
          allowedProviderMap: codexProviderMap,
        });

        expect(recovered.form).toMatchObject({
          provider: "codex",
          model: "gpt-5.3-codex",
        });
      },
    );

    it("requests resolution without changing the current form values", () => {
      const state = makeState(
        { provider: "codex", modeId: "auto", model: "gpt-5.3-codex" },
        { provider: true, model: true },
        { status: "completed" },
      );
      const next = resolveAgentForm(state, { type: "REQUEST_RESOLUTION" });

      expect(next.form).toEqual(state.form);
      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.resolution.status).toBe("pending");
    });

    it("completes a pending open resolution when snapshot models arrive late", () => {
      const state = resolveAgentForm(makeState(), {
        type: "REQUEST_RESOLUTION",
      });
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("auto");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("xhigh");
      expect(next.resolution.status).toBe("completed");
    });

    it("does not change settled selection when a background snapshot has different defaults", () => {
      const settled = resolveAgentForm(makeState(), {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });
      const backgroundModels: AgentModelDefinition[] = [
        { provider: "codex", id: "gpt-5.4-codex", label: "gpt-5.4-codex", isDefault: true },
      ];
      const next = resolveAgentForm(settled, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.4-codex", modelChosenByUser: true } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", backgroundModels]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(settled);
      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("prefills edit hydration from initial values", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: {
          provider: "codex",
          modeId: "full-access",
          model: "gpt-5.3-codex",
          thinkingOptionId: "low",
        },
        preferences: { provider: "claude" },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("full-access");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("role defaults outrank a remembered, chosen model and effort; explicit setup values outrank the role", () => {
      const models: AgentModelDefinition[] = [
        { ...CODEX_MODELS[0], isDefault: false },
        {
          provider: "codex",
          id: "gpt-5.4-codex",
          label: "gpt-5.4-codex",
          isDefault: true,
          thinkingOptions: [
            { id: "low", label: "low" },
            { id: "high", label: "high", isDefault: true },
          ],
        },
      ];
      const remembered: FormPreferences = {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex",
            modelChosenByUser: true,
            thinkingByModel: { "gpt-5.3-codex": "low", "gpt-5.4-codex": "low" },
            thinkingChosenByModel: { "gpt-5.3-codex": true, "gpt-5.4-codex": true },
          },
        },
      };
      const table = {
        roles: {
          implementation: {
            provider: "codex",
            providers: {
              codex: {
                status: "offered" as const,
                configured: { model: "gpt-5.4-codex", thinkingOptionId: "high" },
                effective: { model: "gpt-5.4-codex", thinkingOptionId: "high" },
              },
            },
          },
        },
      };
      const role = roleInitialValues({ role: "implementation", table, provider: null });
      const resolve = (initialValues: Parameters<typeof mergeRoleInitialValues>[0]) =>
        resolveAgentForm(makeState(), {
          type: "COMPLETE_RESOLUTION",
          initialValues: mergeRoleInitialValues(initialValues, role),
          preferences: remembered,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", models]]),
          allowedProviderMap: bothProviderMap,
        }).form;

      expect(resolve(undefined)).toMatchObject({
        provider: "codex",
        model: "gpt-5.4-codex",
        thinkingOptionId: "high",
      });
      expect(resolve({ model: "gpt-5.3-codex", thinkingOptionId: "xhigh" })).toMatchObject({
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      });
      // No role: the remembered choice, exactly as before.
      expect(
        resolveAgentForm(makeState(), {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences: remembered,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", models]]),
          allowedProviderMap: bothProviderMap,
        }).form,
      ).toMatchObject({ model: "gpt-5.3-codex", thinkingOptionId: "low" });
    });

    it("keeps a user model change after resolution has completed", () => {
      const alternateModels: AgentModelDefinition[] = [
        ...CODEX_MODELS,
        { provider: "codex", id: "gpt-5.4-codex", label: "gpt-5.4-codex" },
      ];
      const settled = resolveAgentForm(makeState(), {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", alternateModels]]),
        allowedProviderMap: codexProviderMap,
      });
      const userChanged = resolveAgentForm(settled, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.4-codex",
        availableModels: alternateModels,
        providerPrefs: undefined,
      });
      const next = resolveAgentForm(userChanged, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex", modelChosenByUser: true } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(userChanged);
      expect(next.form.model).toBe("gpt-5.4-codex");
      expect(next.userModified.model).toBe(true);
    });

    it("does not override user-modified provider while completing", () => {
      const state = makeState({ provider: "codex", modeId: "auto" }, { provider: true });
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: { provider: "claude" },
        providerModelsByProvider: makeProviderModelsByProvider([]),
        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
    });
  });

  describe("SET_PROVIDER_AND_MODEL_FROM_USER", () => {
    it("sets provider, model, and default mode; marks both modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("auto");
      expect(next.userModified.provider).toBe(true);
      expect(next.userModified.model).toBe(true);
    });

    it("preserves the current preferred mode when selecting a provider and model", () => {
      const state = makeState({ provider: "codex", modeId: "full-access" });
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("full-access");
    });

    it("falls back to provider default model when modelId is empty", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("selects default thinking option for the chosen model", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
        providerPrefs: {
          thinkingByModel: { "gpt-5.3-codex": "low" },
          thinkingChosenByModel: { "gpt-5.3-codex": true },
        },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_MODE_FROM_USER", () => {
    it("updates modeId and marks it modified", () => {
      const state = makeState({ provider: "codex", modeId: "auto" });
      const next = resolveAgentForm(state, { type: "SET_MODE_FROM_USER", modeId: "full-access" });

      expect(next.form.modeId).toBe("full-access");
      expect(next.userModified.modeId).toBe(true);
    });
  });

  describe("APPLY_PROFILE_FROM_USER", () => {
    it("drops a stale saved mode for a modeless profile provider", () => {
      const next = resolveAgentForm(makeState({ provider: "codex", modeId: "full-access" }), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "pi",
        modelId: "anthropic/sonnet",
        modeId: "",
        thinkingOptionId: "",
        providerDef: TEST_PI_DEFINITION,
        providerModels: [{ provider: "pi", id: "anthropic/sonnet", label: "Sonnet" }],
        providerPrefs: { mode: "full-access", modeChosenByUser: true },
      });

      expect(next.form).toMatchObject({
        provider: "pi",
        model: "anthropic/sonnet",
        modeId: "",
      });
    });

    it("restores thinking for the selected model when the profile omits it", () => {
      const next = resolveAgentForm(makeState(), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        modeId: "full-access",
        thinkingOptionId: "",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
        providerPrefs: {
          thinkingByModel: { "gpt-5.3-codex": "low" },
          thinkingChosenByModel: { "gpt-5.3-codex": true },
        },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_MODEL_FROM_USER", () => {
    it("updates model and resets thinking to model default when thinking is not user-modified", () => {
      const state = makeState({ provider: "codex", model: "", thinkingOptionId: "" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
        providerPrefs: undefined,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("xhigh");
      expect(next.userModified.model).toBe(true);
    });

    it("preserves user-chosen thinking option when switching to same model", () => {
      const state = makeState(
        { provider: "codex", model: "gpt-5.3-codex", thinkingOptionId: "low" },
        { thinkingOptionId: true },
      );
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
        providerPrefs: {
          thinkingByModel: { "gpt-5.3-codex": "xhigh" },
          thinkingChosenByModel: { "gpt-5.3-codex": true },
        },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("falls back to provider default model when modelId is blank", () => {
      const state = makeState({ provider: "codex" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "  ",
        availableModels: CODEX_MODELS,
        providerPrefs: undefined,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("restores the target model's saved thinking option", () => {
      const models = [
        ...CODEX_MODELS,
        {
          provider: "codex" as const,
          id: "gpt-other",
          label: "Other",
          defaultThinkingOptionId: "xhigh",
          thinkingOptions: CODEX_MODELS[0].thinkingOptions,
        },
      ];
      const state = makeState({
        provider: "codex",
        model: "gpt-other",
        thinkingOptionId: "xhigh",
      });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: models,
        providerPrefs: {
          thinkingByModel: { "gpt-5.3-codex": "low" },
          thinkingChosenByModel: { "gpt-5.3-codex": true },
        },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_THINKING_OPTION_FROM_USER", () => {
    it("updates thinkingOptionId and marks it modified", () => {
      const state = makeState({ thinkingOptionId: "xhigh" });
      const next = resolveAgentForm(state, {
        type: "SET_THINKING_OPTION_FROM_USER",
        thinkingOptionId: "low",
      });

      expect(next.form.thinkingOptionId).toBe("low");
      expect(next.userModified.thinkingOptionId).toBe(true);
    });
  });

  describe("RESET", () => {
    it("keeps form values but marks them unresolved for the next open", () => {
      const state = makeState(
        { provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" },
        { provider: true, modeId: true, model: true },
        { status: "completed" },
      );
      const next = resolveAgentForm(state, { type: "RESET" });

      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.form).toEqual(state.form);
      expect(next.resolution.status).toBe("pending");
    });
  });

  describe("buildProviderDefinitionMap", () => {
    it("builds a map from provider id to definition", () => {
      const map = buildProviderDefinitionMap([TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION]);
      expect(map.get("codex")).toBe(TEST_CODEX_DEFINITION);
      expect(map.get("claude")).toBe(TEST_CLAUDE_DEFINITION);
    });
  });

  describe("buildProviderDefinitionMapForStatuses", () => {
    it("returns all definitions when no snapshot entries", () => {
      const map = buildProviderDefinitionMapForStatuses({
        snapshotEntries: undefined,
        providerDefinitions: [TEST_CODEX_DEFINITION],
        statuses: new Set(["ready"]),
      });
      expect([...map.keys()]).toEqual(["codex"]);
    });

    it("filters to only matching-status enabled providers", () => {
      const entries: ProviderSnapshotEntry[] = [
        {
          provider: "codex",
          status: "ready",
          enabled: true,
          label: "Codex",
          description: "",
          defaultModeId: "auto",
          modes: [],
        },
        {
          provider: "claude",
          status: "loading",
          enabled: true,
          label: "Claude",
          description: "",
          defaultModeId: "default",
          modes: [],
        },
      ];
      const map = buildProviderDefinitionMapForStatuses({
        snapshotEntries: entries,
        providerDefinitions: [TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION],
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
      });

      expect([...map.keys()]).toEqual(["codex"]);
    });
  });
});

it("owns input readiness, reopening and user edits in the reducer", () => {
  const inputs = {
    type: "INPUTS_CHANGED" as const,
    serverId: "host",
    isVisible: true,
    isCreateFlow: true,
    isPreferencesLoading: true,
    hasSnapshot: false,
    initialValues: undefined,
    preferences: {
      provider: "codex",
      providerPreferences: { codex: { model: "astra", modelChosenByUser: true as const } },
    },
    allowedProviderMap: new Map(),
    providerModelsByProvider: new Map(),
  };
  let state = resolveAgentForm(makeState(), inputs);
  expect(state.resolution.status).toBe("pending");
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form).toMatchObject({ provider: "codex", model: "astra" });
  state = resolveAgentForm(state, {
    type: "SET_MODEL_FROM_USER",
    modelId: "manual",
    availableModels: null,
    providerPrefs: undefined,
  });
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form.model).toBe("manual");
  state = resolveAgentForm(state, { ...inputs, isVisible: false });
  expect(state.resolution.status).toBe("pending");
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form).toMatchObject({ provider: "codex", model: "astra" });
});

// The defect, as the owner measured it: a new chat opened on the previous Opus release while the host
// advertised the current one as its default, and picking the newer model by hand did not stick. The
// profile held a model nobody had chosen -- every submit used to write the resolved model back -- and a
// saved model outranks the host's default by design. So the host could advertise whatever it liked and
// the app would never move.
describe("a saved model is only a preference when the user chose it", () => {
  const CLAUDE_MODELS: AgentModelDefinition[] = [
    { provider: "claude", id: "claude-opus-5", label: "Opus 5" },
    { provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true },
  ];

  it("ignores a model saved without the marker, so the host's default applies again", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "claude", providerPreferences: { claude: { model: "claude-opus-5" } } },
      CLAUDE_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,
      claudeProviderMap,
    );
    // Empty is the value that means "follow the host": the composer labels it with the default model and
    // submits no model, so the session takes whatever the host advertises at launch.
    expect(resolved.model).toBe("");
  });

  it("honours a model the user chose", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "claude",
        providerPreferences: { claude: { model: "claude-opus-5", modelChosenByUser: true } },
      },
      CLAUDE_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,
      claudeProviderMap,
    );
    expect(resolved.model).toBe("claude-opus-5");
  });

  it("still honours an unmarked model carried in initial values", () => {
    // Initial values describe THIS draft -- a duplicated session, a deep link -- not a stored profile, so
    // the marker does not apply to them and dropping them would break resuming a draft.
    const resolved = resolveFormState(
      { model: "claude-opus-5" },
      { provider: "claude", providerPreferences: { claude: { model: "claude-opus-5-5" } } },
      CLAUDE_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,
      claudeProviderMap,
    );
    expect(resolved.model).toBe("claude-opus-5");
  });
});

// The whole outcome on one profile, which is how the gap got through the first time: the model was fixed,
// tested and reported while the mode and the effort beside it were still stuck. This is the exact stale
// profile the brief named -- opus-5 / high / default, all written by a form that merely resolved them --
// and all three axes are asserted together so no future change can fix one and quietly leave two.
describe("a profile stuck on the old defaults returns to the host's, on every axis", () => {
  const CLAUDE_MODELS: AgentModelDefinition[] = [
    {
      provider: "claude",
      id: "claude-opus-5",
      label: "Opus 5",
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
    {
      provider: "claude",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      isDefault: true,
      // The manifest's own value for 5.5, which is the Medium the owner asked for.
      defaultThinkingOptionId: "medium",
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
  ];
  // The real adapter definition, not the suite's TEST_CLAUDE_DEFINITION, whose defaultModeId is "default".
  // Using the test double here would assert the wrong default and hide exactly this defect.
  const realClaudeDefinition = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === "claude");
  const realClaudeMap = buildProviderDefinitionMap(
    realClaudeDefinition ? [realClaudeDefinition] : [],
  );

  // What the composer displays and submits, which is where the model and the effort actually land: the
  // form leaves both empty when nothing was chosen, and these two resolve that emptiness against the
  // host's inventory. Asserting the form fields alone would prove nothing about what the user sees.
  const composed = (form: { model: string; modeId: string; thinkingOptionId: string }) => {
    const selection = {
      provider: "claude" as const,
      modelId: form.model,
      modeId: form.modeId,
      thinkingOptionId: form.thinkingOptionId,
      availableModels: CLAUDE_MODELS,
      modeOptions: realClaudeDefinition?.modes ?? [],
    };
    const modelId = resolveEffectiveComposerModelId(selection);
    return {
      modelId,
      thinkingOptionId: resolveEffectiveComposerThinkingOptionId(selection, modelId),
    };
  };

  const STALE: FormPreferences = {
    provider: "claude",
    providerPreferences: {
      claude: {
        model: "claude-opus-5",
        mode: "default",
        thinkingByModel: { "claude-opus-5": "high", "claude-opus-5-5": "high" },
      },
    },
  };

  it("opens Opus 5.5 / Medium / Auto, not Opus 5 / High / Always Ask", () => {
    const resolved = resolveFormState(
      undefined,
      STALE,
      CLAUDE_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,
      realClaudeMap,
    );
    // "" is the follow-the-host value for both: nothing was chosen, so nothing is submitted.
    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
    // Auto, from the adapter's own defaultModeId, because the saved "default" carries no mark.
    expect(resolved.modeId).toBe("auto");
    // And what the user sees and sends: the host's default model, at that model's own default effort.
    expect(composed(resolved)).toEqual({
      modelId: "claude-opus-5-5",
      thinkingOptionId: "medium",
    });
  });

  it("still honours every one of them when the user did choose it", () => {
    const chosen: FormPreferences = {
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-opus-5",
          modelChosenByUser: true,
          mode: "default",
          modeChosenByUser: true,
          thinkingByModel: { "claude-opus-5": "high" },
          thinkingChosenByModel: { "claude-opus-5": true },
        },
      },
    };
    const resolved = resolveFormState(
      undefined,
      chosen,
      CLAUDE_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,
      realClaudeMap,
    );
    expect(resolved.model).toBe("claude-opus-5");
    expect(resolved.modeId).toBe("default");
    expect(resolved.thinkingOptionId).toBe("high");
  });

  it("marks each axis independently", () => {
    // A user who picked only the mode keeps the mode and follows the host for the rest. Asserted because
    // a marker implemented as one flag for the whole record would pass the two tests above and fail here.
    const modeOnly: FormPreferences = {
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-opus-5",
          mode: "plan",
          modeChosenByUser: true,
          thinkingByModel: { "claude-opus-5": "high" },
        },
      },
    };
    const resolved = resolveFormState(
      undefined,
      modeOnly,
      CLAUDE_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,
      realClaudeMap,
    );
    expect(resolved.modeId).toBe("plan");
    expect(resolved.model).toBe("");
    expect(composed(resolved)).toEqual({
      modelId: "claude-opus-5-5",
      thinkingOptionId: "medium",
    });
  });
});
