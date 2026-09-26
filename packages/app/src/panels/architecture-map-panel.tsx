import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Network } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { z } from "zod";
import type { ArchitectureChange } from "@/architecture-map/architecture-change";
import { ArchitectureChangeView } from "@/architecture-map/architecture-change-view";
import { ArchitectureMapView } from "@/architecture-map/architecture-map-view";
import {
  changeViewRequestKey,
  useChangeViewRequests,
} from "@/architecture-map/change-view-request";
import {
  ARCHITECTURE_MAP_DIRECTORY,
  type ArchitectureMapEntry,
  type ArchitectureMapListing,
} from "@/architecture-map/discovery";
import type { ArchitectureIrParseResult } from "@/architecture-map/ir-model";
import {
  useArchitectureMapDocument,
  useArchitectureMapList,
} from "@/architecture-map/use-architecture-maps";
import { useArchitectureChange } from "@/architecture-map/use-architecture-change";
import { usePaneContext } from "@/panels/pane-context";
import { usePanelState } from "@/panels/use-panel-state";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedNetwork = withUnistyles(Network);
const architectureMapPanelPresentation = {
  label: (t) => t("panels.architectureMap.label"),
  subtitle: (t) => t("panels.architectureMap.subtitle"),
  tooltip: (t) => t("panels.architectureMap.tooltip"),
  icon: ThemedNetwork,
} satisfies PanelPresentation;

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

// Which view the tab shows: the map as it is, or what the current branch changes in it.
const viewStateSchema = z.object({ view: z.enum(["map", "change"]) });
type ViewState = z.infer<typeof viewStateSchema>;
const MAP_VIEW: ViewState = { view: "map" };
const CHANGE_VIEW: ViewState = { view: "change" };

function ArchitectureMapPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(
    target.kind === "architecture_map",
    "ArchitectureMapPanel requires architecture_map target",
  );
  const [viewState, setViewState] = usePanelState(viewStateSchema, MAP_VIEW);
  const requestKey = changeViewRequestKey(serverId, workspaceId);
  const changeRequested = useChangeViewRequests((state) => state.pending.has(requestKey));
  const consumeRequest = useChangeViewRequests((state) => state.consume);
  useEffect(() => {
    if (changeRequested && consumeRequest(requestKey)) setViewState(CHANGE_VIEW);
  }, [changeRequested, consumeRequest, requestKey, setViewState]);
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const list = useArchitectureMapList({ serverId, workspaceRoot });
  const refetchList = list.refetch;
  const reloadList = useCallback(() => {
    void refetchList();
  }, [refetchList]);

  if (!workspaceRoot) {
    return <CenterMessage text={t("panels.file.directoryMissing")} />;
  }
  if (list.isLoading) {
    return <Loading />;
  }
  if (list.error) {
    return (
      <CenterMessage
        text={t("panels.architectureMap.listFailed")}
        detail={list.error instanceof Error ? list.error.message : null}
        actionLabel={t("panels.architectureMap.reload")}
        onAction={reloadList}
      />
    );
  }
  const listed = list.data?.kind === "listed" ? list.data : null;
  if (!listed || listed.maps.length === 0) {
    return (
      <CenterMessage
        testID="architecture-map-empty"
        text={t("panels.architectureMap.emptyTitle")}
        detail={t("panels.architectureMap.emptyDescription", {
          directory: ARCHITECTURE_MAP_DIRECTORY,
        })}
        extra={
          listed && listed.oversized.length > 0
            ? t("panels.architectureMap.oversized", { names: listed.oversized.join(", ") })
            : null
        }
      />
    );
  }
  return (
    <View style={styles.root}>
      <ViewToggle view={viewState.view} onChoose={setViewState} />
      {viewState.view === "change" ? (
        <ChangeBrowser serverId={serverId} workspaceRoot={workspaceRoot} listing={listed} />
      ) : (
        <MapBrowser
          serverId={serverId}
          workspaceRoot={workspaceRoot}
          listing={listed}
          onReloadList={reloadList}
        />
      )}
    </View>
  );
}

function ViewToggle(props: { view: ViewState["view"]; onChoose: (state: ViewState) => void }) {
  const { t } = useTranslation();
  const { view, onChoose } = props;
  const chooseMap = useCallback(() => onChoose(MAP_VIEW), [onChoose]);
  const chooseChange = useCallback(() => onChoose(CHANGE_VIEW), [onChoose]);
  return (
    <View style={styles.toggle} accessibilityRole="tablist">
      <Pressable
        accessibilityRole="tab"
        accessibilityState={view === "map" ? SELECTED_STATE : UNSELECTED_STATE}
        onPress={chooseMap}
        style={[styles.chip, view === "map" && styles.chipSelected]}
        testID="architecture-map-view-map"
      >
        <Text style={styles.chipText}>{t("panels.architectureMap.change.viewMap")}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={view === "change" ? SELECTED_STATE : UNSELECTED_STATE}
        onPress={chooseChange}
        style={[styles.chip, view === "change" && styles.chipSelected]}
        testID="architecture-map-view-change"
      >
        <Text style={styles.chipText}>{t("panels.architectureMap.change.viewChange")}</Text>
      </Pressable>
    </View>
  );
}

// The Change view for the chosen map: its text now, the branch diff against the base, and the
// folders beside changed code. Everything is rebuilt from reads; nothing is written.
// The Change view for the chosen map. Everything is rebuilt from reads; nothing is written.
function ChangeBrowser(props: {
  serverId: string;
  workspaceRoot: string;
  listing: ArchitectureMapListing;
}) {
  const { t } = useTranslation();
  const { openTab } = usePaneContext();
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const view = useArchitectureChange({
    serverId: props.serverId,
    workspaceRoot: props.workspaceRoot,
    maps: props.listing.maps,
    chosenPath,
  });
  const openPullRequest = useCallback(() => openTab({ kind: "pull_request" }), [openTab]);
  const refetch = view.reload;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const ready = view.change?.kind === "ready" ? view.change : null;
  return (
    <View style={styles.root}>
      {view.candidates.length > 1 ? (
        <ScrollView horizontal style={styles.picker} contentContainerStyle={styles.pickerContent}>
          {view.candidates.map((entry) => (
            <PickerChip
              key={entry.path}
              entry={entry}
              selected={entry.path === view.selected?.path}
              onChoose={setChosenPath}
            />
          ))}
        </ScrollView>
      ) : null}
      {view.diffCut ? (
        <Text style={styles.pickerNote} testID="architecture-change-diff-cut">
          {t("panels.architectureMap.change.unavailableDiff")}
        </Text>
      ) : null}
      <ChangeBody
        loading={view.loading}
        error={view.error}
        change={view.change}
        title={ready ? (ready.head?.title ?? ready.base?.title ?? "") : ""}
        baseLabel={view.pullRequest?.baseRefName ?? null}
        onOpenPullRequest={view.pullRequest ? openPullRequest : null}
        onReload={reload}
      />
    </View>
  );
}

function unavailableDetail(
  t: TFunction,
  change: Extract<ArchitectureChange, { kind: "unavailable" }>,
): string {
  switch (change.reason) {
    case "too_large":
    case "binary":
      return t("panels.architectureMap.change.unavailableTooLarge");
    case "mismatch":
      return t("panels.architectureMap.change.unavailableMismatch");
    case "invalid":
      return [t("panels.architectureMap.change.unavailableInvalid"), ...change.detail].join("\n");
    case "pull-request":
      return t("panels.architectureMap.change.unavailablePullRequestDetail");
    case "commit-read":
      return [t("panels.architectureMap.change.unavailableCommitRead"), ...change.detail].join(
        "\n",
      );
    case "not-in-pull-request":
      return t("panels.architectureMap.change.unavailableNotInPullRequest");
  }
}

function ChangeBody(props: {
  loading: boolean;
  error: string | null;
  change: ArchitectureChange | null;
  title: string;
  baseLabel: string | null;
  onOpenPullRequest: (() => void) | null;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const { loading, error, change, onReload } = props;
  // A pull request's comparison waits for the host's read-at-commit interface; the one
  // useful action is to open the pull request itself.
  if (error === null && change?.kind === "unavailable" && change.reason === "pull-request") {
    return (
      <CenterMessage
        testID="architecture-change-pull-request-unavailable"
        text={t("panels.architectureMap.change.unavailablePullRequest")}
        detail={unavailableDetail(t, change)}
        actionLabel={
          props.onOpenPullRequest
            ? t("panels.architectureMap.change.openPullRequestPlain")
            : t("panels.architectureMap.reload")
        }
        onAction={props.onOpenPullRequest ?? onReload}
      />
    );
  }
  if (error !== null || change?.kind === "unavailable") {
    return (
      <CenterMessage
        testID="architecture-change-error"
        text={t("panels.architectureMap.change.unavailableTitle")}
        detail={change?.kind === "unavailable" ? unavailableDetail(t, change) : error}
        actionLabel={t("panels.architectureMap.reload")}
        onAction={onReload}
      />
    );
  }
  if (loading || !change) return <Loading />;
  return (
    <ArchitectureChangeView
      change={change}
      title={props.title}
      baseLabel={props.baseLabel}
      onOpenPullRequest={props.onOpenPullRequest}
    />
  );
}

function MapBrowser(props: {
  serverId: string;
  workspaceRoot: string;
  listing: ArchitectureMapListing;
  onReloadList: () => void;
}) {
  const { t } = useTranslation();
  const { openPreferredTarget } = usePaneContext();
  const { serverId, workspaceRoot, listing, onReloadList } = props;
  const maps: readonly ArchitectureMapEntry[] = listing.maps;
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const selected: ArchitectureMapEntry | null =
    maps.find((entry) => entry.path === chosenPath) ?? maps[0] ?? null;
  const document = useArchitectureMapDocument({
    serverId,
    workspaceRoot,
    path: selected?.path ?? null,
    size: selected?.size ?? null,
  });
  const selectedPath = selected?.path ?? null;
  const openSource = useCallback(() => {
    if (selectedPath) openPreferredTarget({ kind: "file", path: selectedPath }, "explorerFiles");
  }, [openPreferredTarget, selectedPath]);
  const refetchDocument = document.refetch;
  const reload = useCallback(() => {
    onReloadList();
    void refetchDocument();
  }, [onReloadList, refetchDocument]);
  const showPicker = maps.length > 1 || listing.oversized.length > 0 || listing.truncated;

  return (
    <View style={styles.root}>
      {showPicker ? (
        <ScrollView horizontal style={styles.picker} contentContainerStyle={styles.pickerContent}>
          {maps.map((entry) => (
            <PickerChip
              key={entry.path}
              entry={entry}
              selected={entry.path === selectedPath}
              onChoose={setChosenPath}
            />
          ))}
          {listing.oversized.length > 0 ? (
            <Text style={styles.pickerNote}>
              {t("panels.architectureMap.oversized", { names: listing.oversized.join(", ") })}
            </Text>
          ) : null}
          {listing.truncated ? (
            <Text style={styles.pickerNote}>{t("panels.architectureMap.truncated")}</Text>
          ) : null}
        </ScrollView>
      ) : null}
      <DocumentState
        result={document.data ?? null}
        isLoading={document.isLoading}
        error={document.error}
        onOpenSource={openSource}
        onReload={reload}
      />
    </View>
  );
}

function PickerChip(props: {
  entry: ArchitectureMapEntry;
  selected: boolean;
  onChoose: (path: string) => void;
}) {
  const { entry, selected, onChoose } = props;
  const onPress = useCallback(() => onChoose(entry.path), [entry.path, onChoose]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
      testID="architecture-map-picker-item"
    >
      <Text style={styles.chipText}>{entry.name}</Text>
    </Pressable>
  );
}

function DocumentState(props: {
  result: ArchitectureIrParseResult | null;
  isLoading: boolean;
  error: unknown;
  onOpenSource: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const { result, isLoading, error, onOpenSource, onReload } = props;
  if (isLoading) return <Loading />;
  if (error || !result) {
    const message = error instanceof Error ? error.message : null;
    return (
      <CenterMessage
        testID="architecture-map-error"
        text={t("panels.architectureMap.cannotShow")}
        detail={message}
        actionLabel={t("panels.architectureMap.reload")}
        onAction={onReload}
      />
    );
  }
  if (result.kind === "too_large") {
    return (
      <CenterMessage
        testID="architecture-map-error"
        text={t("panels.architectureMap.cannotShow")}
        detail={t("panels.architectureMap.tooLarge")}
      />
    );
  }
  if (result.kind === "invalid") {
    return (
      <CenterMessage
        testID="architecture-map-error"
        text={t("panels.architectureMap.cannotShow")}
        detail={result.reasons.join("\n")}
        actionLabel={t("panels.architectureMap.openFile")}
        onAction={onOpenSource}
      />
    );
  }
  return <ArchitectureMapView model={result.model} />;
}

function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator />
    </View>
  );
}

function CenterMessage(props: {
  text: string;
  detail?: string | null;
  extra?: string | null;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.center} testID={props.testID}>
      <Text style={styles.centerTitle}>{props.text}</Text>
      {props.detail ? <Text style={styles.centerDetail}>{props.detail}</Text> : null}
      {props.extra ? <Text style={styles.centerDetail}>{props.extra}</Text> : null}
      {props.actionLabel && props.onAction ? (
        <Pressable accessibilityRole="button" onPress={props.onAction} style={styles.action}>
          <Text style={styles.actionText}>{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const architectureMapPanelRegistration = definePanel("architecture_map", {
  component: ArchitectureMapPanel,
  presentation: architectureMapPanelPresentation,
});

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  picker: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  pickerContent: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipSelected: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.borderAccent },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  pickerNote: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  toggle: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  centerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  centerDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  action: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
