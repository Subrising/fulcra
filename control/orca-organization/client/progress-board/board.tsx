import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "../use-contract";
import { WorkButton } from "../work-button";
import {
  progressBoardRpc,
  progressBoardWatchRpc,
  type ProgressBoard,
  type LedgerItem,
} from "../../shared/progress-board";
const lanes: LedgerItem["lane"][] = ["DECIDE", "In progress", "Next", "Open", "Done"];
export function age(createdAt: string, observedAt: string): string {
  const elapsed = Date.parse(observedAt) - Date.parse(createdAt);
  if (!Number.isFinite(elapsed)) return "Age unavailable";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  return minutes < 60
    ? `${minutes} min`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)} h`
      : `${Math.floor(minutes / 1440)} d`;
}
export function ProgressBoardSurface(props: PluginSurfaceProps) {
  const read = useContract(progressBoardRpc),
    watch = useContract(progressBoardWatchRpc);
  const query = useQuery({
    queryKey: ["fulcra-progress-board", props.host.id],
    queryFn: () => read({}),
    staleTime: 60000,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const { refetch } = query;
  const revisionRef = useRef(0);
  const hasBoard = Boolean(query.data);
  useEffect(() => {
    revisionRef.current = query.data?.revision ?? 0;
  }, [query.data]);
  useEffect(() => {
    if (!hasBoard) return;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeRetry: (() => void) | undefined;
    let revision = revisionRef.current;
    async function follow() {
      while (!stopped) {
        try {
          const next = await watch({ revision });
          if (stopped) return;
          if (next.revision !== revision) {
            revision = next.revision;
            const result = await refetch();
            if (result.data) revision = result.data.revision;
          }
        } catch {
          await new Promise<void>((resolve) => {
            wakeRetry = resolve;
            retryTimer = setTimeout(resolve, 60000);
          });
        }
      }
    }
    void follow();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      wakeRetry?.();
    };
  }, [props.host.id, watch, refetch, hasBoard]);
  return (
    <ProgressBoardView
      {...props}
      board={query.data}
      loading={query.isPending}
      error={query.isError ? "The progress board could not be read." : ""}
      refresh={() => void refetch()}
    />
  );
}
export function ProgressBoardView({
  theme,
  layout,
  host,
  board,
  loading,
  error,
  refresh,
}: PluginSurfaceProps & {
  board?: ProgressBoard;
  loading: boolean;
  error: string;
  refresh: () => void;
}) {
  const c = theme.colors;
  const [selected, setSelected] = useState<string | null>(null);
  const [lane, setLane] = useState<LedgerItem["lane"] | "All">("All");
  const project = board?.projects.find((row) => row.id === selected) ?? board?.projects[0];
  const text = { color: c.foreground, fontSize: 14, lineHeight: 21, flexShrink: 1 };
  const muted = { ...text, color: c.foregroundMuted };
  const heading = { ...text, fontWeight: "600" as const };
  const rows =
    project?.items.filter((item) => (lane === "All" ? item.lane !== "Done" : item.lane === lane)) ??
    [];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 24 }}
      testID="progress-board"
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1, gap: 4 }}>
          <Text style={heading}>Progress board</Text>
          <Text style={muted}>{host.label || "Selected host"} · Live job and ledger events</Text>
          <Text style={muted}>Git and CI refresh every 60 seconds. No model runs.</Text>
        </View>
        <WorkButton theme={theme} label="Refresh" onPress={refresh} />
      </View>
      {loading && (
        <Text style={muted} accessibilityRole="alert">
          Loading the progress board…
        </Text>
      )}
      {!!error && (
        <Text style={{ ...text, color: c.statusDanger }} accessibilityRole="alert">
          {error} Use Refresh to retry.
        </Text>
      )}
      {!!board?.notice && (
        <Text style={muted} accessibilityRole="alert">
          {board.notice}
        </Text>
      )}
      {board?.partial && (
        <Text style={muted}>Some records are unavailable. This board is incomplete.</Text>
      )}
      {board && board.projects.length === 0 && (
        <Text style={muted}>No projects or jobs were found on this host.</Text>
      )}
      {!!board?.projects.length && (
        <View style={{ gap: 8 }}>
          <Text style={heading}>Projects</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {board.projects.map((row) => (
              <WorkButton
                key={row.id}
                theme={theme}
                label={row.name}
                selected={row.id === project?.id}
                onPress={() => {
                  setSelected(row.id);
                  setLane("All");
                }}
              />
            ))}
          </View>
        </View>
      )}
      {project && (
        <>
          <View style={{ gap: 8 }}>
            <Text style={heading}>{project.name}</Text>
            {!!project.notice && <Text style={muted}>{project.notice}</Text>}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <WorkButton
                theme={theme}
                label="Current items"
                selected={lane === "All"}
                onPress={() => setLane("All")}
              />
              {lanes.map((value) => (
                <WorkButton
                  key={value}
                  theme={theme}
                  label={`${value} (${project.items.filter((item) => item.lane === value).length})`}
                  selected={lane === value}
                  onPress={() => setLane(value)}
                />
              ))}
            </View>
          </View>
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}
          >
            <View
              style={{
                flexGrow: 3,
                flexBasis: layout.compact ? "100%" : 480,
                minWidth: 0,
                maxWidth: "100%",
                gap: 16,
              }}
            >
              <Text style={heading}>Ledger</Text>
              {rows.length === 0 && <Text style={muted}>No items in this view.</Text>}
              {lanes
                .filter((value) => rows.some((item) => item.lane === value))
                .map((value) => (
                  <View key={value} style={{ gap: 8 }}>
                    <Text
                      style={{
                        ...heading,
                        color: value === "DECIDE" ? c.statusWarning : c.foreground,
                      }}
                    >
                      {value === "Next" ? "Next · Upcoming items" : value}
                    </Text>
                    {rows
                      .filter((item) => item.lane === value)
                      .map((item) => (
                        <View
                          key={item.id}
                          style={{
                            paddingVertical: 12,
                            gap: 4,
                            borderBottomWidth: 1,
                            borderColor: c.border,
                          }}
                        >
                          <Text style={heading}>
                            {item.id} · {item.item}
                          </Text>
                          <Text style={muted}>
                            {item.kind} · {item.owner || "No owner"} · {item.status}
                          </Text>
                          {!!item.evidence && <Text style={muted}>{item.evidence}</Text>}
                        </View>
                      ))}
                  </View>
                ))}
            </View>
            <View
              style={{
                flexGrow: 2,
                flexBasis: layout.compact ? "100%" : 320,
                minWidth: 0,
                maxWidth: "100%",
                gap: 24,
              }}
            >
              <View style={{ gap: 8 }}>
                <Text style={heading}>Live jobs ({project.jobs.length})</Text>
                {project.jobs.length === 0 && <Text style={muted}>No live jobs.</Text>}
                {project.jobs.map((job) => (
                  <View
                    key={job.id}
                    style={{
                      paddingVertical: 12,
                      gap: 4,
                      borderBottomWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    <Text style={heading}>{job.title}</Text>
                    <Text
                      style={{ ...text, color: job.waiting ? c.statusWarning : c.foregroundMuted }}
                    >
                      {job.waiting ? "Waiting for permission" : job.status} ·{" "}
                      {host.label || job.machine}
                    </Text>
                    <Text style={muted}>Age: {age(job.createdAt, board!.observedAt)}</Text>
                    <Text style={text}>{job.result}</Text>
                  </View>
                ))}
              </View>
              <View style={{ gap: 8 }}>
                <Text style={heading}>Branches and CI</Text>
                {project.branches.length === 0 && (
                  <Text style={muted}>
                    {project.jobs.length
                      ? board?.partial
                        ? "Branch data is unavailable."
                        : "Reading branch heads…"
                      : "No job branches."}
                  </Text>
                )}
                {project.branches.map((branch) => (
                  <View
                    key={branch.directory}
                    style={{
                      paddingVertical: 12,
                      gap: 4,
                      borderBottomWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    <Text style={heading}>{branch.branch}</Text>
                    <Text style={muted}>
                      {branch.head ? branch.head.slice(0, 12) : "Head unavailable"} · {branch.state}
                    </Text>
                    <Text
                      style={{
                        ...text,
                        color: branch.ci === "Failed" ? c.statusDanger : c.foregroundMuted,
                      }}
                    >
                      CI: {branch.ci}
                    </Text>
                    <Text style={muted}>
                      Checked: {new Date(branch.checkedAt).toLocaleTimeString()}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        </>
      )}
      {board && (
        <Text style={muted}>Updated: {new Date(board.observedAt).toLocaleTimeString()}</Text>
      )}
    </ScrollView>
  );
}
