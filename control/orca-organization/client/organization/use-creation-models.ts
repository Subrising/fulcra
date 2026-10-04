import { intakeProvider } from "./creation-config.mjs";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { sessionDefaultsRpc } from "../../shared/session-defaults";
import { useContract } from "../use-contract";
import type { openIntakeForm } from "./intake-form";
export function useCreationModels(
  model: ReturnType<typeof openIntakeForm>,
  controllerId: string,
  hostId?: string,
  online = false,
  directory?: string,
) {
  const readDefaults = useContract(sessionDefaultsRpc);
  const defaults = useQuery({
    queryKey: ["fulcra-intake-defaults", controllerId],
    queryFn: () => readDefaults({}),
    retry: false,
    staleTime: 60000,
  });
  const providers = useQuery({
    queryKey: ["fulcra-intake-models", hostId, directory],
    enabled: !!hostId && online,
    queryFn: () =>
      getPaseoClient(hostId!).providers.snapshot(directory ? { cwd: directory } : undefined),
    retry: false,
    staleTime: 60000,
  });
  const row = defaults.data?.roles.implementation;
  const provider = row?.provider;
  const selected = provider ? row?.providers[provider]?.effective : null;
  useEffect(() => {
    if (provider && selected?.model) {
      const label = providers.data?.entries
        .flatMap((entry) => entry.models ?? [])
        .find(
          (candidate) => candidate.provider === provider && candidate.id === selected.model,
        )?.label;
      model.applyDefaults(
        `${provider}/${selected.model}`,
        selected.thinkingOptionId ?? "",
        defaults.data?.modes?.[provider] ?? "",
        label,
      );
    }
  }, [defaults.data?.modes, model, provider, providers.data, selected]);
  const selectedProvider = intakeProvider(model.getState().model);
  const selectedEntry = providers.data?.entries.find(
    (entry) => entry.provider === selectedProvider && entry.status === "ready",
  );
  const configuredMode =
    selectedProvider === "claude" || selectedProvider === "codex"
      ? defaults.data?.modes?.[selectedProvider]
      : undefined;
  useEffect(() => {
    model.applyProviderModes({
      provider: selectedProvider,
      modes: selectedEntry ? (selectedEntry.modes ?? []) : null,
      configuredMode,
      defaultMode: selectedEntry?.defaultModeId,
    });
  }, [configuredMode, model, selectedEntry, selectedProvider]);
  const models = (providers.data?.entries ?? [])
    .filter((entry) => entry.enabled !== false && entry.status === "ready")
    .flatMap((entry) =>
      (entry.models ?? [])
        .filter((item) => item.isSelectable !== false)
        .map((item) => ({ ...item, key: `${item.provider}/${item.id}` })),
    );
  return { providers, models, modes: selectedEntry?.modes ?? [] };
}
