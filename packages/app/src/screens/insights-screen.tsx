import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { InsightsResult } from "@getpaseo/protocol/messages";
import { MenuHeader } from "@/components/headers/menu-header";
import { useFetchQuery } from "@/data/query";
import { BarChart, type BarDatum } from "@/insights/bar-chart";
import {
  blockedTakeaway,
  cycleTakeaway,
  duration,
  limitsTakeaway,
  mergeTakeaway,
  openTakeaway,
  projectsTakeaway,
  reviewTakeaway,
  sessionsTakeaway,
} from "@/insights/takeaways";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// Insights (GitKraken Insights): how work is flowing, as charts with one plain sentence each. Delivery comes from
// the forge's pull request records; agents from this host's own session records. One project or all of them.

const K = "insights";
const RANGES = [30, 90] as const;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
const ALL = "";
// The host reads at most this many pull requests per list (see the host's insights service).
const PULL_REQUEST_LIST_LIMIT = 1000;

type Delivery = NonNullable<InsightsResult["delivery"]>;
type Agents = InsightsResult["agents"];

export function InsightsScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.root} />;
  return <InsightsContent />;
}

function InsightsContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const client = useSessionStore(
    (state) => (serverId ? state.sessions[serverId]?.client : null) ?? null,
  );
  const [days, setDays] = useState<number>(30);
  const [projectId, setProjectId] = useState<string>(ALL);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 60_000,
    queryKey: ["insights", serverId, days, projectId],
    enabled: Boolean(client),
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("No host");
      return client.getInsights({ days, ...(projectId ? { projectId } : {}) });
    },
  });
  const result = query.data?.status === "ok" ? (query.data.result ?? null) : null;
  let body: ReactElement;
  if (query.isLoading) body = <Text style={styles.muted}>{t(`${K}.loading`)}</Text>;
  else if (!result) body = <Text style={styles.muted}>{t(`${K}.failed`)}</Text>;
  else body = <InsightsBody result={result} />;
  return (
    <View style={styles.root} testID="insights-screen">
      <MenuHeader title={t(`${K}.title`)} />
      <ScrollView contentContainerStyle={styles.content}>
        <Filters
          projects={result?.projects ?? []}
          projectId={projectId}
          days={days}
          onProject={setProjectId}
          onDays={setDays}
        />
        {body}
      </ScrollView>
    </View>
  );
}

function Filters(props: {
  projects: InsightsResult["projects"];
  projectId: string;
  days: number;
  onProject: (id: string) => void;
  onDays: (days: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.filters}>
      <ScrollView horizontal contentContainerStyle={styles.chips}>
        <Chip
          value={ALL}
          label={t(`${K}.allProjects`)}
          selected={props.projectId === ALL}
          onChoose={props.onProject}
        />
        {props.projects.map((p) => (
          <Chip
            key={p.projectId}
            value={p.projectId}
            label={p.name}
            selected={props.projectId === p.projectId}
            onChoose={props.onProject}
          />
        ))}
      </ScrollView>
      <View style={styles.chips}>
        {RANGES.map((range) => (
          <DaysChip
            key={range}
            days={range}
            selected={props.days === range}
            onChoose={props.onDays}
          />
        ))}
      </View>
    </View>
  );
}

function Chip(props: {
  value: string;
  label: string;
  selected: boolean;
  onChoose: (value: string) => void;
}) {
  const { value, onChoose } = props;
  const onPress = useCallback(() => onChoose(value), [value, onChoose]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.chip, props.selected && styles.chipOn]}
      testID="insights-scope"
    >
      <Text style={styles.chipText}>{props.label}</Text>
    </Pressable>
  );
}

function DaysChip(props: { days: number; selected: boolean; onChoose: (days: number) => void }) {
  const { t } = useTranslation();
  const { days, onChoose } = props;
  const onPress = useCallback(() => onChoose(days), [days, onChoose]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.chip, props.selected && styles.chipOn]}
      testID={`insights-days-${days}`}
    >
      <Text style={styles.chipText}>{t(`${K}.lastDays`, { count: days })}</Text>
    </Pressable>
  );
}

function InsightsBody(props: { result: InsightsResult }) {
  const { t } = useTranslation();
  const { result } = props;
  return (
    <View style={styles.sections}>
      <Text style={styles.sectionTitle}>{t(`${K}.delivery`)}</Text>
      {result.delivery ? (
        <DeliverySection delivery={result.delivery} />
      ) : (
        <Text style={styles.muted}>
          {t(result.deliveryUnavailable ? `${K}.deliveryUnavailable` : `${K}.deliveryNone`)}
        </Text>
      )}
      <Text style={styles.sectionTitle} testID="insights-agents">
        {t(`${K}.agents`)}
      </Text>
      <AgentsSection agents={result.agents} />
    </View>
  );
}

function hoursOr(t: ReturnType<typeof useTranslation>["t"], value: number | null): string {
  return value === null ? "—" : duration(t, value);
}

function DeliverySection(props: { delivery: Delivery }) {
  const { t } = useTranslation();
  const d = props.delivery;
  const weeks = useMemo<BarDatum[]>(
    () => d.weeks.map((w) => ({ label: w.week.slice(5), values: [w.merged] })),
    [d.weeks],
  );
  const ages = useMemo<BarDatum[]>(
    () => [
      { label: t(`${K}.age.lt1d`), values: [d.openByAge.lt1d] },
      { label: t(`${K}.age.d1to3`), values: [d.openByAge.d1to3] },
      { label: t(`${K}.age.d3to7`), values: [d.openByAge.d3to7] },
      { label: t(`${K}.age.d7to30`), values: [d.openByAge.d7to30] },
      { label: t(`${K}.age.gt30d`), values: [d.openByAge.gt30d] },
    ],
    [d.openByAge, t],
  );
  const describeWeek = useCallback(
    (datum: BarDatum) => {
      const week = d.weeks.find((w) => w.week.slice(5) === datum.label);
      return t(`${K}.readout.week`, {
        week: datum.label,
        merged: datum.values[0] ?? 0,
        cycle: hoursOr(t, week?.cycleHours ?? null),
      });
    },
    [d.weeks, t],
  );
  const describeAge = useCallback(
    (datum: BarDatum) => t(`${K}.readout.age`, { age: datum.label, count: datum.values[0] ?? 0 }),
    [t],
  );
  return (
    <View style={styles.section} testID="insights-delivery">
      <View style={styles.tiles}>
        <Tile
          label={t(`${K}.tile.cycle`)}
          value={hoursOr(t, d.cycleHours.median)}
          note={cycleTakeaway(t, d)}
        />
        <Tile
          label={t(`${K}.tile.review`)}
          value={hoursOr(t, d.reviewWaitHours.median)}
          note={reviewTakeaway(t, d)}
        />
        <Tile
          label={t(`${K}.tile.merge`)}
          value={d.mergeRate === null ? "—" : `${Math.round(d.mergeRate * 100)}%`}
          note={mergeTakeaway(t, d)}
        />
      </View>
      <ChartCard title={t(`${K}.chart.merged`)} takeaway={cycleTakeaway(t, d)}>
        <BarChart
          data={weeks}
          seriesLabels={[t(`${K}.series.merged`)]}
          describe={describeWeek}
          hint={t(`${K}.hint`)}
          testID="insights-chart-merged"
        />
      </ChartCard>
      <ChartCard title={t(`${K}.chart.openByAge`)} takeaway={openTakeaway(t, d)}>
        <BarChart
          data={ages}
          seriesLabels={[t(`${K}.series.open`)]}
          describe={describeAge}
          hint={t(`${K}.hint`)}
          testID="insights-chart-open"
        />
      </ChartCard>
      {d.capped ? (
        <Text style={styles.muted} testID="insights-capped">
          {t(`${K}.limits.capped`, { count: PULL_REQUEST_LIST_LIMIT })}
        </Text>
      ) : null}
      <Text style={styles.muted}>{t(`${K}.limits.reviewWait`)}</Text>
    </View>
  );
}

function AgentsSection(props: { agents: Agents }) {
  const { t } = useTranslation();
  const a = props.agents;
  const sessions = useMemo<BarDatum[]>(
    () => a.perDay.map((p) => ({ label: p.day.slice(5), values: [p.started, p.finished] })),
    [a.perDay],
  );
  const blocked = useMemo<BarDatum[]>(
    () => a.perDay.map((p) => ({ label: p.day.slice(5), values: [p.blocked + p.limitStops] })),
    [a.perDay],
  );
  const projects = useMemo<BarDatum[]>(
    () =>
      a.byProject
        .slice(0, 8)
        .map((p) => ({ label: p.name || t(`${K}.otherFolders`), values: [p.started] })),
    [a.byProject, t],
  );
  const describeDay = useCallback(
    (datum: BarDatum) =>
      t(`${K}.readout.sessions`, {
        day: datum.label,
        started: datum.values[0] ?? 0,
        finished: datum.values[1] ?? 0,
      }),
    [t],
  );
  const describeBlocked = useCallback(
    (datum: BarDatum) => {
      const day = a.perDay.find((p) => p.day.slice(5) === datum.label);
      return t(`${K}.readout.blocked`, {
        day: datum.label,
        blocked: day?.blocked ?? 0,
        limits: day?.limitStops ?? 0,
      });
    },
    [a.perDay, t],
  );
  const describeProject = useCallback(
    (datum: BarDatum) =>
      t(`${K}.readout.project`, { name: datum.label, count: datum.values[0] ?? 0 }),
    [t],
  );
  return (
    <View style={styles.section}>
      <View style={styles.tiles}>
        <Tile
          label={t(`${K}.tile.started`)}
          value={String(a.totals.started)}
          note={t(`${K}.tile.finishedNote`, { count: a.totals.finished })}
        />
        <Tile
          label={t(`${K}.tile.blocked`)}
          value={duration(t, a.totals.blockedHours)}
          note={blockedTakeaway(t, a)}
        />
        <Tile
          label={t(`${K}.tile.limits`)}
          value={String(a.totals.limitStops)}
          note={limitsTakeaway(t, a)}
        />
      </View>
      <ChartCard title={t(`${K}.chart.sessions`)} takeaway={sessionsTakeaway(t, a)}>
        <BarChart
          data={sessions}
          seriesLabels={[t(`${K}.series.started`), t(`${K}.series.finished`)]}
          describe={describeDay}
          hint={t(`${K}.hint`)}
          testID="insights-chart-sessions"
        />
      </ChartCard>
      <ChartCard title={t(`${K}.chart.blocked`)} takeaway={blockedTakeaway(t, a)}>
        <BarChart
          data={blocked}
          seriesLabels={[t(`${K}.series.blocked`)]}
          describe={describeBlocked}
          hint={t(`${K}.hint`)}
          testID="insights-chart-blocked"
        />
      </ChartCard>
      <ChartCard title={t(`${K}.chart.projects`)} takeaway={projectsTakeaway(t, a)}>
        <BarChart
          data={projects}
          seriesLabels={[t(`${K}.series.started`)]}
          describe={describeProject}
          hint={t(`${K}.hint`)}
          testID="insights-chart-projects"
        />
      </ChartCard>
      <Text style={styles.muted}>{t(`${K}.limits.finished`)}</Text>
    </View>
  );
}

function Tile(props: { label: string; value: string; note: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{props.value}</Text>
      <Text style={styles.muted}>{props.label}</Text>
      <Text style={styles.note}>{props.note}</Text>
    </View>
  );
}

function ChartCard(props: { title: string; takeaway: string; children: ReactElement }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{props.title}</Text>
      <Text style={styles.takeaway}>{props.takeaway}</Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    maxWidth: 1100,
    width: "100%",
    alignSelf: "center",
  },
  filters: { gap: theme.spacing[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipOn: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.borderAccent },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  sections: { gap: theme.spacing[3] },
  section: { gap: theme.spacing[3] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  note: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  tile: {
    flexGrow: 1,
    flexBasis: 220,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  tileValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  takeaway: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
