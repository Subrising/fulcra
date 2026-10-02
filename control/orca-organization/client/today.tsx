import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { workMapRpc } from "../shared/work-map";
import { fleetRpc } from "../shared/fleet";
import { projectBriefRpc } from "../shared/cc/brief";
import { inboxRpc } from "../shared/cc/decision";
import { recoveryRpc } from "../shared/recovery";
import { OVERVIEW_POLL_MS } from "./work-map";
import { DecisionCard, HeldCard, viaFor } from "./inbox";
import { Button, Notice, Pill, type Colors, type Theme } from "./organisation-ui";
import {
  buildToday,
  healthWord,
  ago,
  type Today,
  type TodayItem,
  type TodayProject,
  type TodayStory,
} from "./today-model";
import { takeLastLook } from "./today-seen";
import { LaunchpadSection, useLaunchpad } from "./launchpad";

/**
 * Fulcra › Today: the front door. What finished since you last looked, what needs you (decisions, held
 * messages, stuck work with the reason), what is running, and each project's story, in plain words. Built only
 * from reads the other tabs already make; the only actions are the Inbox's own (choose, read, reply, release)
 * and opening a session or project. One column on a phone, two on a wide screen.
 */
export interface TodayNavigate {
  inbox: () => void;
  project: (projectId: string) => void;
  recovery: () => void;
}
const TONE = {
  "on-track": "success",
  "at-risk": "warning",
  blocked: "danger",
  idle: "muted",
} as const;

function Section({
  title,
  count,
  colors,
  children,
  testID,
  empty,
}: {
  title: string;
  count?: number;
  colors: Colors;
  children: ReactNode;
  testID: string;
  empty?: string | null;
}) {
  return (
    <View testID={testID} style={{ gap: 10 }}>
      <Text
        accessibilityRole="header"
        style={{ color: colors.foreground, fontSize: 19, fontWeight: "700" }}
      >
        {title}
        {count ? (
          <Text style={{ color: colors.foregroundMuted, fontWeight: "500" }}>{`  ${count}`}</Text>
        ) : null}
      </Text>
      {empty ? (
        <Text style={{ color: colors.foregroundMuted, lineHeight: 20 }}>{empty}</Text>
      ) : (
        children
      )}
    </View>
  );
}
function Card({
  colors,
  accent,
  children,
  testID,
}: {
  colors: Colors;
  accent?: string;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={{
        gap: 6,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        borderLeftWidth: accent ? 4 : 1,
        borderLeftColor: accent ?? colors.border,
      }}
    >
      {children}
    </View>
  );
}
function Link({
  colors,
  label,
  onPress,
  testID,
}: {
  colors: Colors;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: "center", alignSelf: "flex-start" }}
    >
      <Text style={{ color: colors.accent, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function NeedCard({
  item,
  stuck,
  theme,
  platform,
  go,
  openAgent,
  onChanged,
}: {
  item: TodayItem;
  stuck: boolean;
  theme: Theme;
  platform: string;
  go: TodayNavigate;
  openAgent?: (id: string) => void;
  onChanged: () => void;
}) {
  const c = theme.colors,
    [open, setOpen] = useState(false),
    a = item.action;
  const inline = a?.kind === "decision" || a?.kind === "held";
  return (
    <Card colors={c} accent={stuck ? c.statusWarning : c.accent} testID={`today-need-${item.key}`}>
      {item.project && (
        <Text
          style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}
        >
          {item.project.toUpperCase()}
        </Text>
      )}
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600", lineHeight: 22 }}>
        {stuck ? "Stuck · " : ""}
        {item.text}
      </Text>
      {item.detail && (
        <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>{item.detail}</Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {inline && (
          <Link
            colors={c}
            testID={`today-open-${item.key}`}
            label={open ? "Hide" : a.kind === "decision" ? "See the options and choose" : "Read it"}
            onPress={() => setOpen(!open)}
          />
        )}
        {a?.kind === "held-list" && (
          <Link colors={c} label="Open in the Inbox" onPress={go.inbox} />
        )}
        {a?.kind === "recovery" && (
          <Link colors={c} label="Review what stopped" onPress={go.recovery} />
        )}
        {a?.kind === "project" && (
          <Link colors={c} label="Open the project" onPress={() => go.project(a.projectId)} />
        )}
        {a?.kind === "session" && openAgent && (
          <Link colors={c} label="Open the conversation" onPress={() => openAgent(a.agentId)} />
        )}
      </View>
      {open && a?.kind === "decision" && (
        <DecisionCard id={a.id} theme={theme} via={viaFor(platform)} onChanged={onChanged} />
      )}
      {open && a?.kind === "held" && (
        <HeldCard
          channelId={a.channelId}
          messageId={a.messageId}
          theme={theme}
          onChanged={onChanged}
        />
      )}
    </Card>
  );
}
function Row({
  item,
  colors,
  mark,
  openAgent,
}: {
  item: TodayItem;
  colors: Colors;
  mark: string;
  openAgent?: (id: string) => void;
}) {
  const a = item.action,
    press = a?.kind === "session" && openAgent ? () => openAgent(a.agentId) : undefined;
  return (
    <Pressable
      testID={`today-row-${item.key}`}
      disabled={!press}
      onPress={press}
      accessibilityRole={press ? "button" : undefined}
      accessibilityLabel={`${item.text}. ${item.detail ?? ""}`}
      style={{ flexDirection: "row", gap: 10, paddingVertical: 6, minHeight: 40 }}
    >
      <Text
        style={{ color: colors.foregroundMuted, width: 16, textAlign: "center", lineHeight: 21 }}
      >
        {mark}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, lineHeight: 21 }}>{item.text}</Text>
        {item.detail && (
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{item.detail}</Text>
        )}
      </View>
    </Pressable>
  );
}
function ByProject({
  items,
  colors,
  mark,
  openAgent,
  limit = 4,
  testID,
}: {
  items: TodayItem[];
  colors: Colors;
  mark: string;
  openAgent?: (id: string) => void;
  limit?: number;
  testID: string;
}) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  const groups = [...new Set(items.map((i) => i.project ?? "Other"))];
  return (
    <View testID={testID} style={{ gap: 12 }}>
      {groups.map((g) => {
        const rows = items.filter((i) => (i.project ?? "Other") === g),
          shown = more[g] ? rows : rows.slice(0, limit);
        return (
          <Card key={g} colors={colors}>
            <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 15 }}>{g}</Text>
            {shown.map((i) => (
              <Row key={i.key} item={i} colors={colors} mark={mark} openAgent={openAgent} />
            ))}
            {rows.length > limit && (
              <Link
                colors={colors}
                label={more[g] ? "Show fewer" : `Show ${rows.length - limit} more`}
                onPress={() => setMore({ ...more, [g]: !more[g] })}
              />
            )}
          </Card>
        );
      })}
    </View>
  );
}
function StoryCard({ p, theme, go }: { p: TodayProject; theme: Theme; go: TodayNavigate }) {
  const c = theme.colors,
    s: TodayStory = p.story;
  return (
    <Card colors={c} testID={`today-story-${p.projectId}`}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "700", flexShrink: 1 }}>
          {p.name}
        </Text>
        <Pill colors={c} tone={TONE[s.health]}>
          {healthWord(s.health)}
        </Pill>
      </View>
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600", lineHeight: 22 }}>
        {s.headline}
      </Text>
      <Text style={{ color: c.foreground, lineHeight: 21 }}>{s.now}</Text>
      {s.next.length > 0 && (
        <View style={{ gap: 2 }}>
          <Text
            style={{
              color: c.foregroundMuted,
              fontSize: 12,
              fontWeight: "700",
              letterSpacing: 0.4,
            }}
          >
            WHAT'S NEEDED NEXT
          </Text>
          {s.next.slice(0, 4).map((n, i) => (
            <Text key={i} style={{ color: c.foreground, lineHeight: 21 }}>
              • {n}
            </Text>
          ))}
        </View>
      )}
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
        {p.lead} · {s.byline}
      </Text>
      <Link colors={c} label={`Open ${p.name}`} onPress={() => go.project(p.projectId)} />
    </Card>
  );
}

export function TodaySurface({
  theme,
  layout,
  host,
  navigation,
  go,
}: PluginSurfaceProps & { go: TodayNavigate }) {
  const c = theme.colors,
    compact = layout.compact,
    hostId = host?.id ?? "";
  const since = useMemo(
    () => takeLastLook(hostId, layout.platform === "web"),
    [hostId, layout.platform],
  );
  const readMap = useContract(workMapRpc),
    readFleet = useContract(fleetRpc),
    readBrief = useContract(projectBriefRpc),
    readInbox = useContract(inboxRpc),
    readRecovery = useRpc(recoveryRpc);
  const poll = { refetchIntervalInBackground: false, retry: false } as const;
  // Same query keys as the Organisation tab, the Inbox and the recovery banner, so Today adds no second poll of them.
  const map = useQuery({
    queryKey: ["orca-work-map", hostId],
    queryFn: () => readMap({}),
    refetchInterval: OVERVIEW_POLL_MS,
    ...poll,
  });
  const inbox = useQuery({
    queryKey: ["orca-organization", "inbox"],
    queryFn: () => readInbox({}),
    refetchInterval: 30000,
    ...poll,
  });
  const recovery = useQuery({
    queryKey: ["orca-recovery", hostId],
    queryFn: () => readRecovery({}),
    staleTime: 10000,
    refetchInterval: 30000,
    ...poll,
  });
  const ids = (map.data?.projects ?? []).map((p) => p.projectId);
  const active = new Set(
    (map.data?.projects ?? []).filter((p) => p.sessions > 0).map((p) => p.projectId),
  );
  const fleets = useQueries({
    queries: ids.map((projectId) => ({
      queryKey: ["orca-fleet", hostId, "project", projectId],
      queryFn: () => readFleet({ projectId }),
      enabled: active.has(projectId),
      refetchInterval: 30000,
      ...poll,
    })),
  });
  const briefs = useQueries({
    queries: ids.map((projectId) => ({
      queryKey: ["orca-organisation", hostId, "brief", projectId],
      queryFn: () => readBrief({ projectId }),
      refetchInterval: 60000,
      ...poll,
    })),
  });
  const now = Date.now();
  const today: Today = buildToday({
    now,
    since,
    map: map.data,
    fleets: Object.fromEntries(ids.map((id, k) => [id, fleets[k]?.data])),
    briefs: Object.fromEntries(ids.map((id, k) => [id, briefs[k]?.data])),
    inbox: inbox.data,
    inboxFailed: inbox.isError,
    recovery: recovery.data?.status === "observed" ? recovery.data.recovery : undefined,
  });
  const named = useMemo(
    () =>
      (map.data?.projects ?? []).map((p) => ({
        id: p.projectId,
        name: p.name ?? "Untitled project",
      })),
    [map.data],
  );
  const lp = useLaunchpad({ hostId, web: layout.platform === "web", projects: named });
  // M5: Refresh also fetches and stores the tracker items the LaunchPad lists (the L36 refresh), not only Today's reads.
  const refresh = () => {
    void map.refetch();
    void inbox.refetch();
    void recovery.refetch();
    fleets.forEach((f) => void f.refetch());
    briefs.forEach((b) => void b.refetch());
    void lp.refresh();
  };
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const reading = map.isPending || fleets.some((f) => f.isPending && f.fetchStatus !== "idle");
  const running = today.projects.flatMap((p) => p.running),
    waiting = today.projects.flatMap((p) => p.waiting.slice(0, 2));
  const sinceLine = today.firstLook
    ? "Here's the last day"
    : `Since you last looked, ${ago(today.since, now)}`;
  // M4: "Needs you" is one list: decisions, stuck work and the pull requests and issues waiting on you (unsnoozed).
  const needsYou = today.needs.length + today.blocked.length + lp.pad.youTotal;
  const counts = [
    [needsYou, "need you"],
    [running.length, "working"],
    [today.done.length, "finished"],
  ] as const;

  const done = (
    <Section
      testID="today-done"
      title={today.firstLook ? "Done in the last day" : "Done since you last looked"}
      count={today.done.length}
      colors={c}
      empty={
        today.done.length
          ? null
          : reading
            ? "Reading what finished…"
            : "Nothing new has finished since you last looked."
      }
    >
      <ByProject
        testID="today-done-list"
        items={today.done}
        colors={c}
        mark="✓"
        openAgent={openAgent}
      />
    </Section>
  );
  // G1 LaunchPad: pull requests and issues across every mapped repo sit under the decisions and stuck work, in the same
  // "Needs you" column (one list of what is waiting, not a second inbox).
  const agentOf = (sessionId: string) => {
    for (const f of fleets)
      for (const n of f.data?.nodes ?? []) if (n.id === sessionId) return n.agentId;
    return null;
  };
  const needs = (
    <View style={{ gap: 14 }}>
      <Section
        testID="today-needs"
        title="Needs you"
        count={needsYou}
        colors={c}
        empty={
          needsYou
            ? null
            : reading || lp.reading
              ? "Checking what needs you…"
              : "Nothing needs you right now."
        }
      >
        {today.blocked.map((i) => (
          <NeedCard
            key={i.key}
            item={i}
            stuck
            theme={theme}
            platform={layout.platform}
            go={go}
            openAgent={openAgent}
            onChanged={refresh}
          />
        ))}
        {today.needs.map((i) => (
          <NeedCard
            key={i.key}
            item={i}
            stuck={false}
            theme={theme}
            platform={layout.platform}
            go={go}
            openAgent={openAgent}
            onChanged={refresh}
          />
        ))}
      </Section>
      <LaunchpadSection theme={theme} lp={lp} agentOf={agentOf} openAgent={openAgent} />
    </View>
  );
  const now_ = (
    <Section
      testID="today-running"
      title="Running now and next"
      count={running.length}
      colors={c}
      empty={
        running.length + waiting.length
          ? null
          : reading
            ? "Reading what's running…"
            : "Nothing is running right now."
      }
    >
      <ByProject
        testID="today-running-list"
        items={[...running, ...waiting]}
        colors={c}
        mark="●"
        openAgent={openAgent}
        limit={5}
      />
    </Section>
  );
  const stories = (
    <Section
      testID="today-projects"
      title="Your projects"
      count={today.projects.length}
      colors={c}
      empty={today.projects.length ? null : reading ? "Reading your projects…" : "No projects yet."}
    >
      {today.projects.map((p) => (
        <StoryCard key={p.projectId} p={p} theme={theme} go={go} />
      ))}
    </Section>
  );

  return (
    <ScrollView
      testID="today"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: compact ? 14 : 24,
        gap: 20,
        maxWidth: 1280,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text
            accessibilityRole="header"
            style={{ color: c.foreground, fontSize: compact ? 28 : 32, fontWeight: "700", flex: 1 }}
          >
            Today
          </Text>
          <Button theme={theme} testID="today-refresh" label="Refresh" onPress={refresh}>
            <Text style={{ color: c.foreground, fontWeight: "600" }}>Refresh</Text>
          </Button>
        </View>
        <Text style={{ color: c.foregroundMuted }}>{sinceLine}</Text>
        <View
          testID="today-counts"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4 }}
        >
          {counts.map(([n, label]) => (
            <View
              key={label}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: c.surface2,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Text style={{ color: c.foreground, fontWeight: "600" }}>
                {n} {label}
              </Text>
            </View>
          ))}
        </View>
      </View>
      {today.gaps.map((g) => (
        <Notice key={g} colors={c} tone="warning" testID="today-gap">
          {g}
        </Notice>
      ))}
      {/* Needs you leads: it is the part that asks something of you, and on a phone it must not sit below a long list. */}
      {compact ? (
        <>
          {needs}
          {done}
          {now_}
          {stories}
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
          <View style={{ flex: 1, minWidth: 0, gap: 24 }}>
            {needs}
            {done}
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 24 }}>
            {now_}
            {stories}
          </View>
        </View>
      )}
    </ScrollView>
  );
}
