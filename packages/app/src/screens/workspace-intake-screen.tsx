import React, { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { View, Text, Platform } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { SettingsInput } from "@/components/settings";
import { useControllerInstallations } from "@/plugins/registry";
import { ThemedSurfaceRenderer } from "@/plugins/surface-screen";
import { toPluginTheme } from "@/plugins/theme";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { newIntakeId } from "@/plugins/organization-navigation-model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
  WORKSPACES_PREFERENCE_KEY,
} from "@/plugins/contribution-host";
import { selectOrganizationSource } from "@/plugins/workspace-organization-model";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { Theme } from "@/styles/theme";
import type { InstalledPlugin } from "@/plugins/types";
import type { IntakeDraft } from "../../../../control/orca-organization/shared/intake-draft";
const CONTROLLER_KEY = WORKSPACES_PREFERENCE_KEY;
const mapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
const NO_PARAMS = {};
const stringParam = (value: unknown) => (typeof value === "string" ? value : null);
const threadParam = (value: unknown, fallback: string) =>
  typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
    ? value
    : fallback;
function useIntakeDraft(thread: string) {
  const draftKey = `draft:global-intake:${thread}`;
  const text = useDraftStore((state) => state.getDraftInput(draftKey)?.text ?? "");
  const [hydrated, setHydrated] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void useDraftStore
      .getState()
      .hydrateDraftInput({ draftKey })
      .finally(() => {
        if (active) setHydrated(draftKey);
      });
    return () => {
      active = false;
    };
  }, [draftKey]);
  const setText = useCallback(
    (value: string) => useDraftStore.getState().editDraftText({ draftKey, text: value }),
    [draftKey],
  );
  return { id: thread, text, setText, ready: hydrated === draftKey };
}
export function WorkspaceIntakeScreen() {
  const params = useLocalSearchParams<{
    thread?: string;
    controller?: string;
    workspace?: string;
  }>();
  const [fallbackId] = useState(newIntakeId);
  const thread = threadParam(params.thread, fallbackId),
    draft = useIntakeDraft(thread);
  const companyHost = useOrganizationIntakePreferences((state) => state.companyHost);
  const requestSource = useOrganizationIntakePreferences((state) => state.requestSources[thread]);
  const preferencesHydrated = useOrganizationIntakePreferences((state) => state.hydrated);
  const hydrationError = useOrganizationIntakePreferences((state) => state.hydrationError);
  const retryPreferences = useCallback(() => {
    void useOrganizationIntakePreferences.persist.rehydrate();
  }, []);
  const sources = useControllerInstallations().filter((plugin) =>
    plugin.surfaces.some((surface) => surface.id === "intake"),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const explicit = stringParam(params.controller);
  const source = selectOrganizationSource(
    sources,
    requestSource ??
      explicit ??
      picked ??
      companyHost ??
      getPreferredPluginContributionHost(CONTROLLER_KEY),
  );
  const choose = useCallback(
    (serverId: string) => {
      rememberPluginContributionHost(CONTROLLER_KEY, serverId);
      useOrganizationIntakePreferences.getState().chooseCompany(serverId);
      setPicked(serverId);
    },
    [setPicked],
  );
  return (
    <View style={styles.screen}>
      <MenuHeader title="New chat" />
      {hydrationError && (
        <View style={styles.fallback}>
          <Text style={styles.notice}>{hydrationError}</Text>
          <SettingsInput
            label="What would you like to work on?"
            initialValue={draft.text}
            onChangeText={draft.setText}
          />
          <Button size="sm" variant="outline" onPress={retryPreferences}>
            Retry saved intake
          </Button>
        </View>
      )}
      {!hydrationError &&
        (draft.ready && preferencesHydrated ? (
          <IntakeConnection
            key={`${source?.serverId ?? "pending"}:${thread}`}
            source={source}
            sources={sources}
            draft={draft}
            workspaceId={stringParam(params.workspace) ?? undefined}
            canChoose={!explicit && !requestSource}
            choose={choose}
          />
        ) : (
          <Text style={styles.notice}>Reading your saved intake…</Text>
        ))}
    </View>
  );
}
function IntakeConnection({
  source,
  sources,
  draft,
  workspaceId,
  canChoose,
  choose,
}: {
  source: InstalledPlugin | null;
  sources: InstalledPlugin[];
  draft: IntakeDraft;
  workspaceId?: string;
  canChoose: boolean;
  choose: (id: string) => void;
}) {
  const serverId = source?.serverId ?? "",
    client = useHostRuntimeClient(serverId),
    hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const surface = source?.surfaces.find((entry) => entry.id === "intake");
  const bindSource = useStableEvent(() => {
    if (!source) return;
    useOrganizationIntakePreferences.getState().bindRequest(draft.id, source.serverId);
    router.setParams({ controller: source.serverId });
  });
  const manage = useStableEvent(() => {
    if (source)
      router.push(
        buildPluginSurfaceRoute(source.serverId, source.id, { kind: "surface", id: "workspaces" }),
      );
  });
  const connect = useCallback(() => router.push("/settings"), []);
  const label = hosts.find((entry) => entry.serverId === serverId)?.label ?? "Your home computer";
  return (
    <>
      <View style={styles.toolbar}>
        <Button size="sm" variant="ghost" onPress={manage} disabled={!source}>
          Manage workspaces
        </Button>
      </View>
      {source && surface && client ? (
        <IntakeRenderer
          Surface={surface.Component}
          plugin={source}
          serverId={serverId}
          label={label}
          compact={compact}
          intakeId={draft.id}
          text={draft.text}
          setText={draft.setText}
          workspaceId={workspaceId}
          bindSource={bindSource}
        />
      ) : (
        <View style={styles.fallback}>
          <Text style={styles.notice}>
            Your draft stays here until Fulcra on your home computer connects.
          </Text>
          <SettingsInput
            label="What would you like to work on?"
            initialValue={draft.text}
            onChangeText={draft.setText}
          />
          {canChoose && sources.length > 1 ? (
            <Text style={styles.notice}>Which computer runs your main assistant?</Text>
          ) : null}
          {canChoose &&
            sources.map((plugin) => (
              <ControllerChoice
                key={plugin.serverId}
                serverId={plugin.serverId}
                label={
                  hosts.find((entry) => entry.serverId === plugin.serverId)?.label ??
                  "Unnamed computer"
                }
                choose={choose}
              />
            ))}
          <Button size="sm" variant="outline" onPress={connect}>
            Connect or update Fulcra
          </Button>
        </View>
      )}
    </>
  );
}
function intakePlatform(): "ios" | "android" | "web" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}
function IntakeRenderer({
  Surface,
  plugin,
  serverId,
  label,
  compact,
  intakeId,
  text,
  setText,
  workspaceId,
  bindSource,
}: {
  Surface: ComponentType<PluginScreenProps>;
  plugin: InstalledPlugin;
  serverId: string;
  label: string;
  compact: boolean;
  intakeId: string;
  text: string;
  setText: (value: string) => void;
  workspaceId?: string;
  bindSource: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const layout = useMemo(() => ({ compact, platform: intakePlatform() }), [compact]);
  const host = useMemo(() => ({ id: serverId, label }), [label, serverId]);
  const organizationDraft = useMemo(
    () => ({ id: intakeId, text, setText, workspaceId, bindSource }),
    [bindSource, intakeId, setText, text, workspaceId],
  );
  if (!client) return <Text style={styles.notice}>Reconnect your home computer to continue.</Text>;
  return (
    <ThemedSurfaceRenderer
      Surface={Surface}
      params={NO_PARAMS}
      plugin={plugin}
      layout={layout}
      host={host}
      organizationDraft={organizationDraft}
      uniProps={mapping}
    />
  );
}
function ControllerChoice({
  serverId,
  label,
  choose,
}: {
  serverId: string;
  label: string;
  choose: (id: string) => void;
}) {
  const select = useCallback(() => choose(serverId), [choose, serverId]);
  return (
    <Button size="sm" variant="outline" onPress={select}>
      {label}
    </Button>
  );
}
const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  toolbar: { paddingHorizontal: 16, paddingVertical: 8 },
  fallback: { padding: 16, gap: 12 },
  notice: { color: theme.colors.foregroundMuted, padding: 8 },
}));
