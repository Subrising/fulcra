import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import {
  ageLabel,
  boardColumns,
  progressBoardRpc,
  type BoardCard,
  type BoardGroup,
  type ProgressBoard,
} from "../shared/progress-board";

export function ProgressBoardView({
  theme,
  layout,
  data,
  error,
  loading,
  refresh,
  navigation,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "navigation"> & {
  data: ProgressBoard | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}) {
  const [selected, select] = useState<string | null>(null);
  const [group, setGroup] = useState<BoardGroup>("In progress");
  const [doneOpen, setDoneOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [detail, setDetail] = useState<{
    project: string;
    type: BoardCard["type"];
    id: string;
  } | null>(null);
  const c = theme.colors;
  const project = data?.projects.find((p) => p.id === selected) ?? data?.projects[0];
  const now = Date.parse(data?.observedAt ?? "");
  const columns = project ? boardColumns(project, now) : [];
  const body = { color: c.foreground, fontSize: 14, lineHeight: 22, flexShrink: 1 };
  const muted = { ...body, color: c.foregroundMuted };
  const heading = { ...body, fontWeight: "600" as const };
  const panel = {
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    backgroundColor: c.surface1,
    minWidth: 0,
  };
  const picked =
    detail && detail.project === project?.id
      ? columns
          .flatMap((column) => column.cards)
          .find(
            (card) =>
              card.type === detail.type &&
              (card.type === "item" ? card.item.id : card.job.id) === detail.id,
          )
      : undefined;

  function cardView(card: BoardCard) {
    const item = card.type === "item" ? card.item : null;
    const job = card.type === "job" ? card.job : null;
    const title = item?.item ?? job!.title;
    const id = item?.id ?? job!.id;
    return (
      <Pressable
        key={`${card.type}:${id}`}
        accessibilityRole="button"
        accessibilityLabel={`Open ${item ? item.id : "job"}: ${title}`}
        onPress={() => setDetail({ project: project!.id, type: card.type, id })}
        style={({ pressed }) => ({
          ...panel,
          padding: 12,
          gap: 8,
          minHeight: 48,
          minWidth: 48,
          backgroundColor: pressed ? c.surface2 : c.surface0,
        })}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 8,
            alignItems: "center",
          }}
        >
          <Text numberOfLines={1} style={muted}>
            {item?.id ?? "Job"}
          </Text>
          <Text
            style={{
              ...muted,
              fontSize: 12,
              lineHeight: 18,
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: 4,
              backgroundColor: c.surface2,
            }}
          >
            {item?.kind ?? "JOB"}
          </Text>
        </View>
        <Text numberOfLines={2} ellipsizeMode="tail" style={heading}>
          {title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ ...muted, flex: 1 }}>
            {item ? item.owner || "Owner unavailable" : `${job!.status} · ${job!.machine}`}
          </Text>
          <Text style={muted}>{ageLabel(item?.createdAt ?? job?.createdAt ?? "", now)}</Text>
        </View>
        {!!job?.permissions && (
          <Text style={{ ...body, color: c.statusWarning }}>
            Waiting for permission ({job.permissions})
          </Text>
        )}
        {job && (
          <Text numberOfLines={1} ellipsizeMode="tail" style={muted}>
            {job.result ?? "No result available."}
          </Text>
        )}
      </Pressable>
    );
  }

  function columnView(column: (typeof columns)[number]) {
    const done = column.group === "Done";
    const collapsed = done && !doneOpen;
    return (
      <View
        key={column.group}
        testID={`board-column-${column.group}`}
        style={{
          ...panel,
          width: layout.compact ? "100%" : 288,
          flexShrink: 0,
          padding: 12,
          height: layout.compact ? undefined : 560,
        }}
      >
        {done ? (
          <WorkButton
            theme={theme}
            label={`Done (${column.cards.length})`}
            expanded={doneOpen}
            onPress={() => setDoneOpen((open) => !open)}
          >{`${doneOpen ? "Hide" : "Show"} Done (${column.cards.length})`}</WorkButton>
        ) : (
          <View
            style={{
              minHeight: 48,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text accessibilityRole="header" style={heading}>
              {column.group}
            </Text>
            <Text style={muted}>{column.cards.length}</Text>
          </View>
        )}
        {done && <Text style={muted}>Last 10 ledger completions. Dated items cover 14 days.</Text>}
        {!collapsed &&
          (layout.compact ? (
            <View style={{ gap: 12 }}>{column.cards.map(cardView)}</View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingBottom: 4 }}>
              {column.cards.map(cardView)}
              {!column.cards.length && <Text style={muted}>No items in this column.</Text>}
            </ScrollView>
          ))}
        {!collapsed && layout.compact && !column.cards.length && (
          <Text style={muted}>No items in this column.</Text>
        )}
      </View>
    );
  }

  return (
    <ScrollView
      testID="board-page"
      style={{ flex: 1, minWidth: 0, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <Text accessibilityRole="header" style={{ ...heading, fontSize: 24, lineHeight: 32 }}>
          Progress board
        </Text>
        <WorkButton theme={theme} label="Refresh board" onPress={refresh} disabled={loading} />
      </View>
      <Text style={muted}>
        {data
          ? `${data.machine} · Updated ${new Date(data.observedAt).toLocaleTimeString()}`
          : "Reading this host…"}
      </Text>
      {error && (
        <Text accessibilityRole="alert" style={body}>
          Board unavailable. Select Refresh board to retry.
        </Text>
      )}
      {data?.warnings.map((warning) => (
        <Text key={warning} style={muted}>
          {warning}
        </Text>
      ))}
      <View style={{ gap: 8 }}>
        <Text style={heading}>Project</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {data?.projects.map((p) => (
            <WorkButton
              key={p.id}
              theme={theme}
              label={p.name}
              selected={project?.id === p.id}
              onPress={() => {
                select(p.id);
                setDetail(null);
              }}
            />
          ))}
        </View>
      </View>
      {!loading && data?.projects.length === 0 && (
        <Text style={body}>No projects on this host.</Text>
      )}
      {project && (
        <>
          {project.ledgerState !== "Current" && <Text style={muted}>{project.ledgerState}</Text>}
          {picked ? (
            <View style={panel}>
              <WorkButton theme={theme} label="Back to board" onPress={() => setDetail(null)} />
              {picked.type === "item" ? (
                <>
                  <Text accessibilityRole="header" selectable style={heading}>
                    {picked.item.id} · {picked.item.item}
                  </Text>
                  <Text selectable style={muted}>
                    {picked.item.kind} · {picked.item.status} ·{" "}
                    {picked.item.owner || "Owner unavailable"}
                  </Text>
                  <Text style={muted}>{ageLabel(picked.item.createdAt ?? "", now)}</Text>
                  <Text selectable style={body}>
                    Evidence:{" "}
                    {picked.item.evidence && picked.item.evidence !== "—"
                      ? picked.item.evidence
                      : "No evidence available."}
                  </Text>
                  <Text selectable style={muted}>
                    Source: {picked.item.source || "Source unavailable"}
                  </Text>
                </>
              ) : (
                <>
                  <Text accessibilityRole="header" selectable style={heading}>
                    {picked.job.title}
                  </Text>
                  <Text style={muted}>
                    {picked.job.status} · {picked.job.machine} ·{" "}
                    {ageLabel(picked.job.createdAt, now)}
                  </Text>
                  {!!picked.job.permissions && (
                    <Text style={{ ...body, color: c.statusWarning }}>
                      Waiting for permission ({picked.job.permissions})
                    </Text>
                  )}
                  <Text selectable style={body}>
                    {picked.job.result ?? "No result available."}
                  </Text>
                  {navigation && (
                    <WorkButton
                      theme={theme}
                      label={`Open job ${picked.job.title}`}
                      onPress={() => navigation.openAgent({ agentId: picked.job.id })}
                    >
                      Open job
                    </WorkButton>
                  )}
                </>
              )}
            </View>
          ) : (
            <>
              {layout.compact && (
                <ScrollView
                  horizontal
                  testID="board-status-tabs"
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
                >
                  {columns.map((column) => (
                    <WorkButton
                      key={column.group}
                      theme={theme}
                      label={`${column.group} (${column.cards.length})`}
                      selected={group === column.group}
                      onPress={() => setGroup(column.group)}
                    />
                  ))}
                </ScrollView>
              )}
              {layout.compact ? (
                columns.filter((column) => column.group === group).map(columnView)
              ) : (
                <ScrollView
                  horizontal
                  testID="board-lanes"
                  style={{ flexGrow: 0, minWidth: 0 }}
                  contentContainerStyle={{ gap: 16, paddingBottom: 12 }}
                >
                  {columns.map(columnView)}
                </ScrollView>
              )}
            </>
          )}
          {!picked && (
            <View style={{ gap: 12 }}>
              <WorkButton
                theme={theme}
                label={`Branches and checks (${project.branches.length})`}
                expanded={branchesOpen}
                onPress={() => setBranchesOpen((open) => !open)}
              />
              {branchesOpen && (
                <>
                  <Text style={muted}>Git and CI reads are cached for at least 60 seconds.</Text>
                  {!project.branches.length && (
                    <Text style={muted}>No workspaces on this host.</Text>
                  )}
                  {project.branches.map((b, i) => (
                    <View key={`${b.workspace}:${i}`} style={panel}>
                      <Text selectable style={heading}>
                        {b.workspace}
                      </Text>
                      <Text selectable style={body}>
                        {b.branch ?? "Branch unavailable"} ·{" "}
                        {b.head?.slice(0, 12) ?? "Head unavailable"}
                      </Text>
                      <Text style={muted}>
                        {b.state} · CI: {b.ci}
                      </Text>
                      <Text style={muted}>
                        {b.observedAt
                          ? `Checked ${new Date(b.observedAt).toLocaleTimeString()}`
                          : "Read pending"}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

export function ProgressBoardSurface(props: PluginSurfaceProps) {
  const read = useContract(progressBoardRpc);
  const paseo = usePaseo();
  const [state, setState] = useState<{
    data: ProgressBoard | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false,
      pending = false,
      again = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const releases: Array<() => void | Promise<void>> = [];
    async function refresh() {
      if (disposed) return;
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      setState((s) => ({ ...s, loading: true }));
      try {
        const data = await read({});
        if (!disposed) setState({ data, loading: false, error: null });
      } catch {
        if (!disposed) setState((s) => ({ ...s, loading: false, error: "unavailable" }));
      } finally {
        pending = false;
        if (again) {
          again = false;
          schedule();
        }
      }
    }
    function schedule() {
      if (!disposed) {
        clearTimeout(debounce);
        debounce = setTimeout(() => void refresh(), 400);
      }
    }
    void refresh();
    // Owned directory observations carry status changes and reconnect snapshots. No timeline stream is opened.
    void paseo.agents
      .list({ filter: { includeArchived: false }, subscribe: {}, page: { limit: 100 } })
      .then((directory) => {
        if (disposed) {
          void directory.subscription.release();
          return;
        }
        directory.subscription.subscribe({ snapshot: schedule, update: schedule });
        releases.push(() => directory.subscription.release());
      })
      .catch(() => {});
    void paseo.workspaces
      .list({ subscribe: {}, page: { limit: 100 } })
      .then((directory) => {
        if (disposed) {
          void directory.subscription.release();
          return;
        }
        directory.subscription.subscribe({ snapshot: schedule, update: schedule });
        releases.push(() => directory.subscription.release());
      })
      .catch(() => {});
    const timer = setInterval(() => void refresh(), 60000);
    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearInterval(timer);
      releases.forEach((release) => void release());
    };
  }, [read, paseo, revision]);
  return <ProgressBoardView {...props} {...state} refresh={() => setRevision((n) => n + 1)} />;
}
