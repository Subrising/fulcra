import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import {
  ageLabel,
  itemGroup,
  progressBoardRpc,
  type ProgressBoard,
} from "../shared/progress-board";

const GROUPS = ["In progress", "Decide", "Next", "Open", "Done"] as const;

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
  const [group, setGroup] = useState<(typeof GROUPS)[number]>("In progress");
  const c = theme.colors;
  const project = data?.projects.find((p) => p.id === selected) ?? data?.projects[0];
  const body = { color: c.foreground, fontSize: 14, lineHeight: 22, flexShrink: 1 };
  const muted = { ...body, color: c.foregroundMuted };
  const section = { gap: 12, marginTop: 20 };
  const heading = { ...body, fontSize: 18, fontWeight: "600" as const };
  const row = {
    gap: 6,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: c.border,
    minWidth: 0,
  };
  const now = Date.parse(data?.observedAt ?? "");
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12 }}
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
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {data?.projects.map((p) => (
          <WorkButton
            key={p.id}
            theme={theme}
            label={p.name}
            selected={project?.id === p.id}
            onPress={() => select(p.id)}
          />
        ))}
      </View>
      {!loading && data?.projects.length === 0 && (
        <Text style={body}>No projects on this host.</Text>
      )}
      {project && (
        <>
          <View style={section}>
            <Text accessibilityRole="header" style={heading}>
              Ledger
            </Text>
            <Text style={muted}>{project.ledgerState}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {GROUPS.map((g) => (
                <WorkButton
                  key={g}
                  theme={theme}
                  label={`${g} (${project.items.filter((i) => itemGroup(i) === g).length})`}
                  selected={group === g}
                  onPress={() => setGroup(g)}
                />
              ))}
            </View>
            {project.items
              .filter((i) => itemGroup(i) === group)
              .map((i) => (
                <View key={i.id} style={row}>
                  <Text selectable style={{ ...body, fontWeight: "600" }}>
                    {i.id} · {i.item}
                  </Text>
                  <Text selectable style={muted}>
                    {i.kind} · {i.status} · {i.owner || "Owner unavailable"}
                  </Text>
                  {!!i.evidence && i.evidence !== "—" && (
                    <Text selectable style={muted}>
                      Evidence: {i.evidence}
                    </Text>
                  )}
                </View>
              ))}
            {!project.items.some((i) => itemGroup(i) === group) && (
              <Text style={muted}>No items in {group.toLowerCase()}.</Text>
            )}
          </View>
          <View style={section}>
            <Text accessibilityRole="header" style={heading}>
              Upcoming items
            </Text>
            {project.items
              .filter((i) => ["Next", "Open"].includes(itemGroup(i)) && i.kind !== "RULE")
              .slice(0, 5)
              .map((i) => (
                <Text key={i.id} selectable style={body}>
                  {i.id} · {i.item}
                </Text>
              ))}
            {!project.items.some(
              (i) => ["Next", "Open"].includes(itemGroup(i)) && i.kind !== "RULE",
            ) && <Text style={muted}>No upcoming items.</Text>}
          </View>
          <View style={section}>
            <Text accessibilityRole="header" style={heading}>
              Jobs
            </Text>
            {!project.jobs.length && <Text style={muted}>No jobs on this host.</Text>}
            {project.jobs.map((j) => (
              <View key={j.id} style={row}>
                <Text selectable style={{ ...body, fontWeight: "600" }}>
                  {j.title}
                </Text>
                <Text style={muted}>
                  {j.status} · {j.machine} · {ageLabel(j.createdAt, now)}
                </Text>
                {j.permissions > 0 && (
                  <Text style={{ ...body, color: c.statusWarning }}>
                    Waiting for permission ({j.permissions})
                  </Text>
                )}
                <Text selectable style={body}>
                  {j.result ?? "No result available."}
                </Text>
                {navigation && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open job ${j.title}`}
                    onPress={() => navigation.openAgent({ agentId: j.id })}
                    style={{ minWidth: 48, minHeight: 48, justifyContent: "center" }}
                  >
                    <Text style={body}>Open job</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
          <View style={section}>
            <Text accessibilityRole="header" style={heading}>
              Branches and checks
            </Text>
            <Text style={muted}>Git and CI reads are cached for at least 60 seconds.</Text>
            {!project.branches.length && <Text style={muted}>No workspaces on this host.</Text>}
            {project.branches.map((b, i) => (
              <View key={`${b.workspace}:${i}`} style={row}>
                <Text selectable style={{ ...body, fontWeight: "600" }}>
                  {b.workspace}
                </Text>
                <Text selectable style={body}>
                  {b.branch ?? "Branch unavailable"} · {b.head?.slice(0, 12) ?? "Head unavailable"}
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
          </View>
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
