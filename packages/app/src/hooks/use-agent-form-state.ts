<<<<<<< HEAD
import { resolveDraftEffort } from "@/composer/agent-controls/draft-effort";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
=======
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
>>>>>>> refs/remotes/upstream/tags/v0.17.5
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderOptions,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { OptimisticFormPreferences } from "@/create-agent-preferences/optimistic-preferences";
import { applyAgentProfilePreferences } from "@/create-agent-preferences/preferences";
import { useProvidersSnapshot } from "./use-providers-snapshot";
import {
  useFormPreferences,
  mergeProviderPreferences,
  type FormPreferences,
} from "./use-form-preferences";
import {
  resolveAgentForm,
  resolveEffectiveModel,
  normalizeSelectedModelId,
  resolveDefaultModelId,
  mergeSelectedComposerPreferences,
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  RESOLVABLE_PROVIDER_STATUSES,
  SELECTABLE_PROVIDER_STATUSES,
  type FormInitialValues,
  type FormState,
  type ProviderModelsByProvider,
} from "@/provider-selection/resolve-agent-form";
import { openAgentForm, type AgentFormCatalog } from "@/provider-selection/agent-form-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { MaterializedAgentProfile } from "@/agent-profiles";

export type { FormInitialValues } from "@/provider-selection/resolve-agent-form";

export interface UseAgentFormStateOptions {
  serverId: string | null;
  workingDir: string;
  initialValues?: FormInitialValues;
  isVisible?: boolean;
  isCreateFlow?: boolean;
}

export interface UseAgentFormStateResult {
  selectedServerId: string | null;
  selectedProvider: AgentProvider | null;
  /** The provider as it is now, which a render may not have reached yet. */
  getSelectedProvider: () => AgentProvider | null;
  selectedMode: string;
  setModeFromUser: (modeId: string) => void;
  selectedModel: string;
  setModelFromUser: (modelId: string) => void;
  selectedThinkingOptionId: string;
  setThinkingOptionFromUser: (thinkingOptionId: string, retainedOptions?: ProviderOptions) => void;
  workingDir: string;
  providerDefinitions: AgentProviderDefinition[];
  providerDefinitionMap: Map<AgentProvider, AgentProviderDefinition>;
  agentDefinition?: AgentProviderDefinition;
  allProviderEntries?: ProviderSnapshotEntry[];
  modeOptions: AgentMode[];
  availableModels: AgentModelDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  isProviderModelsRefreshing: boolean;
  availableThinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  isModelLoading: boolean;
  modelError: string | null;
  refreshProviderModels: (provider?: AgentProvider) => void;
  refetchProviderModelsIfStale: () => void;
  /** `false` when the provider is unknown or not ready. */
  setProviderAndModelFromUser: (provider: AgentProvider, modelId: string) => boolean;
  applyProfileFromUser: (profile: MaterializedAgentProfile) => void;
  clearProviderSelectionFromUser: () => void;
  workingDirIsEmpty: boolean;
  persistFormPreferences: () => Promise<void>;
}

const EMPTY_CATALOG: AgentFormCatalog = {
  selectableProviders: new Map(),
  models: new Map(),
  providerPreferences: () => undefined,
};

function resolveSelectedProviderModes(input: {
  selectedEntry: ProviderSnapshotEntry | null;
  provider: AgentProvider | null;
  providerDefinitionMap: Map<AgentProvider, AgentProviderDefinition>;
}): AgentMode[] {
  const { selectedEntry, provider, providerDefinitionMap } = input;
  if (selectedEntry?.modes) {
    return selectedEntry.modes;
  }
  if (provider) {
    return providerDefinitionMap.get(provider)?.modes ?? [];
  }
  return [];
}

function buildAllProviderModels(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  for (const entry of snapshotEntries ?? []) {
    map.set(entry.provider, filterSelectableModels(entry.models ?? []) ?? []);
  }
  return map;
}

function buildProviderModelsByProvider(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): ProviderModelsByProvider {
  const map: ProviderModelsByProvider = new Map();
  for (const entry of snapshotEntries ?? []) {
    map.set(
      entry.provider,
      entry.status === "ready" ? filterSelectableModels(entry.models ?? null) : null,
    );
  }
  return map;
}

export async function persistProviderPreferences(input: {
  provider: AgentProvider;
  formState: FormState;
  // Only a mode the user picked is a preference. A mode the form merely resolved -- from a provider
  // default, a voice default, or a previously saved value -- must not be written back as if it were
  // chosen: doing so ratchets any transient mode (e.g. "default"/ask) into permanent "user intent"
  // that then outranks the provider's own default on every future session.
  modeChosenByUser: boolean;
  // Same rule as the mode, for the same reason and one release later. A model the form merely resolved --
  // from the host's advertised default, from a profile, from the previously saved value -- was still being
  // written back as if chosen, so the first session that came up on an older model pinned it into the
  // profile and it then outranked the host's default forever. Only a model the user picked is a preference.
  modelChosenByUser: boolean;
  // And the effort, for the same reason: an effort the form resolved -- the model's own default, or a
  // value stored before the app told chosen from resolved -- is not a preference. It is keyed by model id,
  // so it is marked per model too.
  thinkingChosenByUser: boolean;
  availableModels: AgentModelDefinition[] | null;
  updatePreferences: (
    updates: Partial<FormPreferences> | ((current: FormPreferences) => FormPreferences),
  ) => Promise<FormPreferences>;
}): Promise<void> {
  const {
    provider,
    formState,
    modeChosenByUser,
    modelChosenByUser,
    thinkingChosenByUser,
    availableModels,
    updatePreferences,
  } = input;
  const resolvedModel = resolveEffectiveModel(availableModels, formState.model);
  const modelId = resolvedModel?.id ?? formState.model;
  await updatePreferences((current) =>
    mergeProviderPreferences({
      preferences: current,
      provider,
      updates: {
        // Omitted entirely, not set to undefined, so an earlier explicit choice is left intact.
        ...(modelChosenByUser && modelId
          ? { model: modelId, modelChosenByUser: true as const }
          : {}),
        ...(modeChosenByUser
          ? { mode: formState.modeId || undefined, modeChosenByUser: true as const }
          : {}),
        // Recorded per model, and only when the user picked it. Writing a resolved effort was the same
        // ratchet in its third form: a session that happened to come up High wrote High into the profile,
        // and it then outranked the model's own default effort on every later session.
        ...(thinkingChosenByUser && modelId && formState.thinkingOptionId
          ? {
              thinkingByModel: { [modelId]: formState.thinkingOptionId },
              thinkingChosenByModel: { [modelId]: true as const },
            }
          : {}),
      },
    }),
  );
}

export function useAgentFormState(options: UseAgentFormStateOptions): UseAgentFormStateResult {
  const { serverId, initialValues, workingDir, isVisible = true, isCreateFlow = true } = options;

  const { preferences, isLoading: isPreferencesLoading, updatePreferences } = useFormPreferences();
  const preferenceOverlayRef = useRef(new OptimisticFormPreferences(preferences));

  useEffect(() => {
    preferenceOverlayRef.current.reconcile(preferences);
  }, [preferences]);

  const updateCurrentPreferences = useCallback(
    async (
      updates: Partial<FormPreferences> | ((current: FormPreferences) => FormPreferences),
    ): Promise<FormPreferences> => {
      const pendingId = preferenceOverlayRef.current.begin(updates);
      try {
        const persisted = await updatePreferences(updates);
        preferenceOverlayRef.current.commit(pendingId, persisted);
        return persisted;
      } catch (error) {
        preferenceOverlayRef.current.reject(pendingId);
        throw error;
      }
    },
    [updatePreferences],
  );

  // The store reads what the host offers when a command runs; each render publishes the latest.
  const catalogRef = useRef<AgentFormCatalog>(EMPTY_CATALOG);
  const [formStore] = useState(() => openAgentForm(() => catalogRef.current));
  const { form: formState, resolution } = useSyncExternalStore(
    formStore.subscribe,
    formStore.getState,
    formStore.getState,
  );
  const dispatch = formStore.dispatch;

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    error: snapshotError,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: workingDir });

  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const allProviderEntries = useMemo(() => snapshotEntries ?? [], [snapshotEntries]);
  const snapshotProviderDefinitions = useMemo(
    () => buildProviderDefinitions(snapshotEntries),
    [snapshotEntries],
  );
  const snapshotProviderDefinitionMap = useMemo(
    () => buildProviderDefinitionMap(snapshotProviderDefinitions),
    [snapshotProviderDefinitions],
  );
  const snapshotResolvableProviderDefinitionMap = useMemo(
    () =>
      buildProviderDefinitionMapForStatuses({
        snapshotEntries,
        providerDefinitions: snapshotProviderDefinitions,
        statuses: RESOLVABLE_PROVIDER_STATUSES,
      }),
    [snapshotEntries, snapshotProviderDefinitions],
  );
  const snapshotSelectableProviderDefinitionMap = useMemo(() => {
    return buildProviderDefinitionMapForStatuses({
      snapshotEntries,
      providerDefinitions: snapshotProviderDefinitions,
      statuses: SELECTABLE_PROVIDER_STATUSES,
    });
  }, [snapshotEntries, snapshotProviderDefinitions]);
  const snapshotAllProviderModels = useMemo(
    () => buildAllProviderModels(snapshotEntries),
    [snapshotEntries],
  );
  const snapshotProviderModelsByProvider = useMemo(
    () => buildProviderModelsByProvider(snapshotEntries),
    [snapshotEntries],
  );
  const snapshotModelSelectorProviders = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(snapshotEntries, {
        isConnected,
        selectedProvider: formState.provider || null,
      }),
    [snapshotEntries, isConnected, formState.provider],
  );
  const snapshotSelectedEntry = useMemo(
    () =>
      formState.provider
        ? ((snapshotEntries ?? []).find((entry) => entry.provider === formState.provider) ?? null)
        : null,
    [formState.provider, snapshotEntries],
  );
  const snapshotSelectedProviderModels = filterSelectableModels(
    snapshotSelectedEntry?.models ?? null,
  );
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";
  const snapshotSelectedProviderModes = resolveSelectedProviderModes({
    selectedEntry: snapshotSelectedEntry,
    provider: formState.provider,
    providerDefinitionMap: snapshotProviderDefinitionMap,
  });
  const providerDefinitions = snapshotProviderDefinitions;
  const providerDefinitionMap = snapshotProviderDefinitionMap;
  const selectableProviderDefinitionMap = snapshotSelectableProviderDefinitionMap;
  const allProviderModels = snapshotAllProviderModels;
  catalogRef.current = {
    selectableProviders: selectableProviderDefinitionMap,
    models: allProviderModels,
    providerPreferences: (provider) =>
      preferenceOverlayRef.current.current().providerPreferences?.[provider],
  };
  const modelSelectorProviders = snapshotModelSelectorProviders;
  const availableModels = snapshotSelectedProviderModels;
  const modeOptions = snapshotSelectedProviderModes;
  const isModelSelectionLoading =
    isConnected &&
    (resolution.status === "pending" || snapshotIsLoading || selectedProviderIsLoading);
  const isAllModelsLoading = isModelSelectionLoading;

  useEffect(() => {
    dispatch({
      type: "INPUTS_CHANGED",
      serverId,
      isVisible,
      isCreateFlow,
      isPreferencesLoading,
      hasSnapshot: snapshotEntries !== undefined,
      initialValues,
      preferences,
      providerModelsByProvider: snapshotProviderModelsByProvider,
      allowedProviderMap: snapshotResolvableProviderDefinitionMap,
    });
  }, [
    serverId,
    isVisible,
    isCreateFlow,
    isPreferencesLoading,
    snapshotEntries,
    initialValues,
    preferences,
    snapshotProviderModelsByProvider,
    snapshotResolvableProviderDefinitionMap,
    dispatch,
  ]);

  const setProviderAndModelFromUser = useCallback(
    (provider: AgentProvider, modelId: string): boolean => {
      if (!formStore.setProviderAndModel(provider, modelId)) return false;
      const providerModels = allProviderModels.get(provider) ?? null;
      const nextModelId =
        normalizeSelectedModelId(modelId) || resolveDefaultModelId(providerModels);
      void updateCurrentPreferences((current) =>
        mergeSelectedComposerPreferences({
          preferences: current,
          provider,
          // From the user, by the action's own name: picking a provider and model is a choice, so the
          // model it records is allowed to outrank the host's advertised default later.
          updates: nextModelId ? { model: nextModelId, modelChosenByUser: true } : {},
        }),
      );
      return true;
    },
    [allProviderModels, formStore, updateCurrentPreferences],
  );

  const clearProviderSelectionFromUser = useCallback(() => {
    dispatch({ type: "CLEAR_PROVIDER_SELECTION_FROM_USER" });
  }, [dispatch]);

  const applyProfileFromUser = useCallback(
    (profile: MaterializedAgentProfile) => {
      const provider = profile.provider as AgentProvider;
      if (!selectableProviderDefinitionMap.has(provider)) {
        return;
      }

      const formBefore = formStore.getState();
      const previousProvider = formBefore.form.provider;
      const providerDef = selectableProviderDefinitionMap.get(provider);
      const providerModels = allProviderModels.get(provider) ?? null;
      const providerPrefs = preferenceOverlayRef.current.current().providerPreferences?.[provider];
      const action = {
        type: "APPLY_PROFILE_FROM_USER" as const,
        provider,
        modelId: profile.modelId,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        providerDef,
        providerModels,
        providerPrefs,
      };
      const nextState = resolveAgentForm(formBefore, action);
      const previousProviderModeIds = previousProvider
        ? (providerDefinitionMap.get(previousProvider)?.modes.map((mode) => mode.id) ?? [])
        : [];

      dispatch(action);
      void updateCurrentPreferences((current) => {
        const { model, modeId, thinkingOptionId } = nextState.form;
        return applyAgentProfilePreferences({
          preferences: current,
          previousProvider,
          previousProviderModeIds,
          provider,
          modelId: model,
          modeId,
          thinkingOptionId,
          options: profile.options,
        });
      }).catch((error) => {
        console.warn("[useAgentFormState] persist profile preference failed", error);
      });
    },
    [
      allProviderModels,
      dispatch,
      formStore,
      providerDefinitionMap,
      selectableProviderDefinitionMap,
      updateCurrentPreferences,
    ],
  );

  const setModeFromUser = useCallback(
    (modeId: string) => {
      dispatch({ type: "SET_MODE_FROM_USER", modeId });
      const { provider } = formStore.getState().form;
      if (provider) {
        void updateCurrentPreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: modeId ? { mode: modeId, modeChosenByUser: true } : { mode: undefined },
          }),
        );
      }
    },
    [dispatch, formStore, updateCurrentPreferences],
  );

  const setModelFromUser = useCallback(
    (modelId: string) => {
      formStore.setModel(modelId);
      const { provider } = formStore.getState().form;
      if (provider) {
        const listed = allProviderModels.get(provider);
        const nextModelId =
          normalizeSelectedModelId(modelId) ||
          resolveDefaultModelId(listed?.length ? listed : null);
        void updateCurrentPreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: nextModelId ? { model: nextModelId, modelChosenByUser: true } : {},
          }),
        );
      }
    },
    [allProviderModels, formStore, updateCurrentPreferences],
  );

  const setThinkingOptionFromUser = useCallback(
    (thinkingOptionId: string, retainedOptions?: ProviderOptions) => {
      dispatch({ type: "SET_THINKING_OPTION_FROM_USER", thinkingOptionId });
<<<<<<< HEAD
      const provider = formState.provider;
      // A draft can follow the default model without pinning it. Effort still belongs to the displayed model.
      const modelId =
        resolveEffectiveModel(availableModels, formState.model)?.id ||
        resolveDefaultModelId(availableModels);
=======
      const { provider, model: modelId } = formStore.getState().form;
>>>>>>> refs/remotes/upstream/tags/v0.17.5
      if (provider && modelId) {
        void updateCurrentPreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: {
<<<<<<< HEAD
              thinkingByModel: { [modelId]: thinkingOptionId },
              thinkingChosenByModel: { [modelId]: true },
=======
              thinkingByModel: {
                [modelId]: thinkingOptionId,
              },
              options: retainedOptions,
>>>>>>> refs/remotes/upstream/tags/v0.17.5
            },
          }),
        );
      }
    },
<<<<<<< HEAD
    [availableModels, formState, updateCurrentPreferences],
=======
    [dispatch, formStore, updateCurrentPreferences],
>>>>>>> refs/remotes/upstream/tags/v0.17.5
  );

  const getSelectedProvider = useCallback(() => formStore.getState().form.provider, [formStore]);

  const refreshProviderModels = useCallback(
    (provider?: AgentProvider) => {
      void refreshSnapshot(provider ? [provider] : undefined);
    },
    [refreshSnapshot],
  );

  const refetchProviderModelsIfStale = useCallback(() => {
    refetchSnapshotIfStale(formState.provider);
  }, [formState.provider, refetchSnapshotIfStale]);

  const persistFormPreferences = useCallback(async () => {
    if (!formState.provider) {
      return;
    }
    await persistProviderPreferences({
      provider: formState.provider,
      formState,
      modeChosenByUser: userModified.modeId,
      modelChosenByUser: userModified.model,
      thinkingChosenByUser: userModified.thinkingOptionId,
      availableModels,
      updatePreferences: updateCurrentPreferences,
    });
  }, [
    availableModels,
    formState,
    userModified.modeId,
    userModified.model,
    userModified.thinkingOptionId,
    updateCurrentPreferences,
  ]);

  const agentDefinition = formState.provider
    ? providerDefinitionMap.get(formState.provider)
    : undefined;
  const draftEffort = resolveDraftEffort(
    availableModels ?? [],
    formState.model,
    formState.thinkingOptionId,
  );
  const availableThinkingOptionsRaw = draftEffort.options;
  const availableThinkingOptions = useMemo(
    () => availableThinkingOptionsRaw ?? [],
    [availableThinkingOptionsRaw],
  );
  const isModelLoading = isModelSelectionLoading;
  const modelError = snapshotError;

  const workingDirIsEmpty = !workingDir.trim();

  return useMemo(
    () => ({
      selectedServerId: serverId,
      selectedProvider: formState.provider,
      getSelectedProvider,
      selectedMode: formState.modeId,
      setModeFromUser,
      selectedModel: formState.model,
      setModelFromUser,
      selectedThinkingOptionId: formState.thinkingOptionId,
      setThinkingOptionFromUser,
      workingDir,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      allProviderEntries,
      modeOptions,
      availableModels: availableModels ?? [],
      allProviderModels,
      modelSelectorProviders,
      isAllModelsLoading,
      isProviderModelsRefreshing: snapshotIsRefreshing,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      refetchProviderModelsIfStale,
      setProviderAndModelFromUser,
      applyProfileFromUser,
      clearProviderSelectionFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    }),
    [
      serverId,
      getSelectedProvider,
      formState.provider,
      formState.modeId,
      formState.model,
      formState.thinkingOptionId,
      workingDir,
      setModeFromUser,
      setModelFromUser,
      setThinkingOptionFromUser,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      allProviderEntries,
      modeOptions,
      availableModels,
      allProviderModels,
      modelSelectorProviders,
      isAllModelsLoading,
      snapshotIsRefreshing,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      refetchProviderModelsIfStale,
      setProviderAndModelFromUser,
      applyProfileFromUser,
      clearProviderSelectionFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    ],
  );
}

export type CreateAgentInitialValues = FormInitialValues;
