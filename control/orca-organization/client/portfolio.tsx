import { quotaLabel, quotaIsStale } from "./quota-wait";
import { workName as name, sessionName, sessionStatus } from "./work-labels";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { fleetRpc } from "../shared/fleet";
import { Activity } from "./fleet";
import { WorkBrief } from "./work-brief";
import { WorkButton } from "./work-button";
import { OriginalConversation } from "./original-conversation";
import { projectsRpc } from "../shared/projects";
import { ProjectPicker, projectTaskIds, UNGROUPED } from "./projects";
import { ProjectBriefing } from "./briefing";
import { lastGood } from "./last-good";

export function PortfolioSurface(props: PluginSurfaceProps & { onTask: (id: string) => void }) {
  const read = useContract(fleetRpc),
    c = props.theme.colors;
  const [selected, setSelected] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string | null>(null),
    [limit, setLimit] = useState(8),
    [now, setNow] = useState(Date.now());
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [project, setProject] = useState<string | null>(null),
    readProjects = useContract(projectsRpc);
  const directory = useQuery({
    queryKey: ["orca-projects", props.host?.id],
    queryFn: () => readProjects({}),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  // J0: stalled reads keep their last good result (memory only).
  const directoryData = lastGood(directory, ["orca-projects", props.host?.id], { now }).data;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["orca-fleet", props.host?.id],
    queryFn: () => read({}),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const last = lastGood(query, ["orca-fleet", props.host?.id], { now });
  const d = last.data,
    age = now - Date.parse(d?.observedAt ?? ""),
    stale = query.isError || last.fromMemory || !Number.isFinite(age) || age > 45000 || age < -5000;
  const chosen = d?.nodes.find((n) => n.id === selected),
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const roles = d?.supervisors ?? [];
  const membership = projectTaskIds(directoryData),
    projectAge = now - Date.parse(directoryData?.observedAt ?? "");
  const projectStale =
    directory.isError ||
    !directoryData?.available ||
    !Number.isFinite(projectAge) ||
    projectAge > 45000 ||
    projectAge < -5000;
  const scoped =
    d?.tasks.filter(
      (t) =>
        project === null ||
        (project === UNGROUPED ? !membership.get(t.id) : membership.get(t.id) === project),
    ) ?? [];
  const top = roles.filter(
    (role) =>
      !roles.some(
        (parent) =>
          parent.id !== role.id &&
          parent.workers.some((w) => w.workerId === role.id && w.ownership === "linked"),
      ),
  );
  const roleKnown = d?.supervisionAvailable === true;
  const led = scoped.filter((task) => roles.some((role) => role.task === task.id));
  const unassigned = scoped.filter((task) => !roles.some((role) => role.task === task.id));
  const shown = roleKnown ? led : scoped,
    leaderCount = top.filter((role) => scoped.some((t) => t.id === role.task)).length;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: props.layout.compact ? 16 : 28, gap: 20 }}
    >
      {chosen ? (
        <>
          <WorkButton
            theme={props.theme}
            label="Back to orchestrators"
            onPress={() => setSelected(null)}
          />
          <Activity
            key={`${props.host?.id}:${chosen.id}`}
            {...props}
            node={chosen}
            fleet={d}
            frozen={false}
            quotaStale={stale}
          />
          <WorkBrief
            taskId={chosen.task}
            theme={props.theme}
            host={props.host}
            frozen={false}
            onTask={props.onTask}
          />
        </>
      ) : (
        <>
          <View style={{ gap: 8 }}>
            <Text style={{ ...muted, letterSpacing: 1, fontSize: 12 }}>FULCRA / LEADERSHIP</Text>
            <Text style={{ ...text, fontSize: 30, fontWeight: "600" }}>Your orchestrators</Text>
            <Text style={{ ...muted, fontSize: 16, lineHeight: 24 }}>
              Who is leading. What needs you. Where the work goes next.
            </Text>
          </View>
          <ProjectPicker
            theme={props.theme}
            directory={directoryData}
            tasks={d?.tasks ?? []}
            selected={project}
            stale={projectStale}
            onSelect={(id) => {
              setProject(id);
              setLimit(8);
              setExpanded(null);
              setShowUnassigned(id !== null);
            }}
          />
          <ProjectBriefing
            key={`${props.host?.id}:${project}`}
            {...props}
            project={project}
            now={now}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            <Text style={text}>
              {roleKnown ? leaderCount : "—"} recorded {leaderCount === 1 ? "leader" : "leaders"}
            </Text>
            <Text style={muted}>Claude, Codex and their saved teams</Text>
          </View>
          <Text style={muted}>
            Choose a project to see its saved leaders and work. Activity and control are shown for
            each leader.
          </Text>
          <WorkButton
            theme={props.theme}
            label="Refresh orchestrators"
            onPress={() => {
              void query.refetch();
              void directory.refetch();
            }}
          >
            Refresh
          </WorkButton>
          {project && directoryData?.available && !scoped.length && (
            <Text style={text}>
              No recorded work is linked to this project in the current observation. No leader or
              active work is inferred.
            </Text>
          )}
          {stale && (
            <Text accessibilityLiveRegion="polite" style={text}>
              {d
                ? (last.notice ?? "This view may be out of date. Fulcra is checking again.")
                : query.isPending
                  ? "Finding your orchestrators…"
                  : "Fulcra is not answering yet; retrying."}
            </Text>
          )}
          {d?.partial && (
            <Text style={muted}>
              Some work or team members could not be observed. This view is incomplete.
            </Text>
          )}
          {d && !roleKnown && (
            <Text style={text}>
              Leadership records are unavailable. Session names and graph connections are not enough
              to identify a leader.
            </Text>
          )}
          {selected && !chosen && (
            <Text style={text}>
              That conversation is no longer in the current observation. Its history has not been
              deleted.
            </Text>
          )}
          {shown.slice(0, limit).map((task) => {
            const leaders = top.filter((s) => s.task === task.id),
              allRoles = roles.filter((s) => s.task === task.id),
              nodes = d?.nodes.filter((n) => n.task === task.id) ?? [];
            return (
              <View
                key={task.id}
                style={{
                  padding: 20,
                  gap: 16,
                  borderRadius: 20,
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: c.surface1 ?? c.surface0,
                }}
              >
                <Text style={{ ...muted, fontSize: 12 }}>
                  RESPONSIBLE FOR{task.identifier ? ` · ${task.identifier}` : ""}
                </Text>
                <Text style={{ ...text, fontSize: 22, lineHeight: 29, fontWeight: "600" }}>
                  {name(task.title)}
                </Text>
                {roleKnown && !leaders.length && (
                  <Text style={text}>
                    {allRoles.length
                      ? "Leadership relationships need attention; no top-level owner can be established."
                      : "No orchestrator is recorded for this workstream."}
                  </Text>
                )}
                {leaders.map((role) => {
                  const node = nodes.find((n) => n.id === role.id);
                  if (!node) return null;
                  return (
                    <View
                      key={role.id}
                      style={{
                        gap: 12,
                        padding: 16,
                        borderRadius: 16,
                        backgroundColor: c.surface0,
                      }}
                    >
                      <Text style={{ ...muted, fontSize: 12 }}>LEAD ORCHESTRATOR</Text>
                      <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>
                        {sessionName(node, d)}
                      </Text>
                      <Text style={muted}>
                        {node.provider === "claude"
                          ? "Claude"
                          : node.provider === "codex"
                            ? "Codex"
                            : node.provider}
                        {node.model ? ` · ${node.model}` : ""}
                        {node.effort ? ` · effort ${node.effort}` : ""} · {node.host}
                      </Text>
                      <Text style={text}>{sessionStatus(node, stale)}</Text>
                      {node.quotaWait && (
                        <Text style={text}>
                          {stale || quotaIsStale(node.quotaObservedAt) ? "Last recorded: " : ""}
                          {quotaLabel(node.quotaWait)}
                        </Text>
                      )}
                      <Text style={muted}>
                        {node.mode === "human"
                          ? "You have control. This saved leader is not currently delegated."
                          : role.active
                            ? "Delegation recorded. Native activity is shown separately above."
                            : "Delegation suspended. Review control before continuing."}
                      </Text>
                      <OriginalConversation
                        theme={props.theme}
                        host={props.host}
                        navigation={props.navigation}
                        targetHost={node.host}
                        targetServerId={node.serverId}
                        agentId={node.agentId}
                        label={`Talk to ${sessionName(node, d)}`}
                      />
                      <WorkButton
                        theme={props.theme}
                        label={`Read updates from ${sessionName(node, d)}`}
                        onPress={() => setSelected(node.id)}
                      >
                        Read latest updates
                      </WorkButton>
                      <Text style={{ ...text, fontWeight: "600" }}>
                        Saved team · {role.workers.length}
                      </Text>
                      {!role.workers.length && (
                        <Text style={muted}>
                          No workers recorded yet. This orchestrator can still lead the work.
                        </Text>
                      )}
                      {role.workers.map((worker) => {
                        const member = nodes.find((n) => n.id === worker.workerId);
                        return (
                          <View
                            key={worker.requestId}
                            style={{
                              gap: 6,
                              borderLeftWidth: 2,
                              borderColor: c.border,
                              paddingLeft: 12,
                            }}
                          >
                            <Text style={text}>
                              {member ? sessionName(member, d) : "Worker creation unresolved"}
                            </Text>
                            <Text style={muted}>
                              {worker.ownership === "linked"
                                ? "Linked to this leader"
                                : worker.ownership === "orphaned"
                                  ? "Automation suspended; reassociation needed"
                                  : "Creation has not been resolved"}
                              {member ? ` · ${sessionStatus(member, stale)}` : ""}
                            </Text>
                            {worker.lastEvent && !worker.lastEvent.consumed && (
                              <Text style={text}>
                                An update is waiting for the leader to acknowledge.
                              </Text>
                            )}
                            {worker.fault && (
                              <Text style={text}>
                                An event delivery needs attention. Open management to inspect it.
                              </Text>
                            )}
                            {member && (
                              <WorkButton
                                theme={props.theme}
                                label={`Inspect team member ${sessionName(member, d)}`}
                                onPress={() => setSelected(member.id)}
                              >
                                Conversation and updates
                              </WorkButton>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
                <WorkBrief
                  compact
                  taskId={task.id}
                  theme={props.theme}
                  host={props.host}
                  frozen={false}
                  onTask={props.onTask}
                />
                <Text style={muted}>
                  {nodes.length} saved conversations in this workstream. Reports and completed turns
                  still require review.
                </Text>
                <WorkButton
                  theme={props.theme}
                  label={`Progress and decisions: ${name(task.title)}`}
                  expanded={expanded === task.id}
                  onPress={() => setExpanded(expanded === task.id ? null : task.id)}
                >
                  Progress, decisions and impact
                </WorkButton>
                {expanded === task.id && (
                  <WorkBrief
                    taskId={task.id}
                    theme={props.theme}
                    host={props.host}
                    frozen={false}
                    onTask={props.onTask}
                  />
                )}
                <WorkButton
                  theme={props.theme}
                  label={`Manage leaders: ${name(task.title)}`}
                  onPress={() => props.onTask(task.id)}
                >
                  Direct work or change leader
                </WorkButton>
              </View>
            );
          })}
          {shown.length > limit && (
            <WorkButton
              theme={props.theme}
              label="Show more leaders"
              onPress={() => setLimit(limit + 8)}
            />
          )}
          {roleKnown && unassigned.length > 0 && (
            <View style={{ gap: 12 }}>
              <WorkButton
                theme={props.theme}
                label="Tasks without a recorded leader"
                expanded={showUnassigned}
                onPress={() => setShowUnassigned(!showUnassigned)}
              >{`${unassigned.length} tasks without a recorded leader`}</WorkButton>
              {showUnassigned && (
                <>
                  <Text style={muted}>
                    No orchestrator is recorded for these tasks. Opening a task does not delegate
                    it.
                  </Text>
                  {unassigned.slice(0, limit).map((task) => (
                    <WorkButton
                      key={task.id}
                      theme={props.theme}
                      label={`Set up leadership: ${name(task.title)}`}
                      onPress={() => props.onTask(task.id)}
                    >
                      {name(task.title)}
                    </WorkButton>
                  ))}
                  {unassigned.length > limit && (
                    <WorkButton
                      theme={props.theme}
                      label="Show more unassigned tasks"
                      onPress={() => setLimit(limit + 8)}
                    />
                  )}
                </>
              )}
            </View>
          )}
          {d && !d.tasks.length && (
            <Text style={text}>
              No connected workstreams were found. Refresh after connecting your work.
            </Text>
          )}
          <Text style={muted}>
            Changing a leader opens the existing handover controls. Review the incoming provider,
            saved team and handoff context there. Ownership changes only when you submit the
            transfer.
          </Text>
        </>
      )}
    </ScrollView>
  );
}
