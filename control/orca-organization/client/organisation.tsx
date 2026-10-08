import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { workMapProjectRpc, workMapRpc } from "../shared/work-map";
import { fleetRpc } from "../shared/fleet";
import { remitsRpc } from "../shared/cc/remit";
import {
  buildTree,
  orchestratorLine,
  sessionsLine,
  relativeTime,
  type TreeProject,
} from "./organisation-model";
import { OriginalConversation } from "./original-conversation";
import { WorkButton } from "./work-button";
import { ProjectSessions } from "./project-sessions";
import { ProjectStory } from "./organisation-story";
import { RemitSheet } from "./organisation-remit";
import { Button, Notice, SectionTitle, type Theme } from "./organisation-ui";
import { WorkMapSurface, OVERVIEW_POLL_MS } from "./work-map";

/**
 * Fulcra › Organisation (J1; CC-PLAN §5). Your primes, each with its remit in one line, then their projects, each
 * project's orchestrator and how many of its sessions are working. Tap a project for its story. On a wide screen
 * the existing work map stays one tap away as "Map". Reads only; the one write is "Change main assistant", which goes to
 * the controller with a reason and is refused there unless it comes through the app.
 */
function ProjectRow({
  p,
  theme,
  selected,
  onPress,
}: {
  p: TreeProject;
  theme: Theme;
  selected: boolean;
  onPress: () => void;
}) {
  const c = theme.colors;
  return (
    <Pressable
      testID={`org-project-${p.projectId}`}
      accessibilityRole="button"
      accessibilityLabel={`${p.name}. ${orchestratorLine(p.orchestrator)}. ${sessionsLine(p)}.`}
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={onPress}
      style={{
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: selected ? c.surface2 : c.surface0,
        gap: 2,
      }}
    >
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{p.name}</Text>
      <Text style={{ color: c.foregroundMuted }}>{orchestratorLine(p.orchestrator)}</Text>
      <Text style={{ color: p.running ? c.statusSuccess : c.foregroundMuted, fontWeight: "500" }}>
        {p.running ? "● " : "○ "}
        {sessionsLine(p)}
      </Text>
    </Pressable>
  );
}

export function OrganisationSurface(
  props: PluginSurfaceProps & {
    initialProject?: string | null;
    initialMode?: "tree" | "map";
    onTask?: (id: string) => void;
  },
) {
  const { theme, layout } = props,
    c = theme.colors,
    compact = layout.compact,
    hostId = props.host?.id;
  const readMap = useContract(workMapRpc),
    readProject = useContract(workMapProjectRpc),
    readFleet = useContract(fleetRpc),
    readRemits = useContract(remitsRpc);
  // The same query keys the work map and Live work use, so this view adds no second poll of the same read.
  const map = useQuery({
    queryKey: ["orca-work-map", hostId],
    queryFn: () => readMap({}),
    refetchInterval: OVERVIEW_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const fleet = useQuery({
    queryKey: ["orca-fleet", hostId],
    queryFn: () => readFleet({}),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const remits = useQuery({
    queryKey: ["orca-organisation", hostId, "remits"],
    queryFn: () => readRemits({}),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const scroll = useRef<ScrollView>(null);
  const [view, setView] = useState<"tree" | "map">(props.initialMode ?? "tree");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<string | null>(props.initialProject ?? null),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [chosen]);
  const tree = buildTree(map.data, remits.data, fleet.data);
  const all = [...tree.primes.flatMap((p) => p.projects), ...tree.unassigned];
  const project = all.find((p) => p.projectId === chosen) ?? null;
  const board = useQuery({
    queryKey: ["orca-work-map-project", hostId, chosen],
    queryFn: () => readProject({ projectId: chosen! }),
    enabled: !!chosen,
    retry: false,
  });
  const leaders = project?.orchestrator.sessionId
    ? (fleet.data?.nodes.filter((node) => node.id === project.orchestrator.sessionId) ?? [])
    : [];
  const leader = leaders.length === 1 ? leaders[0] : null;
  const pick = (id: string) => {
    setChosen(chosen === id && !compact ? null : id);
    setEditing(false);
  };

  const toggle = (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button
        theme={theme}
        testID="org-view-tree"
        label="Show the organisation as a list"
        selected={view === "tree"}
        onPress={() => setView("tree")}
      >
        <Text style={{ color: c.foreground, fontWeight: view === "tree" ? "700" : "500" }}>
          Organisation
        </Text>
      </Button>
      <Button
        theme={theme}
        testID="org-view-map"
        label="Show team workflow"
        selected={view === "map"}
        onPress={() => setView("map")}
      >
        <Text style={{ color: c.foreground, fontWeight: view === "map" ? "700" : "500" }}>
          Team workflow
        </Text>
      </Button>
    </View>
  );
  if (view === "map")
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0 }}>
        <View style={{ paddingHorizontal: 24, paddingTop: 12 }}>{toggle}</View>
        <Text style={{ paddingHorizontal: 24, paddingVertical: 12, color: c.foregroundMuted }}>
          Team workflow shows project leadership and working sessions. Code architecture and change
          impact are separate views in the project’s workspace.
        </Text>
        <WorkMapSurface {...props} fleet={fleet.data} remits={remits.data} />
      </View>
    );

  const story = project && (
    <View style={{ gap: 14 }}>
      {compact && (
        <Button
          theme={theme}
          testID="org-back"
          label="Back to the organisation"
          onPress={() => {
            setChosen(null);
            setEditing(false);
          }}
        >
          <Text style={{ color: c.foreground, fontWeight: "600" }}>‹ All projects</Text>
        </Button>
      )}
      {leader && (
        <OriginalConversation
          {...props}
          targetHost={leader.host}
          targetServerId={leader.serverId}
          agentId={leader.agentId}
          label={`Talk to project lead: ${leader.title}`}
        />
      )}
      <View style={{ gap: 8 }} testID="org-project-board">
        <SectionTitle colors={c}>Project board and tasks</SectionTitle>
        {!board.data && (
          <Text style={{ color: c.foregroundMuted }}>
            {board.isPending
              ? "Reading this project's recorded board…"
              : "The project board is unavailable; no tasks were inferred."}
          </Text>
        )}
        {board.data?.workstreams.map((workstream) => {
          const issue = board.data.issues.issues.find(
            (entry) => entry.relation === "is" && entry.linkedTo.scopeId === workstream.taskId,
          );
          return (
            <WorkButton
              key={workstream.taskId}
              theme={theme}
              label={
                issue
                  ? `${issue.key} · ${issue.title} · ${issue.state}`
                  : "Recorded project task · no linked board title"
              }
              disabled={!props.onTask}
              onPress={() => props.onTask?.(workstream.taskId)}
            />
          );
        })}
        {board.data?.available && !board.data.workstreams.length && (
          <Text style={{ color: c.foregroundMuted }}>
            No recorded project tasks in this observation.
          </Text>
        )}
        {board.data?.membership?.partial && (
          <Text style={{ color: c.foregroundMuted }}>
            Project membership is partial. This view cannot establish that the board is complete.
          </Text>
        )}
      </View>
      <ProjectStory
        key={project.projectId}
        projectId={project.projectId}
        name={project.name}
        owner={project.owner}
        theme={theme}
        compact={compact}
        hostId={hostId}
        onEditRemit={() => setEditing(!editing)}
      />
      <ProjectSessions
        key={`sessions-${project.projectId}`}
        {...props}
        projectId={project.projectId}
      />
      {editing && (
        <RemitSheet
          key={`remit-${project.projectId}`}
          project={project}
          remits={remits.data}
          theme={theme}
          onClose={() => setEditing(false)}
          onChanged={() => {
            void remits.refetch();
          }}
        />
      )}
    </View>
  );
  if (compact && story)
    return (
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: c.surface0 }}
        contentContainerStyle={{ padding: 14, gap: 14 }}
      >
        {story}
      </ScrollView>
    );

  const observedAt = map.data?.observedAt;
  const treeList = (
    <View testID="org-tree" style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: compact ? 26 : 30, fontWeight: "700" }}
        >
          Organisation
        </Text>
        <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>
          Your main assistants, the projects each one owns, and who is running them. Tap a project
          for its story.
        </Text>
        {observedAt && (
          <Text style={{ color: c.foregroundMuted }}>Checked {relativeTime(observedAt)}</Text>
        )}
      </View>
      {(map.isError || remits.data?.stale) && (
        <Notice colors={c} tone="warning">
          May be out of date: the latest could not be read. What you see is the last saved view.
        </Notice>
      )}
      {!map.data && !remits.data && (
        <Text style={{ color: c.foreground }}>
          {map.isPending
            ? "Reading your organisation…"
            : "Your organisation could not be read. Try again in a moment."}
        </Text>
      )}
      {remits.data && !tree.ownersKnown && (
        <Notice colors={c} tone="warning">
          Which prime owns which project could not be read, so every project is listed under "No
          prime yet" for now.
        </Notice>
      )}
      {(map.data || remits.data) && !tree.primes.length && (
        <Text style={{ color: c.foreground }}>
          No main assistant is recorded yet. Record one in Leadership.
        </Text>
      )}
      {tree.primes.map((p) => {
        const open = !collapsed[p.seat];
        return (
          <View
            key={p.seat}
            testID={`org-prime-${p.seat}`}
            style={{
              gap: 10,
              padding: compact ? 12 : 16,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c.surface1,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${p.name}. ${p.remitLine}. ${open ? "Hide" : "Show"} its projects.`}
              accessibilityState={{ expanded: open }}
              aria-expanded={open}
              onPress={() => setCollapsed({ ...collapsed, [p.seat]: open })}
              style={{ gap: 3, minHeight: 44 }}
            >
              <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "700" }}>
                {open ? "▾" : "▸"} {p.name}
              </Text>
              <Text style={{ color: c.foreground }}>{p.remitLine}</Text>
              <Text style={{ color: c.foregroundMuted }}>
                {p.filled
                  ? p.holder
                    ? `Led by ${p.holder}`
                    : "Role filled"
                  : "No one is in this role"}
              </Text>
            </Pressable>
            {open &&
              (p.projects.length ? (
                p.projects.map((x) => (
                  <ProjectRow
                    key={x.projectId}
                    p={x}
                    theme={theme}
                    selected={chosen === x.projectId}
                    onPress={() => pick(x.projectId)}
                  />
                ))
              ) : (
                <Text style={{ color: c.foregroundMuted }}>
                  Give it a project from the project's story.
                </Text>
              ))}
          </View>
        );
      })}
      {tree.unassigned.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle
            colors={c}
          >{`No main assistant yet · ${tree.unassigned.length}`}</SectionTitle>
          {tree.unassigned.map((x) => (
            <ProjectRow
              key={x.projectId}
              p={x}
              theme={theme}
              selected={chosen === x.projectId}
              onPress={() => pick(x.projectId)}
            />
          ))}
        </View>
      )}
    </View>
  );
  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: compact ? 14 : 24, gap: 14 }}
    >
      {toggle}
      {compact ? (
        treeList
      ) : (
        <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
          <View style={{ flexBasis: 420, flexGrow: 0, flexShrink: 1 }}>{treeList}</View>
          <View style={{ flex: 1, minWidth: 0 }}>
            {story || (
              <Text style={{ color: c.foregroundMuted, paddingTop: 12 }}>
                Choose a project to read what is happening now, what is next, what needs you and the
                risks.
              </Text>
            )}
          </View>
        </View>
      )}
    </ScrollView>
  );
}
