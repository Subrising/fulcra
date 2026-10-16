import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import {
  useHosts,
  invokeHostRpc,
  type PluginSurfaceProps,
  type PluginHostSummary,
} from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import {
  ageLabel,
  combineProjects,
  progressBoardRpc,
  readyItems,
  recentDone,
  type ProgressBoard,
} from "../shared/progress-board";

type HostBoard = { id: string; label: string; data: ProgressBoard | null; error: string | null };
type Section = "running" | "done" | "next" | "blocked";
const labels: Record<Section, string> = {
  running: "Running now",
  done: "Done",
  next: "Next",
  blocked: "Blocked",
};
// Session IDs and ledger keys remain navigation keys. They are not page copy.
const plain = (text: string) =>
  text
    .replace(/\b[A-Z]{2,5}-\d+\b\s*[:·-]?\s*/g, "")
    .replace(/\b[a-f\d]{8}-[a-f\d-]{27,}\b/gi, "")
    .replace(/\b(?:lead|chat|session)\s+[a-f\d]{7,40}\b/gi, "")
    .replace(/\([a-f\d]{7,40}\)/gi, "")
    .replace(/\[removed\]/g, "Private detail")
    .trim();
const modelName = (name: string | null | undefined) =>
  name
    ? name
        .replace(/^claude-/, "")
        .replace(/-(\d)-(\d)$/, " $1.$2")
        .replace(/^./, (letter) => letter.toUpperCase())
    : "Model unavailable";

export function ProgressBoardView({
  theme,
  layout,
  navigation,
  boards,
  hosts,
  selected,
  selectHost,
  loading,
  refresh,
}: PluginSurfaceProps & {
  boards: HostBoard[];
  hosts: readonly PluginHostSummary[];
  selected: string;
  selectHost: (id: string) => void;
  loading: boolean;
  refresh: () => void;
}) {
  const { width } = useWindowDimensions();
  const c = theme.colors;
  const wide = width >= 1100 && !layout.compact;
  const now = Date.now();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const summary = (text: string) =>
    text.length <= 150 ? text : `${text.slice(0, 145).replace(/\s+\S*$/, "")}…`;
  const evidenceLine = (text: string) =>
    [
      ...new Set(
        text.match(
          /https:\/\/github\.com\/[^\s]+\/pull\/\d+|(?:PR|pull request)\s*#?\d+|\b[0-9a-f]{7,40}\b/gi,
        ) ?? [],
      ),
    ]
      .slice(0, 2)
      .join(" · ") || summary(plain(text));
  const colors: Record<Section, string> = {
    running: "#62c7f2",
    done: "#71cda0",
    next: c.foreground,
    blocked: "#efbb79",
  };
  // Use darker status ink in the light theme.
  const light = c.foreground.toLowerCase() === "#1a1a1e" || c.surface0.toLowerCase() === "#ffffff";
  if (light) {
    colors.running = "#08648d";
    colors.done = "#17683c";
    colors.blocked = "#825013";
  }
  const body = { color: c.foreground, fontSize: 15, lineHeight: 22, flexShrink: 1 } as const;
  const muted = { ...body, color: c.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const projects = combineProjects(boards);
  const latest = Math.max(
    0,
    ...boards.flatMap((board) => (board.data ? [Date.parse(board.data.observedAt)] : [])),
  );
  const selectedLabel =
    selected === "all"
      ? "All hosts"
      : (hosts.find((host) => host.serverId === selected)?.label ?? "Selected computer");
  const rows = (project: ProgressBoard["projects"][number], section: Section) => {
    if (section === "running")
      return project.jobs.filter(
        (job) => job.status === "running" || job.status === "initializing",
      );
    if (section === "done") return recentDone(project.items, now);
    if (section === "next") return readyItems(project.items);
    return project.items.filter((item) => /^BLOCKED\b/i.test(item.status));
  };
  function section(section: Section) {
    const count = projects.reduce((sum, project) => sum + rows(project, section).length, 0);
    const unknown =
      section === "done"
        ? projects.reduce(
            (sum, project) =>
              sum +
              project.items.filter((item) => /^DONE\b/i.test(item.status) && !item.completedAt)
                .length,
            0,
          )
        : 0;
    const empty: Record<Section, string> = {
      running: "No sessions are running on the connected computers.",
      done: "No dated completions in the last 24 hours.",
      next: "No open work is ready in the available project lists.",
      blocked: "No work is marked blocked in the available project lists.",
    };
    return (
      <View testID={`board-section-${section}`} style={{ gap: 16, minWidth: 0 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            borderBottomWidth: 1,
            borderColor: c.border,
            paddingBottom: 14,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              ...body,
              fontSize: 21,
              lineHeight: 28,
              fontWeight: "700",
              color: colors[section],
              flex: 1,
            }}
          >
            {labels[section]}
          </Text>
          <Text
            accessibilityLabel={`${count} ${labels[section].toLowerCase()}`}
            style={{ ...body, color: colors[section], fontWeight: "700", fontSize: 20 }}
          >
            {count}
          </Text>
        </View>
        {section === "done" && <Text style={muted}>Closed in the last 24 hours</Text>}
        {!count && (
          <Text style={muted}>
            {projects.length
              ? empty[section]
              : loading
                ? "Reading the selected computers…"
                : "Connect a computer with sessions or a project list to see work here."}
          </Text>
        )}
        {!!unknown && (
          <Text style={muted}>
            {unknown} closed {unknown === 1 ? "item has" : "items have"} no completion date. They
            are outside this view.
          </Text>
        )}
        {projects.map((project) => {
          const entries = rows(project, section);
          if (!entries.length) return null;
          return (
            <View key={project.id} style={{ gap: 0, minWidth: 0 }}>
              <Text style={{ ...muted, fontWeight: "700", paddingBottom: 6 }}>
                {plain(project.name)} · {entries.length}
              </Text>
              {entries.map((entry) => {
                if ("title" in entry) {
                  const contents = (
                    <View style={{ gap: 6, minWidth: 0 }}>
                      <Text style={{ ...body, fontWeight: "600" }}>{plain(entry.title)}</Text>
                      <Text style={{ ...muted, color: colors.running }}>
                        {modelName(entry.model)} · {selected === "all" ? `${entry.machine} · ` : ""}
                        {entry.startedAt
                          ? `Running for ${ageLabel(entry.startedAt, now)}`
                          : "Start time unavailable"}
                      </Text>
                      <Text style={muted}>
                        {entry.result
                          ? summary(plain(entry.result))
                          : "No activity text received yet."}
                      </Text>
                      {!!entry.permissions && (
                        <Text style={{ ...muted, color: colors.blocked }}>
                          Waiting for permission
                        </Text>
                      )}
                    </View>
                  );
                  return navigation ? (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open session: ${plain(entry.title)}`}
                      onPress={() =>
                        navigation.openAgent({
                          agentId: entry.id,
                          serverId: "hostId" in entry ? String(entry.hostId) : undefined,
                        })
                      }
                      style={{
                        paddingVertical: 16,
                        minHeight: 48,
                        minWidth: 48,
                        borderBottomWidth: 1,
                        borderColor: c.border,
                      }}
                    >
                      {contents}
                    </Pressable>
                  ) : (
                    <View key={entry.id} style={{ paddingVertical: 16 }}>
                      {contents}
                    </View>
                  );
                }
                const itemKey = `${project.id}:${entry.id}`;
                const isExpanded = expanded.has(itemKey);
                return (
                  <View
                    key={entry.id}
                    style={{
                      gap: 6,
                      paddingVertical: 16,
                      borderBottomWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${isExpanded ? "Hide" : "Show"} full item: ${summary(plain(entry.item))}`}
                      accessibilityState={{ expanded: isExpanded }}
                      onPress={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(itemKey)) next.delete(itemKey);
                          else next.add(itemKey);
                          return next;
                        })
                      }
                      style={{ minHeight: 48, minWidth: 48, justifyContent: "center" }}
                    >
                      <Text style={{ ...body, fontWeight: "500" }}>
                        {isExpanded ? plain(entry.item) : summary(plain(entry.item))}
                      </Text>
                    </Pressable>
                    {section === "done" ? (
                      <Text style={{ ...muted, color: colors.done }}>
                        {entry.evidence && entry.evidence !== "—"
                          ? isExpanded
                            ? plain(entry.evidence)
                            : evidenceLine(entry.evidence)
                          : "No evidence recorded."}
                      </Text>
                    ) : (
                      <Text style={muted}>{plain(entry.owner) || "Owner unavailable"}</Text>
                    )}
                    {section === "blocked" && (
                      <>
                        <Text style={{ ...body, color: colors.blocked }}>
                          {plain(entry.status.replace(/^BLOCKED\s*:?\s*/i, "")) ||
                            "No block reason recorded."}
                        </Text>
                        <Text style={muted}>
                          {entry.blockedAt
                            ? `Blocked for ${ageLabel(entry.blockedAt, now)}`
                            : "Block start time not recorded."}
                        </Text>
                      </>
                    )}
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>
    );
  }
  return (
    <ScrollView
      testID="board-page"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: width < 600 ? 20 : 32, gap: 28 }}
    >
      <View style={{ gap: 16 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ ...body, fontSize: 28, lineHeight: 36, fontWeight: "700", flex: 1 }}
          >
            Progress
          </Text>
          <WorkButton theme={theme} label="Refresh board" onPress={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </WorkButton>
        </View>
        <Text style={muted}>What is running, what finished, and what can start next.</Text>
        <View testID="board-hosts" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <WorkButton
            theme={theme}
            label="All hosts"
            selected={selected === "all"}
            onPress={() => selectHost("all")}
          />
          {hosts.map((host) => (
            <WorkButton
              key={host.serverId}
              theme={theme}
              label={`${host.label}${host.status === "online" ? "" : " · Offline"}`}
              selected={selected === host.serverId}
              onPress={() => selectHost(host.serverId)}
            />
          ))}
        </View>
        <Text testID="board-updated" style={muted}>
          {selectedLabel} ·{" "}
          {loading
            ? "Reading…"
            : latest
              ? `Updated ${new Date(latest).toLocaleTimeString()}`
              : "No current snapshot"}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          {(["running", "done", "next", "blocked"] as const).map((key) => (
            <Text key={key} style={{ ...body, color: colors[key], fontWeight: "600" }}>
              {projects.reduce((sum, project) => sum + rows(project, key).length, 0)}{" "}
              {labels[key].toLowerCase()}
            </Text>
          ))}
        </View>
        {boards.flatMap((board) => [
          board.error ? (
            <Text
              key={`${board.id}:error`}
              accessibilityRole="alert"
              style={{ ...muted, color: colors.blocked }}
            >
              {board.label}: {board.error}
            </Text>
          ) : null,
          ...(board.data?.warnings ?? []).map((warning) => (
            <Text key={`${board.id}:${warning}`} style={{ ...muted, color: colors.blocked }}>
              {board.label}: {warning}
            </Text>
          )),
        ])}
      </View>
      <View
        style={{
          flexDirection: wide ? "row" : "column",
          gap: wide ? 32 : 36,
          alignItems: "stretch",
          minWidth: 0,
        }}
      >
        <View style={{ flex: wide ? 1.15 : undefined, minWidth: 0 }}>{section("running")}</View>
        <View style={{ flex: wide ? 1 : undefined, minWidth: 0, gap: 36 }}>
          {section("next")}
          {section("blocked")}
        </View>
        <View style={{ flex: wide ? 1 : undefined, minWidth: 0 }}>{section("done")}</View>
      </View>
    </ScrollView>
  );
}

export function ProgressBoardSurface(props: PluginSurfaceProps) {
  const read = useContract(progressBoardRpc);
  const configured = useHosts();
  const hosts = useMemo(
    () =>
      configured.length
        ? configured
        : [{ serverId: props.host.id, label: props.host.label, status: "online" as const }],
    [configured, props.host.id, props.host.label],
  );
  const [selected, selectHost] = useState("all");
  const [boards, setBoards] = useState<HostBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false,
      pending = false;
    const targets = hosts.filter((host) => selected === "all" || selected === host.serverId);
    setBoards([]); // A host change must not show the previous computer's work.
    async function refresh() {
      if (disposed || pending) return;
      pending = true;
      setLoading(true);
      const next = await Promise.all(
        targets.map(async (host): Promise<HostBoard> => {
          if (host.status !== "online")
            return {
              id: host.serverId,
              label: host.label,
              data: null,
              error: "This computer is offline. Connect it to read its work.",
            };
          try {
            const data =
              host.serverId === props.host.id
                ? await read({})
                : progressBoardRpc.output.parse(
                    await invokeHostRpc(host.serverId, progressBoardRpc.name, {}),
                  );
            return { id: host.serverId, label: host.label, data, error: null };
          } catch {
            return {
              id: host.serverId,
              label: host.label,
              data: null,
              error: "Cannot read this computer. Check its connection, then refresh.",
            };
          }
        }),
      );
      if (!disposed) {
        setBoards(next);
        setLoading(false);
      }
      pending = false;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [read, hosts, selected, revision, props.host.id]);
  return (
    <ProgressBoardView
      {...props}
      boards={boards}
      hosts={hosts}
      selected={selected}
      selectHost={selectHost}
      loading={loading}
      refresh={() => setRevision((n) => n + 1)}
    />
  );
}
