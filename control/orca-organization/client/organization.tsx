import { CleanupSurface } from "./worktree-lifecycle";
import { useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ManagementPanel } from "./management";
import { TaskControls, UsagePanel } from "./tasks";
import { snapshotRpc } from "../shared/organization";
import { OutcomePanel } from "./outcomes";
import { readSelectedTask, rememberSelectedTask } from "./selected-task";
import { FleetSurface } from "./fleet";
import { PortfolioSurface } from "./portfolio";
import { PrimeSurface } from "./prime";
import { OrganisationSurface } from "./organisation";
import { TrackingSurface } from "./tracking";
import { EnvironmentsSurface } from "./environments";
import type { RadiusScratchOwnerAdapter } from "../shared/radius-scratch";
import { RecoveryBanner } from "./recovery";
import { Details } from "./details";
import {
  MANAGE_TASK_KEY,
  ORGANISATION_VIEWS,
  PILLARS,
  SETTINGS_VIEWS,
  readyPillars,
  tabTestId,
  type OrganisationView,
  type PillarKey,
  type SettingsView,
} from "./tabs";
import { ChangesSurface } from "./changes";
import { AccountsSurface } from "./accounts";
import { InboxSurface } from "./inbox";
import { DevicesSurface } from "./devices";
import { ChannelsSurface } from "./channels";
import { TodaySurface } from "./today";
// J0-10: a date a person reads ("24 Sept, 20:50"), not an ISO timestamp. An unreadable value says so.
export const plainDate = (iso: string | null | undefined) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t)
    ? new Date(t).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "at an unknown time";
};
export function OrganizationSurface(
  props: PluginSurfaceProps & { radiusScratchOwner?: RadiusScratchOwnerAdapter },
) {
  // The tabs come from one registry (tabs.ts): only ready pillars are shown. Organisation opens on J1's
  // Organisation view (primes, projects, orchestrators and live work, with the work map one tap away as "Map"),
  // and holds Leadership and Workstreams beside it; Manage task is a detail sheet inside Organisation.
  // Settings holds Devices and Channels. J4's Integrations is a host settings screen (index.client.tsx), also
  // reachable from the Trackers tab. The recovery banner sits above every tab: it reports on the whole
  // installation, not on one tab.
  const [pillar, setPillar] = useState<PillarKey>("today"),
    [focus, setFocus] = useState<string | null>(null);
  const [view, setView] = useState<OrganisationView>("workmap"),
    [settings, setSettings] = useState<SettingsView>("devices");
  // J0-8: the sheet remembers the pillar it was opened from, so Back returns there (Sessions, not Organisation).
  const [sheetFrom, setSheetFrom] = useState<PillarKey | null>(null),
    sheet = sheetFrom !== null;
  const c = props.theme.colors;
  const onTask = (id: string) => {
    rememberSelectedTask(props.host?.id ?? "", props.layout.platform === "web", id);
    setSheetFrom(pillar);
    setPillar("organisation");
  };
  const closeSheet = () => {
    if (sheetFrom) setPillar(sheetFrom);
    setSheetFrom(null);
  };
  const tab = (
    key: string,
    label: string,
    selected: boolean,
    onPress: () => void,
    legacyKey: string | null = null,
    size = 16,
  ) => (
    <Pressable
      key={key}
      testID={tabTestId(key)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
    >
      <View testID={legacyKey ? tabTestId(legacyKey) : undefined}>
        <Text
          style={{
            color: selected ? c.foreground : c.foregroundMuted,
            fontSize: size,
            fontWeight: selected ? "700" : "400",
          }}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
  const go = {
    inbox: () => {
      setPillar("inbox");
      setSheetFrom(null);
    },
    recovery: () => {
      setPillar("sessions");
      setSheetFrom(null);
    },
    project: (id: string) => {
      setFocus(id);
      setView("workmap");
      setSheetFrom(null);
      setPillar("organisation");
    },
  };
  const body =
    pillar === "today" ? (
      <TodaySurface {...props} go={go} />
    ) : pillar === "sessions" ? (
      <FleetSurface {...props} onTask={onTask} />
    ) : pillar === "trackers" ? (
      <TrackingSurface theme={props.theme} layout={props.layout} host={props.host} />
    ) : pillar === "changes" ? (
      <ChangesSurface {...props} />
    ) : pillar === "inbox" ? (
      <InboxSurface theme={props.theme} layout={props.layout} />
    ) : pillar === "environments" ? (
      <EnvironmentsSurface
        theme={props.theme}
        layout={props.layout}
        host={props.host}
        radiusScratchOwner={props.radiusScratchOwner}
      />
    ) : pillar === "settings" ? (
      settings === "accounts" ? (
        <AccountsSurface theme={props.theme} layout={props.layout} host={props.host} />
      ) : settings === "cleanup" ? (
        <CleanupSurface theme={props.theme} layout={props.layout} />
      ) : settings === "channels" ? (
        <ChannelsSurface theme={props.theme} layout={props.layout} />
      ) : (
        <DevicesSurface theme={props.theme} layout={props.layout} />
      )
    ) : sheet ? (
      <TaskSurface {...props} />
    ) : view === "leadership" ? (
      <PrimeSurface {...props} onTask={onTask} />
    ) : view === "portfolio" ? (
      <PortfolioSurface {...props} onTask={onTask} />
    ) : (
      <OrganisationSurface key={focus ?? "all"} {...props} initialProject={focus} />
    );
  const subStrip = {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 16,
    borderBottomWidth: 1,
    borderColor: c.border,
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      {/* Today says the same thing in plain words ("the computer restarted …") and links here. */}
      {pillar !== "today" && (
        <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
          <RecoveryBanner theme={props.theme} navigation={props.navigation} host={props.host} />
        </View>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", padding: 12, gap: 20 }}>
        {readyPillars().map((p) =>
          tab(
            p.key,
            p.label,
            pillar === p.key,
            () => {
              setPillar(p.key);
              setSheetFrom(null);
            },
            p.legacyKey,
            17,
          ),
        )}
      </View>
      {pillar === "organisation" && (
        <View style={subStrip}>
          {/* J0-8: while the sheet is open, Back returns to where it was opened from, the views stay one tap away, and
          the Manage task id stays on the strip, selected. */}
          {sheet && (
            <Pressable
              testID="organization-sheet-back"
              accessibilityRole="button"
              accessibilityLabel={`Back to ${PILLARS.find((p) => p.key === sheetFrom)?.label ?? "Organisation"}`}
              onPress={closeSheet}
            >
              <Text style={{ color: c.foreground, fontSize: 15 }}>‹ Back</Text>
            </Pressable>
          )}
          {ORGANISATION_VIEWS.map((v) =>
            tab(
              v.key,
              v.label,
              !sheet && view === v.key,
              () => {
                setView(v.key);
                setSheetFrom(null);
              },
              null,
              15,
            ),
          )}
          {tab(
            MANAGE_TASK_KEY,
            "Manage task",
            sheet,
            () => {
              if (!sheet) setSheetFrom("organisation");
            },
            null,
            15,
          )}
        </View>
      )}
      {pillar === "settings" && (
        <View style={subStrip}>
          {SETTINGS_VIEWS.map((v) =>
            tab(v.key, v.label, settings === v.key, () => setSettings(v.key), null, 15),
          )}
        </View>
      )}
      {body}
    </View>
  );
}
export function TaskSurface({ theme, layout, navigation, host }: PluginSurfaceProps) {
  const hostId = host?.id ?? "",
    web = layout.platform === "web";
  const [selection, setSelection] = useState(() => ({
    hostId,
    taskId: readSelectedTask(hostId, web),
  }));
  const taskId = selection.hostId === hostId ? selection.taskId : readSelectedTask(hostId, web);
  const setTaskId = (id: string) => {
    rememberSelectedTask(hostId, web, id);
    setSelection({ hostId, taskId: id });
  };
  const read = useContract(snapshotRpc);
  const query = useQuery({
    queryKey: ["orca-organization", hostId, taskId],
    queryFn: () => read({ taskId }),
    enabled: !!taskId,
    staleTime: 10000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const d = query.data,
    colors = theme.colors;
  const text = { color: colors.foreground },
    muted = { color: colors.foregroundMuted };
  const button = { padding: 12, borderRadius: 8, backgroundColor: colors.accent };
  const stale = !d || query.isError || Date.now() - Date.parse(d.observedAt) > 60000;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <Text style={{ ...text, fontSize: 26, fontWeight: "600" }}>Manage task</Text>
      <Text style={muted}>Who is accountable for this task, and the sessions working on it.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh this task"
        disabled={!taskId}
        style={button}
        onPress={() => {
          if (taskId) void query.refetch();
        }}
      >
        <Text style={{ color: colors.accentForeground }}>
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </Text>
      </Pressable>
      {query.isError && (
        <Text style={text}>
          Fulcra is not answering right now. Anything below may be out of date.
        </Text>
      )}
      {!d && (
        <Text style={text}>
          {!taskId
            ? "Choose a task below to see its sessions."
            : query.isPending
              ? "Reading this task and its sessions…"
              : "Nothing to show yet."}
        </Text>
      )}
      {d && (
        <>
          <Text style={muted}>
            {stale ? "May be out of date" : "Up to date"} · checked {plainDate(d.observedAt)}
          </Text>
          <View
            style={{
              gap: 8,
              padding: 16,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 12,
            }}
          >
            <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>
              {d.board.identifier} · {d.board.title ?? "Task authority unavailable"}
            </Text>
            <Text style={text}>
              Status: {d.board.status?.replaceAll("_", " ") ?? "not recorded"} · Owner:{" "}
              {d.board.owner === "local-board" ? "you" : (d.board.owner ?? "not recorded")}
            </Text>
            {d.board.error && <Text style={text}>{d.board.error}</Text>}
            <Text style={muted}>
              A quiet session or a saved file does not mean the task is accepted.
            </Text>
          </View>
          <ManagementPanel
            key={`${hostId}:${taskId}`}
            taskId={taskId}
            theme={theme}
            navigation={navigation}
            host={host}
            titles={Object.fromEntries(d.sessions.map((s) => [s.id, s.title]))}
          />
          <OutcomePanel
            key={`outcome:${taskId}`}
            taskId={taskId}
            theme={theme}
            navigation={navigation}
          />
          <Text style={muted}>Sessions saved for this task. {d.coverage}</Text>
          {d.sessionsAvailable && d.sessions.length === 0 && (
            <Text style={text}>
              No saved sessions are enrolled for this task. Create one in Manage work, or choose
              another task.
            </Text>
          )}
          {d.sessions.map((s) => (
            <View
              key={s.id}
              style={{
                padding: 16,
                gap: 8,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
              }}
            >
              <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>{s.title}</Text>
              <Text style={text}>
                {s.provider} · {s.model ?? "model not recorded"}
              </Text>
              <Text style={text}>
                {s.status}
                {s.pending ? ` · waiting for your permission (${s.pending})` : ""}
              </Text>
              <Text style={muted}>Last active {plainDate(s.updatedAt)}</Text>
              {s.error && <Text style={text}>Error: {s.error}</Text>}
              {s.artifacts.length === 0 && <Text style={muted}>No saved files recorded.</Text>}
              {s.artifacts.map((a) => (
                <Text key={a.name} style={text}>
                  {a.name} · {a.state}
                </Text>
              ))}
              <Details theme={theme}>
                <Text selectable style={muted}>
                  Session {s.id}
                </Text>
                <Text selectable style={muted}>
                  Native session: {s.nativeId ?? "not yet available"}
                </Text>
                {s.artifacts
                  .filter((a) => a.sha256)
                  .map((a) => (
                    <Text key={a.name} selectable style={muted}>
                      {a.name}: {a.sha256}
                    </Text>
                  ))}
              </Details>
              {navigation && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${s.title}`}
                  style={button}
                  onPress={() => navigation.openAgent({ agentId: s.id })}
                >
                  <Text style={{ color: colors.accentForeground }}>
                    Open conversation and tools
                  </Text>
                </Pressable>
              )}
            </View>
          ))}
          <Text style={muted}>{d.remote}</Text>
          <Text style={muted}>
            You can manage only the sessions saved for this task. Accepting the task is recorded
            separately.
          </Text>
        </>
      )}
      <TaskControls theme={theme} selected={taskId} onSelect={setTaskId} />
      <UsagePanel theme={theme} />
    </ScrollView>
  );
}
