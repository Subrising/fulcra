import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useContract } from "./use-contract";
import { trackerViewRpc, integrationsRpc } from "../shared/cc/connectors";
import { Button, type Colors, type Theme } from "./organisation-ui";
import {
  buildLaunchpad,
  NO_FILTERS,
  type Launchpad,
  type LaunchAge,
  type LaunchFilters,
  type LaunchItem,
  type LaunchKind,
} from "./launchpad-model";
import { useRefreshTrackers } from "./tracker-refresh";
import { readSnoozed, snooze, snoozeChoices, unsnooze } from "./launchpad-snooze";
import { openTrackerUrl } from "./tracker-link";
import { ago } from "./today-model";

/**
 * G1 LaunchPad, inside Today's "Needs you": pull requests and issues across every mapped repo, waiting on you or on
 * others, with filters (repo, project, type, age) and quick actions (open on GitHub, open the linked conversation,
 * snooze). Reads only what the Tracking tab reads (same query keys, so no second poll); snooze is local to this
 * window's host. Approving is not offered: the tracker connection cannot approve.
 */
export const LAUNCHPAD_NOT_YET =
  "Review requests, requested changes and failing checks aren't shown yet: the tracker connection doesn't read them.";
const KIND: Record<LaunchKind, string> = { pr: "Pull request", issue: "Issue" };
const AGE: [LaunchAge, string][] = [
  ["any", "Any time"],
  ["day", "Today"],
  ["week", "This week"],
  ["older", "Older"],
];

function Chips<T extends string | null>({
  theme,
  label,
  value,
  options,
  onPick,
  testID,
}: {
  theme: Theme;
  label: string;
  value: T;
  options: [T, string][];
  onPick: (v: T) => void;
  testID: string;
}) {
  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "700",
          letterSpacing: 0.4,
          minWidth: 56,
        }}
      >
        {label.toUpperCase()}
      </Text>
      {options.map(([v, text]) => (
        <Button
          key={String(v)}
          theme={theme}
          testID={`${testID}-${v ?? "all"}`}
          label={`${label}: ${text}`}
          selected={v === value}
          onPress={() => onPick(v)}
        >
          <Text
            style={{
              color: v === value ? theme.colors.accentForeground : theme.colors.foreground,
              fontWeight: "600",
              fontSize: 13,
            }}
          >
            {text}
          </Text>
        </Button>
      ))}
    </View>
  );
}
function Act({
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
      style={{ minHeight: 32, justifyContent: "center" }}
    >
      <Text style={{ color: colors.accent, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
function LaunchRow({
  item,
  theme,
  now,
  agentOf,
  openAgent,
  onSnooze,
}: {
  item: LaunchItem;
  theme: Theme;
  now: number;
  agentOf: (sessionId: string) => string | null;
  openAgent?: (id: string) => void;
  onSnooze: (key: string, until: number) => void;
}) {
  const c = theme.colors,
    [choosing, setChoosing] = useState(false),
    agent = item.sessionId ? agentOf(item.sessionId) : null;
  return (
    <View
      testID={`launchpad-row-${item.key}`}
      style={{ gap: 4, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}
    >
      <Text
        style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.3 }}
      >{`${KIND[item.kind].toUpperCase()} · ${item.repo} ${item.ref}`}</Text>
      <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600", lineHeight: 21 }}>
        {item.title}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
        {[
          item.assignee
            ? item.mine
              ? "Assigned to you"
              : `Assigned to ${item.assignee}`
            : "Not assigned",
          item.state === "in-progress" ? "in progress" : null,
          `updated ${ago(item.updatedAt, now)}`,
          item.project,
          item.stale ? "not checked recently" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 18 }}>
        <Act
          colors={c}
          testID={`launchpad-open-${item.key}`}
          label={`Open on ${/github\.com/.test(item.url) ? "GitHub" : "the tracker"}`}
          onPress={() => {
            openTrackerUrl(item.url, undefined, item.site);
          }}
        />
        {agent && openAgent && (
          <Act
            colors={c}
            testID={`launchpad-session-${item.key}`}
            label="Open the conversation"
            onPress={() => openAgent(agent)}
          />
        )}
        <Act
          colors={c}
          testID={`launchpad-snooze-${item.key}`}
          label={choosing ? "Keep it here" : "Snooze"}
          onPress={() => setChoosing(!choosing)}
        />
      </View>
      {choosing && (
        <View
          testID={`launchpad-snooze-choices-${item.key}`}
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        >
          {snoozeChoices(now).map((ch) => (
            <Button
              key={ch.label}
              theme={theme}
              label={`Snooze ${ch.label.toLowerCase()}`}
              onPress={() => {
                setChoosing(false);
                onSnooze(item.key, ch.until);
              }}
            >
              <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>
                {ch.label}
              </Text>
            </Button>
          ))}
        </View>
      )}
    </View>
  );
}
function Group({
  title,
  items,
  empty,
  testID,
  ...row
}: { title: string; items: LaunchItem[]; empty: string; testID: string } & Omit<
  Parameters<typeof LaunchRow>[0],
  "item"
>) {
  const c = row.theme.colors,
    [all, setAll] = useState(false),
    shown = all ? items : items.slice(0, 6);
  return (
    <View
      testID={testID}
      style={{
        gap: 2,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 16, fontWeight: "700" }}
      >
        {title}
        <Text style={{ color: c.foregroundMuted, fontWeight: "500" }}>{`  ${items.length}`}</Text>
      </Text>
      {items.length ? (
        shown.map((i) => <LaunchRow key={i.key} item={i} {...row} />)
      ) : (
        <Text style={{ color: c.foregroundMuted, lineHeight: 20, paddingTop: 4 }}>{empty}</Text>
      )}
      {items.length > 6 && (
        <Act
          colors={c}
          label={all ? "Show fewer" : `Show ${items.length - 6} more`}
          onPress={() => setAll(!all)}
        />
      )}
    </View>
  );
}

/** The LaunchPad's reads and state, owned by Today so its "Needs you" counts include Waiting on you (M4). */
export function useLaunchpad({
  hostId,
  web,
  projects,
  filters: initial,
}: {
  hostId: string;
  web: boolean;
  projects: { id: string; name: string }[];
  filters?: LaunchFilters;
}) {
  const now = Date.now();
  const readView = useContract(trackerViewRpc),
    readIntegrations = useContract(integrationsRpc);
  // Same query keys as the Tracking tab: the LaunchPad adds no second poll and no tracker fetch of its own.
  const views = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["fulcra-tracker-view", hostId, p.id],
      queryFn: () => readView({ projectId: p.id }),
      refetchInterval: 60000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });
  const integrations = useQuery({
    queryKey: ["fulcra-integrations"],
    queryFn: () => readIntegrations({}),
    retry: false,
    staleTime: 15000,
  });
  const [filters, setFilters] = useState<LaunchFilters>(initial ?? NO_FILTERS); // kept per window
  const [snoozed, setSnoozed] = useState(() => readSnoozed(hostId, web));
  const [refreshing, setRefreshing] = useState(false);
  const refreshTrackers = useRefreshTrackers(hostId);
  const pad = useMemo(
    () =>
      buildLaunchpad({
        now,
        projects,
        filters,
        integrations: integrations.data,
        snoozedUntil: snoozed,
        views: Object.fromEntries(projects.map((p, k) => [p.id, views[k]?.data])),
        failed: projects.filter((_, k) => views[k]?.isError).map((p) => p.id),
      }),
    [now, projects, filters, integrations.data, snoozed, views],
  );
  const reading = views.some((v) => v.isPending && v.fetchStatus !== "idle");
  // M5: fetch and store every project's tracker items now (the L36 refresh RPC), then the views show them.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshTrackers(projects.map((p) => p.id));
    } finally {
      setRefreshing(false);
    }
  };
  return {
    pad,
    now,
    reading,
    refreshing,
    refresh,
    filters,
    setFilters,
    snoozed,
    setSnoozed,
    hostId,
    web,
  };
}
export type LaunchpadState = ReturnType<typeof useLaunchpad>;

const EMPTY: Record<Exclude<Launchpad["status"], "items">, string> = {
  "no-trackers":
    "No repos are linked to your projects yet, so there are no pull requests or issues to show.",
  "never-refreshed": "Pull requests and issues haven't been loaded yet.",
  empty: "No open pull requests or issues in your linked repos.",
};

const EMPTY_BOX = { gap: 8, alignItems: "flex-start" } as const;
/** M5: say plainly why nothing is listed, and offer the refresh that loads it (not needed when nothing is linked). */
function LaunchpadEmpty({ theme, lp }: { theme: Theme; lp: LaunchpadState }) {
  const c = theme.colors,
    status = lp.pad.status;
  if (lp.reading)
    return (
      <Text testID="launchpad-reading" style={{ color: c.foregroundMuted }}>
        Checking pull requests and issues…
      </Text>
    );
  if (status === "items") return null;
  return (
    <View testID={`launchpad-${status}`} style={EMPTY_BOX}>
      <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>{EMPTY[status]}</Text>
      {status !== "no-trackers" && (
        <Button
          theme={theme}
          testID="launchpad-refresh"
          label="Refresh pull requests and issues"
          onPress={lp.refresh}
        >
          <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>
            {lp.refreshing ? "Refreshing…" : "Refresh"}
          </Text>
        </Button>
      )}
    </View>
  );
}

export function LaunchpadSection({
  theme,
  lp,
  agentOf,
  openAgent,
}: {
  theme: Theme;
  lp: LaunchpadState;
  agentOf: (sessionId: string) => string | null;
  openAgent?: (id: string) => void;
}) {
  const c = theme.colors,
    { pad, now, filters, setFilters, snoozed, setSnoozed, hostId, web } = lp;
  const [showSnoozed, setShowSnoozed] = useState(false);
  if (!pad.total && !pad.snoozed.length && !pad.gaps.length)
    return <LaunchpadEmpty theme={theme} lp={lp} />;
  const set = (patch: Partial<LaunchFilters>) => setFilters({ ...filters, ...patch });
  const row = {
    theme,
    now,
    agentOf,
    openAgent,
    onSnooze: (key: string, until: number) => setSnoozed(snooze(hostId, web, key, until)),
  };
  const filtered = filters.repo || filters.project || filters.kind || filters.age !== "any";
  return (
    <View testID="launchpad" style={{ gap: 10 }}>
      <Text
        style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}
      >
        PULL REQUESTS AND ISSUES
      </Text>
      <View testID="launchpad-filters" style={{ gap: 6 }}>
        {pad.repos.length > 1 && (
          <Chips
            theme={theme}
            testID="launchpad-filter-repo"
            label="Repo"
            value={filters.repo}
            onPick={(repo) => set({ repo })}
            options={[
              [null, "All"],
              ...pad.repos.map((r) => [r, r.split("/").pop() ?? r] as [string, string]),
            ]}
          />
        )}
        {pad.projects.length > 1 && (
          <Chips
            theme={theme}
            testID="launchpad-filter-project"
            label="Project"
            value={filters.project}
            onPick={(project) => set({ project })}
            options={[
              [null, "All"],
              ...pad.projects.map((p) => [p.id, p.name] as [string, string]),
            ]}
          />
        )}
        {pad.kinds.length > 1 && (
          <Chips
            theme={theme}
            testID="launchpad-filter-kind"
            label="Type"
            value={filters.kind}
            onPick={(kind) => set({ kind })}
            options={[
              [null, "All"],
              ["pr", "Pull requests"],
              ["issue", "Issues"],
            ]}
          />
        )}
        <Chips
          theme={theme}
          testID="launchpad-filter-age"
          label="Updated"
          value={filters.age}
          onPick={(age) => set({ age })}
          options={AGE}
        />
        {filtered && (
          <Text
            testID="launchpad-filter-summary"
            style={{ color: c.foregroundMuted, fontSize: 13 }}
          >
            {`Showing ${pad.shown} of ${pad.total}. `}
            <Text
              style={{ color: c.accent, fontWeight: "600" }}
              onPress={() => setFilters(NO_FILTERS)}
            >
              Clear filters
            </Text>
          </Text>
        )}
      </View>
      <Group
        testID="launchpad-you"
        title="Waiting on you"
        items={pad.you}
        empty={
          filtered
            ? "Nothing here matches these filters."
            : pad.knowsYou
              ? "Nothing is assigned to you right now."
              : "Can't tell which of these are yours yet (see below)."
        }
        {...row}
      />
      <Group
        testID="launchpad-others"
        title="Waiting on others"
        items={pad.others}
        empty={filtered ? "Nothing here matches these filters." : "Nothing is waiting on others."}
        {...row}
      />
      {pad.snoozed.length > 0 && (
        <View testID="launchpad-snoozed" style={{ gap: 4 }}>
          <Act
            colors={c}
            testID="launchpad-snoozed-toggle"
            label={showSnoozed ? "Hide snoozed" : `${pad.snoozed.length} snoozed · Show`}
            onPress={() => setShowSnoozed(!showSnoozed)}
          />
          {showSnoozed &&
            pad.snoozed.map((i) => (
              <View
                key={i.key}
                testID={`launchpad-snoozed-${i.key}`}
                style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}
              >
                <Text
                  style={{ color: c.foregroundMuted, flexShrink: 1 }}
                >{`${i.repo} ${i.ref} · until ${new Date(snoozed[i.key]).toLocaleString("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" })}`}</Text>
                <Act
                  colors={c}
                  testID={`launchpad-wake-${i.key}`}
                  label="Bring it back"
                  onPress={() => setSnoozed(unsnooze(hostId, web, i.key))}
                />
              </View>
            ))}
        </View>
      )}
      {pad.gaps.map((g) => (
        <Text key={g} testID="launchpad-gap" style={{ color: c.statusWarning, lineHeight: 20 }}>
          {g}
        </Text>
      ))}
      <Text
        testID="launchpad-not-yet"
        style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}
      >
        {LAUNCHPAD_NOT_YET}
      </Text>
    </View>
  );
}
