import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { fleetRpc, type Fleet } from "../shared/fleet";
import { projectsRpc } from "../shared/projects";
import { briefingRpc } from "../shared/briefing";
import { roleDirectoryRpc } from "../shared/roles";
import { remitsRpc, type RemitsView } from "../shared/cc/remit";
import { SeatPanel, type SeatTarget } from "./role-seat";
import { ProjectGovernance } from "./project-work";
import {
  buildHierarchy,
  orchestratorView,
  UNGROUPED_PROJECT,
  type Hierarchy,
  type Coverage,
  type LeaderView,
  type PrimeView,
  type ProjectLeadership,
} from "./hierarchy";
import { sessionName, sessionStatus, workName } from "./work-labels";
import { quotaLabel, quotaIsStale } from "./quota-wait";
import { OriginalConversation } from "./original-conversation";
import { WorkButton } from "./work-button";
import { WorkBrief } from "./work-brief";
import { Activity } from "./fleet";
import { lastGood } from "./last-good";
import { TeamSetupCard } from "./team-setup";

/**
 * The top of Orca: recorded prime orchestrators, then a project, then sessions as a drill-down.
 * Every name comes from a recorded controller relationship; see README "Leadership hierarchy".
 * Nothing here delegates, assigns or transfers. Actions open an existing conversation or the
 * existing management route for a workstream.
 */
const STALE_MS = 45000;
/** A prime seat name, as the controller accepts it (bindings.mjs). The operator chooses it; none is built in. */
const PRIME_SEAT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
type Props = PluginSurfaceProps & { onTask: (id: string) => void };

/**
 * Query keys are the ones the other surfaces already use, key shape included, so Leadership,
 * Workstreams and the briefing panel read one cached observation rather than three that age apart.
 */
function useObservation<T>(
  queryKey: unknown[],
  run: () => Promise<T>,
  now: number,
  interval: number,
) {
  const query = useQuery({
    queryKey,
    queryFn: run,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    retry: false,
  });
  // J0: a stalled read keeps the last good result (memory only) and says so in one plain notice.
  const last = lastGood(query, queryKey, { now });
  const age =
    now - Date.parse((last.data as { observedAt?: string } | undefined)?.observedAt ?? "");
  return {
    query,
    data: last.data,
    notice: last.notice,
    stale:
      query.isError || last.fromMemory || !Number.isFinite(age) || age > STALE_MS || age < -5000,
  };
}

/** Reach, depth and grouping are separate facts; none of them may be reported as the others. */
function primeDetail(prime: PrimeView): string {
  const leads = `Leads ${prime.leads.length} recorded ${prime.leads.length === 1 ? "leader" : "leaders"}`;
  const tasks = `across ${prime.truncated ? "at least " : ""}${prime.reachedTasks.length} ${prime.reachedTasks.length === 1 ? "workstream" : "workstreams"}`;
  const projects = prime.reachKnown
    ? prime.reaches.length
      ? ` in ${prime.reaches.length} ${prime.reaches.length === 1 ? "project" : "projects"}`
      : ", none of them linked to a recorded project"
    : prime.reaches.length
      ? ` in at least ${prime.reaches.length} recorded ${prime.reaches.length === 1 ? "project" : "projects"}; project grouping is incomplete, so this leader's full project reach is unknown`
      : "; project grouping is unavailable, so this leader's project reach is unknown";
  const loop = prime.cyclic
    ? " Some leadership links loop back and were not followed; inspect them in management."
    : "";
  const deep = prime.truncated
    ? " Leadership beyond 64 recorded sessions was not followed; the counts above are a lower bound."
    : "";
  return `${leads} ${tasks}${projects}.${loop}${deep}`;
}

/** Never says "N have none" from a page. An incomplete read reports what it checked instead. */
function briefSentence(project: ProjectLeadership, coverage: Coverage): string {
  const of = `${project.briefed} of ${project.taskIds.length} ${project.taskIds.length === 1 ? "workstream" : "workstreams"}`;
  if (!coverage.available)
    return "Published briefs could not be read, so progress for this project is unknown here. No workstream is established as having no brief.";
  if (coverage.complete)
    return `${of} ${project.taskIds.length === 1 ? "has" : "have"} a published brief.${project.unbriefed > 0 ? ` ${project.unbriefed} ${project.unbriefed === 1 ? "has" : "have"} none, so their progress is unknown here.` : ""}`;
  return `${of} here ${project.taskIds.length === 1 ? "has" : "have"} a published brief on the page read. ${coverage.scanned} of ${coverage.total} recorded tasks were checked on this page; ${coverage.missing} have no published brief and ${coverage.unavailable} could not be read. Progress for the rest is unknown, not absent.`;
}

/**
 * A prime seat sits over the programme root, so its remit is the programme: which recorded
 * projects have an accountable orchestrator and which do not. Unknown is counted separately and
 * never folded into "unassigned" — an unreadable seat is not an empty one.
 */

/** A project seat is held by a session on one of that project's own recorded workstreams. */
const projectTarget = (project: ProjectLeadership): SeatTarget => ({
  seat: project.seat!,
  label: project.name,
  candidateTaskIds: project.taskIds,
  scope: "Pick one of this project's recorded workstreams, then a saved session inside it.",
});

/** A prime's projects follow its remits (CONTRACTS §5.2). Unreadable remits fall back to every project, said so. */
function crossProject(h: Hierarchy, seat?: string, remits?: RemitsView) {
  const owned =
    remits && !remits.error && Array.isArray(remits.projects) && seat
      ? new Set(remits.projects.filter((p) => p.owner.primeSeat === seat).map((p) => p.projectId))
      : null;
  const projects = h.projects.filter(
    (p) => p.id !== UNGROUPED_PROJECT && (!owned || owned.has(p.id)),
  );
  const led = projects.filter((p) => p.orchestrator.state === "assigned");
  const vacant = projects.filter(
    (p) =>
      p.orchestrator.state === "unassigned" || p.orchestrator.state === "unassigned-with-leaders",
  );
  const unknown = projects.filter((p) => p.orchestrator.state === "unknown");
  return { projects, led, vacant, unknown, byRemit: Boolean(owned) };
}

/** Record a prime seat under a name the operator chooses. Several primes are normal. */
function NewPrimeSeat({
  props,
  existing,
  programme,
  first,
  onTarget,
}: {
  props: Props;
  existing: string[];
  programme: string;
  first: boolean;
  onTarget: (t: SeatTarget) => void;
}) {
  const c = props.theme.colors,
    [name, setName] = useState("");
  const slug = name.trim(),
    valid = PRIME_SEAT.test(slug) && !existing.includes(slug);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foregroundMuted }}>
        {first
          ? "Name the main assistant: short, lowercase, for example delivery."
          : "Another main assistant can own a different set of projects."}
      </Text>
      <TextInput
        accessibilityLabel="Name for the new main assistant"
        value={name}
        onChangeText={setName}
        autoCapitalize="none"
        maxLength={32}
        placeholder="delivery"
        placeholderTextColor={c.foregroundMuted}
        style={{
          color: c.foreground,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 10,
          padding: 10,
          backgroundColor: c.surface0,
        }}
      />
      {slug && !valid && (
        <Text style={{ color: c.foreground }}>
          {existing.includes(slug)
            ? "A main assistant with that name already exists."
            : "Use lowercase letters, numbers and dashes, up to 32 characters."}
        </Text>
      )}
      <WorkButton
        theme={props.theme}
        label={
          first ? "Record a main assistant for this programme" : "Record another main assistant"
        }
        disabled={!valid}
        onPress={() =>
          onTarget({
            seat: {
              role: "prime",
              seat: slug,
              projectId: null,
              state: "vacant",
              revision: 0,
              task: null,
              sessionId: null,
              session: null,
              note: null,
              at: null,
              membershipAt: null,
              sessionPresent: false,
              sessionGenerationChanged: false,
              sessionTaskMatches: false,
              dispatch: null,
            },
            label: `the ${slug} main assistant role`,
            candidateTaskIds: [programme],
            scope:
              "A main assistant is a session enrolled on the programme root. Pick one of its saved sessions.",
          })
        }
      >
        {first ? "Record a main assistant" : "Record another main assistant"}
      </WorkButton>
    </View>
  );
}

function LeaderCard({
  leader,
  fleet,
  stale,
  label,
  detail,
  props,
  onSession,
}: {
  leader: LeaderView;
  fleet?: Fleet;
  stale: boolean;
  label: string;
  detail?: string;
  props: Props;
  onSession: (id: string) => void;
}) {
  const c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const node = fleet?.nodes.find((n) => n.id === leader.sessionId),
    task = fleet?.tasks.find((t) => t.id === leader.taskId);
  const name = node ? sessionName(node, fleet) : "Leader conversation not in this observation";
  return (
    <View
      style={{
        gap: 12,
        padding: 18,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1 ?? c.surface0,
      }}
    >
      <Text style={{ ...muted, fontSize: 12, letterSpacing: 1 }}>{label}</Text>
      <Text style={{ ...text, fontSize: 20, lineHeight: 27, fontWeight: "600" }}>{name}</Text>
      {node ? (
        <>
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
        </>
      ) : (
        <Text style={text}>
          This leader is recorded, but its conversation is not in the current observation. Its
          history has not been deleted.
        </Text>
      )}
      <Text style={muted}>Accountable for: {workName(task?.title)}</Text>
      {detail && <Text style={text}>{detail}</Text>}
      <Text style={muted}>
        {leader.workers === 0
          ? "No workers recorded."
          : `${leader.workers} recorded ${leader.workers === 1 ? "worker" : "workers"}.`}
        {leader.leads.length
          ? ` ${leader.leads.length} of them ${leader.leads.length === 1 ? "leads" : "lead"} work of their own.`
          : ""}
        {leader.active
          ? ""
          : " Lead control is paused. Check who controls this before you continue."}
      </Text>
      {leader.waitingAcknowledgement > 0 && (
        <Text style={text}>
          {leader.waitingAcknowledgement} worker{" "}
          {leader.waitingAcknowledgement === 1 ? "update is" : "updates are"} waiting for this
          leader to acknowledge.
        </Text>
      )}
      {(leader.unresolvedWorkers > 0 || leader.faults > 0) && (
        <Text style={text}>
          {leader.unresolvedWorkers > 0
            ? `${leader.unresolvedWorkers} worker ${leader.unresolvedWorkers === 1 ? "link needs" : "links need"} attention. `
            : ""}
          {leader.faults > 0
            ? `${leader.faults} event ${leader.faults === 1 ? "delivery needs" : "deliveries need"} inspection.`
            : ""}
        </Text>
      )}
      {node && (
        <OriginalConversation
          theme={props.theme}
          host={props.host}
          navigation={props.navigation}
          targetHost={node.host}
          targetServerId={node.serverId}
          agentId={node.agentId}
          label={`Talk to ${name}`}
        />
      )}
      {node && (
        <WorkButton
          theme={props.theme}
          label={`Read retained updates from ${name}`}
          onPress={() => onSession(node.id)}
        >
          Read retained updates
        </WorkButton>
      )}
      <WorkButton
        theme={props.theme}
        label={`Manage workstream: ${workName(task?.title)}`}
        onPress={() => props.onTask(leader.taskId)}
      >
        Direct work or change leader
      </WorkButton>
    </View>
  );
}

function ProjectOverview({
  project,
  fleet,
  stale,
  briefingStale,
  props,
  onSession,
  onSeat,
  onGovernance,
}: {
  project: ProjectLeadership;
  fleet?: Fleet;
  stale: boolean;
  briefingStale: boolean;
  props: Props;
  onSession: (id: string) => void;
  onSeat?: (project: ProjectLeadership) => void;
  onGovernance?: ReactNode;
}) {
  const c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const nodes = fleet?.nodes.filter((n) => project.taskIds.includes(n.task)) ?? [];
  const heading = { ...text, fontSize: 18, fontWeight: "600" as const };
  const role = orchestratorView(project.orchestrator),
    roleNode = role.sessionId ? fleet?.nodes.find((n) => n.id === role.sessionId) : undefined;
  const coverage = project.briefCoverage;
  // The heading is the actual leader when the bound session is in this observation; the seat's own
  // fallback word only shows when it is not, so a real orchestrator is never rendered as a label.
  const roleHeading = roleNode ? sessionName(roleNode, fleet) : role.heading;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text
          accessibilityRole="header"
          style={{ ...text, fontSize: 24, lineHeight: 31, fontWeight: "600" }}
        >
          {project.name}
        </Text>
        {project.description && (
          <Text style={{ ...muted, lineHeight: 22 }}>{project.description}</Text>
        )}
        <Text style={muted}>
          {project.membershipComplete ? "" : "At least "}
          {project.taskIds.length} recorded{" "}
          {project.taskIds.length === 1 ? "workstream" : "workstreams"}
          {project.status ? ` · Project: ${project.status.replaceAll("_", " ")}` : ""}
        </Text>
      </View>
      <View
        style={{
          gap: 8,
          padding: 18,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface1 ?? c.surface0,
        }}
      >
        <Text style={{ ...muted, fontSize: 12, letterSpacing: 1 }}>PROJECT LEAD</Text>
        <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>{roleHeading}</Text>
        {roleNode && (
          <Text style={muted}>
            {roleNode.provider === "claude"
              ? "Claude"
              : roleNode.provider === "codex"
                ? "Codex"
                : roleNode.provider}
            {roleNode.model ? ` · ${roleNode.model}` : ""} · {sessionStatus(roleNode, stale)}
          </Text>
        )}
        <Text style={text}>{role.detail}</Text>
        <Text style={muted}>{role.note}</Text>
        {role.sessionId && !roleNode && (
          <Text style={text}>
            The accountable session is recorded but is not in the current observation. Its history
            has not been deleted.
          </Text>
        )}
        {/* Role-scoped names: the same session is usually also a workstream leader card below. */}
        {roleNode && (
          <OriginalConversation
            theme={props.theme}
            host={props.host}
            navigation={props.navigation}
            targetHost={roleNode.host}
            targetServerId={roleNode.serverId}
            agentId={roleNode.agentId}
            label={`Talk to ${roleHeading}, project lead`}
          />
        )}
        {roleNode && (
          <WorkButton
            theme={props.theme}
            label={`Read retained updates from ${roleHeading}, project lead`}
            onPress={() => onSession(roleNode.id)}
          >
            Retained updates and conversation
          </WorkButton>
        )}
        {onSeat && (
          <WorkButton
            theme={props.theme}
            label={
              role.sessionId
                ? `Change who is accountable for ${project.name}`
                : `Record who is accountable for ${project.name}`
            }
            onPress={() => onSeat(project)}
          >
            {role.sessionId ? "Change or empty this role" : "Assign a lead"}
          </WorkButton>
        )}
      </View>
      {onGovernance}
      <Text accessibilityRole="header" style={heading}>
        Published briefs
      </Text>
      {!project.taskIds.length ? (
        <Text style={text}>
          {project.membershipComplete
            ? "No recorded work is linked to this project in the current observation. No leader or activity is inferred from that."
            : "No recorded work for this project could be observed. Work or its grouping was missing from this read, so this project is not established as empty."}
        </Text>
      ) : (
        <>
          <Text style={text}>{briefSentence(project, coverage)}</Text>
          {coverage.morePages && (
            <Text style={muted}>
              Only the first page of published briefs was read here. Work on a later page is not
              shown; the Workstreams tab pages through all of them.
            </Text>
          )}
          {briefingStale && (
            <Text accessibilityLiveRegion="polite" style={text}>
              Published briefs are outdated or could not be read. Progress below is not current.
            </Text>
          )}
          {project.statuses.map((s) => (
            <View
              key={`status-${s.taskId}`}
              style={{
                gap: 4,
                padding: 16,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Text style={{ ...text, fontWeight: "600" }}>{s.title}</Text>
              <Text style={text}>{s.outcome}</Text>
              <Text style={muted}>{s.currentState}</Text>
            </View>
          ))}
          {project.leaders.map((leader) => (
            <LeaderCard
              key={leader.sessionId}
              leader={leader}
              fleet={fleet}
              stale={stale}
              label="RECORDED WORKSTREAM LEADER"
              props={props}
              onSession={onSession}
            />
          ))}
        </>
      )}
      <Text accessibilityRole="header" style={heading}>
        What is needed
      </Text>
      {!project.decisions.length && !project.dependencies.length && (
        <Text style={muted}>
          No decision request or dependency is recorded on the briefs read here. That does not
          establish there are none.
        </Text>
      )}
      {project.decisions.map((need, i) => (
        <View
          key={`decision-${i}`}
          style={{ gap: 6, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: c.border }}
        >
          <Text style={{ ...text, fontWeight: "600" }}>
            Your judgment is requested · {need.title}
          </Text>
          <Text style={text}>{need.text}</Text>
          <WorkButton
            theme={props.theme}
            label={`Open decision work: ${need.title}`}
            onPress={() => props.onTask(need.taskId)}
          >
            Open options and evidence
          </WorkButton>
        </View>
      ))}
      {project.dependencies.map((need, i) => (
        <View key={`dependency-${i}`} style={{ gap: 6 }}>
          <Text style={{ ...text, fontWeight: "600" }}>Blocked on: {need.title}</Text>
          <Text style={muted}>
            {need.text}
            {need.verified
              ? ""
              : " · This dependency could not be verified in the current observation."}
          </Text>
        </View>
      ))}
      <Text accessibilityRole="header" style={heading}>
        Next actions
      </Text>
      {!project.nextActions.length ? (
        <Text style={muted}>No next step is published on the briefs read here.</Text>
      ) : (
        project.nextActions.map((need, i) => (
          <View key={`next-${i}`} style={{ gap: 4 }}>
            <Text style={text}>{need.text}</Text>
            <Text style={muted}>{need.title}</Text>
          </View>
        ))
      )}
      <WorkButton
        theme={props.theme}
        label="Sessions in this project"
        expanded={sessionsOpen}
        onPress={() => setSessionsOpen(!sessionsOpen)}
      >{`${nodes.length} saved ${nodes.length === 1 ? "conversation" : "conversations"}`}</WorkButton>
      {sessionsOpen && (
        <View style={{ gap: 10 }}>
          <Text style={muted}>
            Individual conversations sit below the leadership above. A saved conversation is not
            activity; open one to read what it actually reported.
          </Text>
          {!nodes.length && (
            <Text style={text}>No saved conversations are recorded for this project.</Text>
          )}
          {nodes.map((node) => (
            <View
              key={node.id}
              style={{ gap: 6, borderLeftWidth: 2, borderColor: c.border, paddingLeft: 12 }}
            >
              <Text style={text}>{sessionName(node, fleet)}</Text>
              <Text style={muted}>
                {sessionStatus(node, stale)} ·{" "}
                {workName(fleet?.tasks.find((t) => t.id === node.task)?.title)}
              </Text>
              {node.quotaWait && (
                <Text style={text}>
                  {stale || quotaIsStale(node.quotaObservedAt) ? "Last recorded: " : ""}
                  {quotaLabel(node.quotaWait)}
                </Text>
              )}
              <WorkButton
                theme={props.theme}
                label={`Open session: ${sessionName(node, fleet)}`}
                onPress={() => onSession(node.id)}
              >
                Retained updates and conversation
              </WorkButton>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function PrimeSurface(props: Props) {
  const c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const readFleet = useContract(fleetRpc),
    readProjects = useContract(projectsRpc),
    readBriefing = useContract(briefingRpc),
    readRoles = useContract(roleDirectoryRpc);
  const [now, setNow] = useState(Date.now()),
    [project, setProject] = useState<string | null>(null),
    [session, setSession] = useState<string | null>(null);
  const [seatTarget, setSeatTarget] = useState<SeatTarget | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const hostId = props.host?.id;
  const fleet = useObservation(["orca-fleet", hostId], () => readFleet({}), now, 15000);
  const directory = useObservation(["orca-projects", hostId], () => readProjects({}), now, 30000);
  const briefing = useObservation(
    ["orca-project-briefing", hostId, null],
    () => readBriefing({ after: null }),
    now,
    30000,
  );
  const roles = useObservation(["orca-role-directory", hostId], () => readRoles({}), now, 30000);
  const readRemits = useContract(remitsRpc);
  const remits = useObservation(
    ["orca-organisation", hostId, "remits"],
    () => readRemits({}),
    now,
    30000,
  );
  const h = buildHierarchy(fleet.data, directory.data, briefing.data, roles.data);
  const chosen = h.projects.find((p) => p.id === project) ?? null,
    node = fleet.data?.nodes.find((n) => n.id === session);
  const pad = { padding: props.layout.compact ? 16 : 28 };

  if (node)
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: c.surface0 }}
        contentContainerStyle={{ ...pad, gap: 20 }}
      >
        <WorkButton
          theme={props.theme}
          label="Back to leadership"
          onPress={() => setSession(null)}
        />
        <Activity
          key={`${hostId}:${node.id}`}
          {...props}
          node={node}
          fleet={fleet.data}
          frozen={false}
          quotaStale={fleet.stale}
        />
        <WorkBrief
          taskId={node.task}
          theme={props.theme}
          host={props.host}
          frozen={false}
          onTask={props.onTask}
        />
      </ScrollView>
    );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ ...pad, gap: 22, maxWidth: props.layout.compact ? undefined : 860 }}
    >
      <View style={{ gap: 8 }}>
        <Text style={{ ...muted, letterSpacing: 1, fontSize: 12 }}>FULCRA / LEADS</Text>
        <Text
          accessibilityRole="header"
          style={{
            ...text,
            fontSize: props.layout.compact ? 28 : 32,
            lineHeight: props.layout.compact ? 34 : 39,
            fontWeight: "600",
          }}
        >
          Who leads your work
        </Text>
        <Text style={{ ...muted, fontSize: 16, lineHeight: 24 }}>
          Main assistants first, then each project's lead, then the individual chats.
        </Text>
      </View>
      <TeamSetupCard {...props} />
      {session && !node && (
        <Text style={text}>
          That conversation is no longer in the current observation. Its history has not been
          deleted.
        </Text>
      )}
      {fleet.stale && (
        <Text accessibilityLiveRegion="polite" style={text}>
          {fleet.data
            ? (fleet.notice ?? "This view may be out of date. Fulcra is checking again.")
            : fleet.query.isPending
              ? "Reading who leads what…"
              : "Fulcra is not answering yet; retrying."}
        </Text>
      )}
      {fleet.data?.partial && (
        <Text style={muted}>
          Some work or team members could not be observed. This view is incomplete.
        </Text>
      )}
      <Text accessibilityRole="header" style={{ ...text, fontSize: 20, fontWeight: "600" }}>
        Main assistants
      </Text>
      {/* An explicit prime seat is what a prime *is*. Supervision shape is shown separately below as
        supporting evidence, never promoted into the role once real seats can be read. */}
      {!h.rolesAvailable ? (
        <Text accessibilityLiveRegion="polite" style={text}>
          Fulcra could not read who leads what, so it cannot say whether a main assistant is set.
          {h.rolesUnavailable ? ` Controller reported: ${h.rolesUnavailable}` : ""}
        </Text>
      ) : !h.primeSeats.length ? (
        <>
          <Text style={text}>No main assistant is set yet.</Text>
          <Text style={muted}>
            A main assistant looks after all your projects. Naming one does not start a chat or give
            it new powers.
          </Text>
          {/* The operator names the seat and chooses who holds it; no seat name is built in. */}
          {roles.data?.programme && (
            <NewPrimeSeat
              props={props}
              existing={[]}
              programme={roles.data.programme}
              first
              onTarget={setSeatTarget}
            />
          )}
        </>
      ) : (
        h.primeSeats.map((seat) => {
          const node = fleet.data?.nodes.find((n) => n.id === seat.sessionId);
          const name = node ? sessionName(node, fleet.data) : "Its chat is not in this view";
          return (
            <View
              key={`${seat.role}:${seat.seat}`}
              style={{
                gap: 10,
                padding: 18,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surface1 ?? c.surface0,
              }}
            >
              <Text style={{ ...muted, fontSize: 12, letterSpacing: 1 }}>
                MAIN ASSISTANT · {seat.seat}
              </Text>
              <Text style={{ ...text, fontSize: 20, lineHeight: 27, fontWeight: "600" }}>
                {name}
              </Text>
              {node ? (
                <Text style={text}>{sessionStatus(node, fleet.stale)}</Text>
              ) : (
                <Text style={text}>
                  This main assistant's chat is not in the current view. Its history has not been
                  deleted.
                </Text>
              )}
              {!seat.sessionPresent && (
                <Text style={text}>The bound session is no longer saved in the journal.</Text>
              )}
              {seat.dispatch && !seat.dispatch.supported && (
                <Text style={muted}>{seat.dispatch.reason}</Text>
              )}
              {/* Remit: the seat's own recorded words, and what the programme looks like from it. */}
              <Text style={{ ...muted, fontSize: 12, letterSpacing: 1 }}>WHAT IT LOOKS AFTER</Text>
              <Text style={text}>{seat.note ?? "Nothing is written down for it yet."}</Text>
              {(() => {
                const x = crossProject(h, seat.seat, remits.data);
                if (!x.projects.length)
                  return (
                    <Text style={muted}>
                      {x.byRemit
                        ? "This main assistant owns no project yet. Give it one from a project's story in Organisation."
                        : "No recorded project is grouped under this programme yet."}
                    </Text>
                  );
                return (
                  <>
                    <Text style={{ ...muted, fontSize: 12, letterSpacing: 1 }}>
                      {x.byRemit ? "PROJECTS IT OWNS" : "CROSS-PROJECT WORK"}
                    </Text>
                    {!x.byRemit && (
                      <Text style={muted}>
                        Which main assistant owns which project could not be read, so every project
                        is listed.
                      </Text>
                    )}
                    <Text style={text}>
                      {x.led.length} of {x.projects.length} recorded{" "}
                      {x.projects.length === 1 ? "project has" : "projects have"} an accountable
                      orchestrator.
                      {x.vacant.length
                        ? ` ${x.vacant.length} ${x.vacant.length === 1 ? "has none" : "have none"}.`
                        : ""}
                      {x.unknown.length
                        ? ` ${x.unknown.length} could not be read, so ${x.unknown.length === 1 ? "it is" : "they are"} unknown rather than empty.`
                        : ""}
                    </Text>
                    {x.led.map((p) => (
                      <WorkButton
                        key={`led-${p.id}`}
                        theme={props.theme}
                        label={`Open project with a lead: ${p.name}`}
                        onPress={() => {
                          setProject(p.id);
                          setSession(null);
                          setSeatTarget(null);
                        }}
                      >{`${p.name} · led`}</WorkButton>
                    ))}
                    {x.vacant.map((p) => (
                      <WorkButton
                        key={`vac-${p.id}`}
                        theme={props.theme}
                        label={`Open project needing a lead: ${p.name}`}
                        onPress={() => {
                          setProject(p.id);
                          setSession(null);
                          setSeatTarget(null);
                        }}
                      >{`${p.name} · needs a lead`}</WorkButton>
                    ))}
                  </>
                );
              })()}
              {/* Seat-scoped names: the same session may also appear as a supervision card below,
                and two buttons with one accessible name is ambiguous to read and to operate. */}
              {node && (
                <OriginalConversation
                  theme={props.theme}
                  host={props.host}
                  navigation={props.navigation}
                  targetHost={node.host}
                  targetServerId={node.serverId}
                  agentId={node.agentId}
                  label={`Talk to ${name}, main assistant ${seat.seat}`}
                />
              )}
              {node && (
                <WorkButton
                  theme={props.theme}
                  label={`Read retained updates from ${name}, main assistant ${seat.seat}`}
                  onPress={() => setSession(node.id)}
                >
                  Read retained updates
                </WorkButton>
              )}
            </View>
          );
        })
      )}
      {h.rolesAvailable && h.primeSeats.length > 0 && roles.data?.programme && (
        <NewPrimeSeat
          props={props}
          existing={h.primeSeats.map((s) => s.seat)}
          programme={roles.data.programme}
          first={false}
          onTarget={setSeatTarget}
        />
      )}
      <Text accessibilityRole="header" style={{ ...text, fontSize: 16, fontWeight: "600" }}>
        Who supervises whom
      </Text>
      {h.supervisionAvailable && h.supervisionUnreadable > 0 && (
        <Text style={text}>
          {h.supervisionUnreadable === 1
            ? "One supervisor's record"
            : `${h.supervisionUnreadable} supervisors' records`}{" "}
          could not be read, so {h.supervisionUnreadable === 1 ? "it is" : "they are"} left out
          below. Everyone else is shown.
        </Text>
      )}
      {h.supervisionAvailable && h.supervisionTruncated > 0 && (
        <Text style={muted}>
          {h.supervisionTruncated} more{" "}
          {h.supervisionTruncated === 1 ? "supervisor is" : "supervisors are"} not shown here.
        </Text>
      )}
      {!h.supervisionAvailable ? (
        <Text style={text}>
          Fulcra could not read who supervises whom, so this list may be incomplete.
        </Text>
      ) : !h.primes.length ? (
        <Text style={muted}>No leader currently leads another leader.</Text>
      ) : (
        <>
          <Text style={muted}>
            These orchestrators lead other orchestrators. That shows who supervises whom; it does
            not make anyone a main assistant.
          </Text>
          {h.primes.map((prime) => (
            <LeaderCard
              key={prime.sessionId}
              leader={prime}
              fleet={fleet.data}
              stale={fleet.stale}
              label="LEADS OTHER LEADERS"
              props={props}
              onSession={setSession}
              detail={primeDetail(prime)}
            />
          ))}
        </>
      )}
      {h.supervisionAvailable && h.soloLeaders.length > 0 && (
        <Text style={muted}>
          {h.soloLeaders.length} other recorded{" "}
          {h.soloLeaders.length === 1 ? "leader leads" : "leaders lead"} a single workstream with no
          leader above or below. They appear under their project below.
        </Text>
      )}
      <Text accessibilityRole="header" style={{ ...text, fontSize: 20, fontWeight: "600" }}>
        Projects
      </Text>
      {!h.projectsAvailable && (
        <Text accessibilityLiveRegion="polite" style={text}>
          The project directory is unavailable, so recorded work is not grouped. Saved work remains
          readable below, and no leader's project reach can be established from this read.
        </Text>
      )}
      {h.projectsPartial && (
        <Text accessibilityLiveRegion="polite" style={text}>
          Project grouping is incomplete. Projects and membership missing from this read are not
          ruled out.
        </Text>
      )}
      {directory.stale && h.projectsAvailable && (
        <Text accessibilityLiveRegion="polite" style={muted}>
          Project grouping is outdated. Membership shown may have changed.
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {h.projects.map((p) => (
          <WorkButton
            key={p.id}
            theme={props.theme}
            label={`Project overview: ${p.name}`}
            selected={project === p.id}
            onPress={() => {
              setProject(project === p.id ? null : p.id);
              setSession(null);
              setSeatTarget(null);
            }}
          >
            {p.id === UNGROUPED_PROJECT ? "Work without a project" : p.name}
          </WorkButton>
        ))}
      </View>
      {!h.projects.length && (
        <Text style={text}>No projects or recorded work are available in this observation.</Text>
      )}
      {project && !chosen && (
        <Text accessibilityLiveRegion="polite" style={text}>
          The project you opened is no longer in the current observation. Its work has not been
          deleted.
        </Text>
      )}
      {!chosen && !!h.projects.length && (
        <Text style={muted}>Choose a project to see what is happening and what is needed.</Text>
      )}
      {chosen && (
        <ProjectOverview
          project={chosen}
          fleet={fleet.data}
          stale={fleet.stale}
          briefingStale={briefing.stale}
          props={props}
          onSession={setSession}
          onSeat={
            h.rolesAvailable && chosen.seat ? () => setSeatTarget(projectTarget(chosen)) : undefined
          }
          onGovernance={
            <ProjectGovernance
              project={chosen}
              fleet={fleet.data}
              props={props}
              onSession={setSession}
              onAssign={() => chosen.seat && setSeatTarget(projectTarget(chosen))}
            />
          }
        />
      )}
      {seatTarget && (
        <SeatPanel
          target={seatTarget}
          fleet={fleet.data}
          props={props}
          onDone={() => setSeatTarget(null)}
          onChanged={() => {
            void roles.query.refetch();
          }}
        />
      )}
      {chosen && !h.rolesAvailable && (
        <Text style={muted}>
          Recording a lead is unavailable while leadership role records cannot be read.
        </Text>
      )}
      {h.supervisionAvailable && h.tasksWithoutLeader > 0 && (
        <Text style={muted}>
          {h.tasksWithoutLeaderComplete ? "" : "At least "}
          {h.tasksWithoutLeader} recorded{" "}
          {h.tasksWithoutLeader === 1 ? "workstream has" : "workstreams have"} no leader. Opening
          one does not give control of it to a lead.
        </Text>
      )}
      <WorkButton
        theme={props.theme}
        label="Refresh leadership"
        onPress={() => {
          void fleet.query.refetch();
          void directory.query.refetch();
          void briefing.query.refetch();
          void roles.query.refetch();
          void remits.query.refetch();
        }}
      >
        Refresh
      </WorkButton>
      <Text style={muted}>
        Names come from recorded controller relationships. Ownership changes only through the
        existing management route, and only when you submit it there.
      </Text>
    </ScrollView>
  );
}
