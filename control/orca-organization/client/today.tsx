import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import * as pluginClient from "@getpaseo/plugin/client";
import { EMPTY_NATIVE } from "./live-map-model";
import { freshness } from "./work-map-model";
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
  humanAttention,
  retainedTodayNeeds,
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
// COMPAT(observedOverview): added in the next development build, remove after 2027-02-01 when cached native observations are in the app floor.
const nativeApi = pluginClient as Partial<Pick<typeof pluginClient, "useObservedAgents">>;
const useObservedWork = nativeApi.useObservedAgents ?? (() => EMPTY_NATIVE);

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
  openAgent?: (id: string, serverId?: string) => void;
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
      {!(open && a?.kind === "decision") && (
        <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600", lineHeight: 22 }}>
          {stuck ? "Stuck · " : ""}
          {item.text}
        </Text>
      )}
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
          <Link
            colors={c}
            label="Open the conversation"
            onPress={() => openAgent(a.agentId, a.serverId)}
          />
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
  openAgent?: (id: string, serverId?: string) => void;
}) {
  const a = item.action,
    press = a?.kind === "session" && openAgent ? () => openAgent(a.agentId, a.serverId) : undefined;
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
  openAgent?: (id: string, serverId?: string) => void;
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
  const observedWork = useObservedWork();
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const inputs = {
    now,
    since,
    map: map.data,
    fleets: Object.fromEntries(ids.map((id, k) => [id, fleets[k]?.data])),
    briefs: Object.fromEntries(ids.map((id, k) => [id, briefs[k]?.data])),
    inbox: inbox.data,
    inboxFailed: inbox.isError,
    recovery: recovery.data?.status === "observed" ? recovery.data.recovery : undefined,
  };
  const today: Today = buildToday(inputs);
  const personal = humanAttention(inputs);
  const reportedDone = today.done.filter((item) => item.key.startsWith("shipped-"));
  const [allPersonal, setAllPersonal] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
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
  const openAgent = navigation?.openAgentOnHost
    ? (agentId: string, serverId?: string) => {
        if (serverId) navigation.openAgentOnHost!({ serverId, agentId });
      }
    : undefined;
  const reading = map.isPending || fleets.some((f) => f.isPending && f.fetchStatus !== "idle");
  const running = today.projects.flatMap((p) => p.running),
    waiting = today.projects.flatMap((p) => p.waiting.slice(0, 2));
  const sinceLine = today.firstLook
    ? "Here's the last day"
    : `Since you last looked, ${ago(today.since, now)}`;
  // M4: "Needs you" is one list: decisions, stuck work and the pull requests and issues waiting on you (unsnoozed).
  const retainedNeeds = retainedTodayNeeds(today.needs, personal.actions);
  const retainedBlocked = retainedTodayNeeds(today.blocked, personal.actions);
  const retainedActivityCount = retainedNeeds.length + retainedBlocked.length + lp.pad.youTotal;
  const counts = [
    [personal.actions.length, "confirmed actions"],
    [
      observedWork.entries.filter(
        (entry) =>
          entry.activity === "working" &&
          freshness(entry.observedAt ?? undefined, now, false, false) === "live",
      ).length,
      "observed model turns",
    ],
    [reportedDone.length, "reported completions"],
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
        title="Other updates"
        count={retainedActivityCount}
        colors={c}
        empty={
          retainedActivityCount
            ? null
            : reading || lp.reading
              ? "Reading other updates…"
              : "No other updates right now."
        }
      >
        {retainedBlocked.map((i) => (
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
        {retainedNeeds.map((i) => (
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
  const progress = (
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
            Home
          </Text>
          <Button theme={theme} testID="today-open-inbox" label="Open Inbox" onPress={go.inbox}>
            <Text style={{ color: c.foreground, fontWeight: "600" }}>Inbox</Text>
          </Button>
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
      <Text style={{ color: c.foregroundMuted }}>
        Source: {host?.label ?? "Selected company organisation"}. Home also includes permission
        requests, role needs and saved updates; Inbox counts Inbox items only.
        {inbox.data
          ? ` ${inbox.data.counts.held} held messages are kept for review; they are not counted as urgent just because they are held.`
          : " The Inbox could not be read."}
      </Text>
      {today.gaps.map((g) => (
        <Notice key={g} colors={c} tone="warning" testID="today-gap">
          {g}
        </Notice>
      ))}
      <Section
        testID="today-personal-actions"
        title="Needs you"
        count={personal.actions.length}
        colors={c}
      >
        {personal.actions.length === 0 && (
          <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>
            No confirmed unresolved human action in the available observations.
          </Text>
        )}
        {(allPersonal ? personal.actions : personal.actions.slice(0, 3)).map((item) => (
          <NeedCard
            key={item.key}
            item={item}
            stuck={false}
            theme={theme}
            platform={layout.platform}
            go={go}
            openAgent={openAgent}
            onChanged={refresh}
          />
        ))}
        {personal.actions.length > 3 && (
          <Link
            colors={c}
            label={allPersonal ? "Show fewer actions" : "Show all confirmed actions"}
            onPress={() => setAllPersonal((value) => !value)}
          />
        )}
        {personal.unknown && (
          <Text style={{ color: c.foregroundMuted }}>
            Some observations are unavailable or incomplete. Additional actions may be unknown.
          </Text>
        )}
      </Section>
      <Section
        testID="today-project-progress"
        title="Project progress and blockers"
        colors={c}
        count={today.projects.length}
      >
        {[...today.projects]
          .sort(
            (a, b) =>
              Number(b.story.written && b.story.health === "blocked") -
                Number(a.story.written && a.story.health === "blocked") ||
              a.name.localeCompare(b.name),
          )
          .slice(0, 5)
          .map((project) => (
            <View key={project.projectId} style={{ gap: 4 }}>
              <Text style={{ color: c.foreground }}>
                {project.name} · {project.lead}
              </Text>
              <Text style={{ color: c.foregroundMuted }}>
                {project.story.written ? project.story.headline : "No owner update published yet."}
                {project.blocked.length ? ` · ${project.blocked.length} recorded blockers` : ""}
              </Text>
              <Link
                colors={c}
                label={`Open ${project.name} work`}
                onPress={() => go.project(project.projectId)}
              />
            </View>
          ))}
        {today.projects.length > 5 && (
          <Link colors={c} label="All projects and work" onPress={() => setShowActivity(true)} />
        )}
      </Section>
      <Section
        testID="today-reported-completions"
        title="Reported completions since your last visit"
        colors={c}
        count={reportedDone.length}
        empty={
          reportedDone.length ? null : "No completion report recorded in this observed period."
        }
      >
        {reportedDone.slice(0, 3).map((item) => (
          <Row key={item.key} item={item} colors={c} mark="✓" openAgent={openAgent} />
        ))}
      </Section>
      <Button
        theme={theme}
        label={showActivity ? "Hide all activity and history" : "All activity and history"}
        onPress={() => setShowActivity((value) => !value)}
      />
      {showActivity && (
        <View style={{ gap: 20 }}>
          <Text style={{ color: c.foregroundMuted }}>
            Retained runtime status and reports are source observations; idle or closed
            conversations do not establish task acceptance.
          </Text>
          {needs}
          {done}
          {progress}
          {stories}
        </View>
      )}
    </ScrollView>
  );
}
