import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
  type ArchitectureChangeSelection,
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
import { BlastRadiusSection } from "@/architecture-map/blast-radius-section";
import {
  generatedChange,
  type GeneratedPayload,
  type ReadyChange,
} from "@/architecture-map/generated-change";
import type { ArchitectureChangeImpact } from "@getpaseo/protocol/messages";
import { DependencyGraphView } from "@/architecture-map/dependency-graph-view";
import { PullRequestReviewView } from "@/architecture-map/pull-request-review-view";
import {
  useArchitectureGraph,
  useCanReviewPullRequests,
  useCanShowGraph,
  useCanGenerateChanges,
  useFetchPullRequestCommits,
  useGeneratedChange,
  usePullRequestChoices,
} from "@/architecture-map/use-generated-change";
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

// "Show in map" on a pull request's Change view opens the dependency map with that pull request highlighted.
const ShowInMapContext = createContext<((pullRequest: number) => void) | null>(null);
// "Review" on a pull request's Change view opens its review screen.
const OpenReviewContext = createContext<((pullRequest: number) => void) | null>(null);

function ArchitectureMapPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(
    target.kind === "architecture_map",
    "ArchitectureMapPanel requires architecture_map target",
  );
  const [viewState, setViewState] = usePanelState(viewStateSchema, MAP_VIEW);
  const requestKey = changeViewRequestKey(serverId, workspaceId);
  const [selection, setSelection] = useState<ArchitectureChangeSelection | undefined>();
  const changeRequested = useChangeViewRequests((state) => state.pending.get(requestKey));
  const consumeRequest = useChangeViewRequests((state) => state.consume);
  useEffect(() => {
    if (!changeRequested) return;
    const requested = consumeRequest(requestKey);
    if (requested) {
      setSelection(typeof requested === "object" ? requested : undefined);
      setViewState(CHANGE_VIEW);
    }
  }, [changeRequested, consumeRequest, requestKey, setViewState]);
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const list = useArchitectureMapList({ serverId, workspaceRoot });
  const canGenerate = useCanGenerateChanges(serverId);
  const canGraph = useCanShowGraph(serverId);
  const [graphPullRequest, setGraphPullRequest] = useState<number | null>(null);
  const showInMap = useCallback(
    (pullRequest: number) => {
      setGraphPullRequest(pullRequest);
      setViewState(MAP_VIEW);
    },
    [setViewState],
  );
  const clearGraphPullRequest = useCallback(() => setGraphPullRequest(null), []);
  const canReview = useCanReviewPullRequests(serverId);
  const [reviewPullRequest, setReviewPullRequest] = useState<number | null>(null);
  const closeReview = useCallback(() => setReviewPullRequest(null), []);
  const showReviewInMap = useCallback(
    (pullRequest: number) => {
      setReviewPullRequest(null);
      showInMap(pullRequest);
    },
    [showInMap],
  );
  const refetchList = list.refetch;
  const reloadList = useCallback(() => {
    void refetchList();
  }, [refetchList]);

  if (!workspaceRoot) {
    return <CenterMessage text={t("panels.file.directoryMissing")} />;
  }
  if (reviewPullRequest !== null) {
    return (
      <PullRequestReviewView
        serverId={serverId}
        cwd={workspaceRoot}
        pullRequest={reviewPullRequest}
        onBack={closeReview}
        onShowInMap={canGraph ? showReviewInMap : null}
      />
    );
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
  const hasMaps = Boolean(listed && listed.maps.length > 0);
  if (!hasMaps && !canGenerate && !canGraph) return <NoMaps listing={listed} />;
  return (
    <View style={styles.root}>
      <ViewToggle view={viewState.view} onChoose={setViewState} />
      {viewState.view === "change" ? (
        <OpenReviewContext.Provider value={canReview ? setReviewPullRequest : null}>
          <ShowInMapContext.Provider value={canGraph ? showInMap : null}>
            <ChangeArea
              serverId={serverId}
              workspaceRoot={workspaceRoot}
              listing={hasMaps ? listed : null}
              canGenerate={canGenerate}
              selection={selection}
            />
          </ShowInMapContext.Provider>
        </OpenReviewContext.Provider>
      ) : null}
      {viewState.view === "map" ? (
        <MapArea
          serverId={serverId}
          workspaceRoot={workspaceRoot}
          listing={hasMaps ? listed : null}
          canGraph={canGraph}
          pullRequest={graphPullRequest}
          onClearPullRequest={clearGraphPullRequest}
          onReloadList={reloadList}
        />
      ) : null}
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

function NoMaps(props: { listing: ArchitectureMapListing | null }) {
  const { t } = useTranslation();
  const oversized = props.listing?.oversized ?? [];
  return (
    <CenterMessage
      testID="architecture-map-empty"
      text={t("panels.architectureMap.emptyTitle")}
      detail={t("panels.architectureMap.emptyDescription", {
        directory: ARCHITECTURE_MAP_DIRECTORY,
      })}
      extra={
        oversized.length > 0
          ? t("panels.architectureMap.oversized", { names: oversized.join(", ") })
          : null
      }
    />
  );
}

type ChangeSource = "code" | "drawn";

// The Map view: the whole repository's dependency map drawn from the code, or the project's drawn maps.
function MapArea(props: {
  serverId: string;
  workspaceRoot: string;
  listing: ArchitectureMapListing | null;
  canGraph: boolean;
  pullRequest: number | null;
  onClearPullRequest: () => void;
  onReloadList: () => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<ChangeSource | null>(null);
  const source: ChangeSource =
    props.pullRequest !== null ? "code" : (chosen ?? (props.canGraph ? "code" : "drawn"));
  const chooseCode = useCallback(() => setChosen("code"), []);
  const chooseDrawn = useCallback(() => {
    props.onClearPullRequest();
    setChosen("drawn");
  }, [props]);
  let body: ReactNode = (
    <CenterMessage
      testID="architecture-map-empty"
      text={t("panels.architectureMap.emptyTitle")}
      detail={t("panels.architectureMap.emptyDescription", {
        directory: ARCHITECTURE_MAP_DIRECTORY,
      })}
    />
  );
  if (source === "code" && props.canGraph) {
    body = (
      <CodeGraphBrowser
        serverId={props.serverId}
        workspaceRoot={props.workspaceRoot}
        pullRequest={props.pullRequest}
        onClearPullRequest={props.onClearPullRequest}
      />
    );
  } else if (props.listing) {
    body = (
      <MapBrowser
        serverId={props.serverId}
        workspaceRoot={props.workspaceRoot}
        listing={props.listing}
        onReloadList={props.onReloadList}
      />
    );
  }
  return (
    <View style={styles.root}>
      {props.canGraph && props.listing ? (
        <View style={styles.toggle} accessibilityRole="tablist">
          <SourceChip
            label={t("panels.architectureMap.graph.sourceCode")}
            selected={source === "code"}
            onPress={chooseCode}
            testID="architecture-map-source-code"
          />
          <SourceChip
            label={t("panels.architectureMap.graph.sourceDrawn")}
            selected={source === "drawn"}
            onPress={chooseDrawn}
            testID="architecture-map-source-drawn"
          />
        </View>
      ) : null}
      {body}
    </View>
  );
}

function SourceChip(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={props.selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={props.onPress}
      style={[styles.chip, props.selected && styles.chipSelected]}
      testID={props.testID}
    >
      <Text style={styles.chipText}>{props.label}</Text>
    </Pressable>
  );
}

function CodeGraphBrowser(props: {
  serverId: string;
  workspaceRoot: string;
  pullRequest: number | null;
  onClearPullRequest: () => void;
}) {
  const { t } = useTranslation();
  const query = useArchitectureGraph({
    serverId: props.serverId,
    cwd: props.workspaceRoot,
    pullRequest: props.pullRequest,
  });
  const refetch = query.refetch;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const payload = query.data ?? null;
  if (query.isLoading) return <CenterMessage text={t("panels.architectureMap.graph.loading")} />;
  if (query.error || !payload || payload.status !== "ok" || !payload.graph) {
    const missing = payload?.status === "missing-commits";
    return (
      <CenterMessage
        testID="dependency-graph-error"
        text={t("panels.architectureMap.graph.failed")}
        detail={missing ? t("panels.architectureMap.graph.missing") : (payload?.error ?? null)}
        actionLabel={t("panels.architectureMap.reload")}
        onAction={reload}
      />
    );
  }
  return (
    <DependencyGraphView
      graph={payload.graph}
      refLabel={payload.ref ?? ""}
      pullRequest={payload.pullRequest ?? null}
      onClearPullRequest={props.pullRequest !== null ? props.onClearPullRequest : null}
    />
  );
}

// The Change view: drawn from the code by the host (any pull request, no map needed), or from the maps
// committed in `.fulcra/architecture` when the project has them.
function ChangeArea(props: {
  serverId: string;
  workspaceRoot: string;
  listing: ArchitectureMapListing | null;
  canGenerate: boolean;
  selection?: ArchitectureChangeSelection;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<ChangeSource | null>(null);
  const source: ChangeSource =
    chosen ?? (props.canGenerate && !props.selection?.commit ? "code" : "drawn");
  const chooseCode = useCallback(() => setChosen("code"), []);
  const chooseDrawn = useCallback(() => setChosen("drawn"), []);
  const both = props.canGenerate && props.listing !== null;
  return (
    <View style={styles.root}>
      {both ? (
        <View style={styles.toggle} accessibilityRole="tablist">
          <Pressable
            accessibilityRole="tab"
            accessibilityState={source === "code" ? SELECTED_STATE : UNSELECTED_STATE}
            onPress={chooseCode}
            style={[styles.chip, source === "code" && styles.chipSelected]}
            testID="architecture-change-source-code"
          >
            <Text style={styles.chipText}>
              {t("panels.architectureMap.change.generated.sourceCode")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={source === "drawn" ? SELECTED_STATE : UNSELECTED_STATE}
            onPress={chooseDrawn}
            style={[styles.chip, source === "drawn" && styles.chipSelected]}
            testID="architecture-change-source-drawn"
          >
            <Text style={styles.chipText}>
              {t("panels.architectureMap.change.generated.sourceDrawn")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {source === "code" || !props.listing ? (
        <GeneratedChangeBrowser
          serverId={props.serverId}
          workspaceRoot={props.workspaceRoot}
          requested={props.selection?.pullRequest ?? null}
        />
      ) : (
        <ChangeBrowser
          serverId={props.serverId}
          workspaceRoot={props.workspaceRoot}
          listing={props.listing}
          selection={props.selection}
        />
      )}
    </View>
  );
}

const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 9) : "");

const GENERATED = "panels.architectureMap.change.generated";

function GeneratedChangeBrowser(props: {
  serverId: string;
  workspaceRoot: string;
  requested: number | null;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<number | null>(null);
  const choices = usePullRequestChoices({
    serverId: props.serverId,
    cwd: props.workspaceRoot,
    enabled: true,
  });
  const list = choices.data ?? [];
  const pullRequest = picked ?? props.requested ?? list[0]?.number ?? null;
  const shown =
    pullRequest !== null && !list.some((pr) => pr.number === pullRequest)
      ? [{ number: pullRequest, title: "", state: "" }, ...list]
      : list;
  let body: ReactNode;
  if (pullRequest !== null) {
    body = (
      <GeneratedChangeBody
        serverId={props.serverId}
        workspaceRoot={props.workspaceRoot}
        pullRequest={pullRequest}
      />
    );
  } else if (choices.isLoading) {
    body = <Loading />;
  } else {
    body = (
      <CenterMessage
        testID="architecture-change-no-pull-requests"
        text={choices.error ? t(`${GENERATED}.pickFailed`) : t(`${GENERATED}.pickEmpty`)}
        detail={choices.error instanceof Error ? choices.error.message : null}
      />
    );
  }
  return (
    <View style={styles.root}>
      {shown.length > 0 ? (
        <ScrollView horizontal style={styles.picker} contentContainerStyle={styles.pickerContent}>
          {shown.map((pr) => (
            <PullRequestChip
              key={pr.number}
              number={pr.number}
              title={pr.title}
              selected={pr.number === pullRequest}
              onChoose={setPicked}
            />
          ))}
        </ScrollView>
      ) : null}
      {body}
    </View>
  );
}

function GeneratedChangeBody(props: {
  serverId: string;
  workspaceRoot: string;
  pullRequest: number;
}) {
  const { t } = useTranslation();
  const generated = useGeneratedChange({
    serverId: props.serverId,
    cwd: props.workspaceRoot,
    pullRequest: props.pullRequest,
  });
  const refetch = generated.refetch;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const fetcher = useFetchPullRequestCommits({
    serverId: props.serverId,
    cwd: props.workspaceRoot,
    pullRequest: props.pullRequest,
    onFetched: reload,
  });
  const payload = generated.data ?? null;
  const change = useMemo(() => (payload ? generatedChange(payload) : null), [payload]);
  if (generated.isLoading) return <CenterMessage text={t(`${GENERATED}.generating`)} />;
  if (generated.error || !payload) {
    return (
      <CenterMessage
        testID="architecture-change-error"
        text={t(`${GENERATED}.failedTitle`)}
        detail={generated.error instanceof Error ? generated.error.message : null}
        actionLabel={t("panels.architectureMap.reload")}
        onAction={reload}
      />
    );
  }
  if (payload.status === "missing-commits") {
    return (
      <CenterMessage
        testID="architecture-change-missing-commits"
        text={t(`${GENERATED}.missingTitle`)}
        detail={t(
          fetcher.failed === null ? `${GENERATED}.missingDetail` : `${GENERATED}.fetchFailed`,
        )}
        actionLabel={t(fetcher.fetching ? `${GENERATED}.fetching` : `${GENERATED}.fetch`)}
        onAction={fetcher.fetching ? undefined : fetcher.fetch}
      />
    );
  }
  if (change?.kind !== "ready" || !payload.impact) {
    const detail = change?.kind === "unavailable" ? change.detail.join("\n") : null;
    return (
      <CenterMessage
        testID="architecture-change-error"
        text={t(`${GENERATED}.failedTitle`)}
        detail={payload.error ?? detail}
        actionLabel={t("panels.architectureMap.reload")}
        onAction={reload}
      />
    );
  }
  return <GeneratedChangeReady payload={payload} change={change} impact={payload.impact} />;
}

function GeneratedChangeReady(props: {
  payload: GeneratedPayload;
  change: ReadyChange;
  impact: ArchitectureChangeImpact;
}) {
  const { t } = useTranslation();
  const { payload, change, impact } = props;
  const touchedNotes = useMemo(
    () =>
      new Map(
        impact.parts.map((part) => [
          part.id,
          t(`${GENERATED}.editedCounts`, {
            added: part.added,
            modified: part.modified,
            deleted: part.deleted,
          }),
        ]),
      ),
    [impact, t],
  );
  const title = payload.pullRequest
    ? `#${payload.pullRequest.number} ${payload.pullRequest.title}`
    : "";
  const showInMap = useContext(ShowInMapContext);
  const openReview = useContext(OpenReviewContext);
  const pullRequestNumber = payload.pullRequest?.number ?? null;
  const openInMap = useCallback(() => {
    if (showInMap && pullRequestNumber !== null) showInMap(pullRequestNumber);
  }, [showInMap, pullRequestNumber]);
  const review = useCallback(() => {
    if (openReview && pullRequestNumber !== null) openReview(pullRequestNumber);
  }, [openReview, pullRequestNumber]);
  return (
    <View style={styles.root}>
      {pullRequestNumber !== null && (showInMap || openReview) ? (
        <View style={styles.toggle}>
          {openReview ? (
            <Pressable
              accessibilityRole="button"
              onPress={review}
              style={styles.action}
              testID="architecture-change-review"
            >
              <Text style={styles.actionText}>{t("panels.architectureMap.review.open")}</Text>
            </Pressable>
          ) : null}
          {showInMap ? (
            <Pressable
              accessibilityRole="button"
              onPress={openInMap}
              style={styles.action}
              testID="architecture-change-show-in-map"
            >
              <Text style={styles.actionText}>{t("panels.architectureMap.graph.showInMap")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ArchitectureChangeView
        change={change}
        title={title}
        baseLabel={shortSha(payload.base)}
        onOpenPullRequest={null}
        showFileFacts={false}
        touchedNotes={touchedNotes}
      >
        <BlastRadiusSection
          change={change}
          impact={impact}
          provenance={t(`${GENERATED}.provenance`, {
            base: shortSha(payload.base),
            head: shortSha(payload.head),
          })}
        />
      </ArchitectureChangeView>
    </View>
  );
}

function PullRequestChip(props: {
  number: number;
  title: string;
  selected: boolean;
  onChoose: (value: number) => void;
}) {
  const { number, onChoose } = props;
  const onPress = useCallback(() => onChoose(number), [number, onChoose]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.chip, props.selected && styles.chipSelected]}
      testID="architecture-change-pull-request"
    >
      <Text style={styles.chipText} numberOfLines={1}>
        {props.title ? `#${number} ${props.title.slice(0, 60)}` : `#${number}`}
      </Text>
    </Pressable>
  );
}

// The Change view for the chosen map: its text now, the branch diff against the base, and the
// folders beside changed code. Everything is rebuilt from reads; nothing is written.
// The Change view for the chosen map. Everything is rebuilt from reads; nothing is written.
function ChangeBrowser(props: {
  serverId: string;
  workspaceRoot: string;
  listing: ArchitectureMapListing;
  selection?: ArchitectureChangeSelection;
}) {
  const { t } = useTranslation();
  const { openTab } = usePaneContext();
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const view = useArchitectureChange({
    serverId: props.serverId,
    workspaceRoot: props.workspaceRoot,
    maps: props.listing.maps,
    chosenPath,
    selection: props.selection,
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
        onOpenPullRequest={view.pullRequest && !props.selection ? openPullRequest : null}
        showFileFacts={!props.selection}
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
  showFileFacts: boolean;
}) {
  const { t } = useTranslation();
  const { loading, error, change, onReload } = props;
  // R-C-J7-2: a pull request's comparison waits for the host's read-at-commit interface; the one
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
      showFileFacts={props.showFileFacts}
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
