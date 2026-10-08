import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import {
  projectRequestSessionRpc,
  roleAdoptRpc,
  roleAllowanceSetRpc,
  roleAllowancesRpc,
  roleProjectRpc,
  sessionOwnershipRpc,
  sessionRequestsRpc,
  type AdoptResult,
  type AllowanceSetResult,
  type AppOwnershipRecord,
  type RequestSessionResult,
} from "../shared/roles";
import type { Fleet } from "../shared/fleet";
import type { ProjectLeadership } from "./hierarchy";
import { UNGROUPED_PROJECT } from "./hierarchy";
import { sessionName, sessionStatus, workName } from "./work-labels";
import { WorkButton } from "./work-button";

/**
 * What a project is actually doing, and how work gets started inside it.
 *
 * Everything here is read from the controller's own project projection: the goal is the registered
 * project's own description and status, progress counts recorded controller deliveries, and needs
 * and blockers are the controller's own entries. Nothing is summarised into a number this surface
 * invented, and the basis of every count is shown next to it.
 *
 * Starting work *asks* the project's orchestrator seat for a session. It does not create one: the
 * controller publishes a request row, the seat is woken, and a session appears afterwards. So this
 * reports that a request was made, and shows outstanding requests — it never shows a session that
 * does not exist yet. The list of sessions below is project *membership*, not ownership; ownership
 * is a separate per-session controller read and is never inferred from being on a member task.
 */
const MIN_REASON = 12;
type Props = PluginSurfaceProps & { onTask: (id: string) => void };

/**
 * Exhaustive over the controller states, with a `never` default so a new state fails the
 * typecheck rather than quietly acquiring a display. `recorded` is the common path — work created
 * through the seat — and reads as owned, not as an exception.
 */
function ownershipLabel(own: AppOwnershipRecord): string {
  switch (own.state) {
    case "recorded":
      return `Created through this project's lead${own.leaderTitle ? `, led by ${own.leaderTitle}` : ""}`;
    case "adopted":
      return `Adopted into this project${own.leaderTitle ? `, led by ${own.leaderTitle}` : ""}`;
    case "declared":
      return "Owned by this project, led by nobody";
    case "managed":
      return `Worker for ${own.leaderTitle ?? own.leaderAgentId ?? "a recorded lead"}`;
    case "unknown":
      return "Owner not recorded";
    default: {
      const unhandled: never = own.state;
      throw new Error(`Unhandled ownership state: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function ProjectGovernance({
  project,
  fleet,
  props,
  onSession,
  onAssign,
}: {
  project: ProjectLeadership;
  fleet?: Fleet;
  props: Props;
  onSession: (id: string) => void;
  onAssign: () => void;
}) {
  const c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const readProject = useContract(roleProjectRpc),
    requestSession = useContract(projectRequestSessionRpc),
    readRequests = useContract(sessionRequestsRpc);
  const readAllowances = useContract(roleAllowancesRpc),
    readOwnership = useContract(sessionOwnershipRpc),
    adopt = useContract(roleAdoptRpc),
    setAllowance = useContract(roleAllowanceSetRpc);
  const [adoptResult, setAdoptResult] = useState<AdoptResult | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [grant, setGrant] = useState("");
  const [grantResult, setGrantResult] = useState<AllowanceSetResult | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RequestSessionResult | null>(null);
  const grouped = project.id !== UNGROUPED_PROJECT;

  const view = useQuery({
    queryKey: ["orca-role-project", props.host?.id, project.id],
    enabled: grouped,
    retry: false,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    queryFn: () => readProject({ projectId: project.id }),
  });
  const d = view.data;
  const leader = d?.leader ?? null;
  const seated = leader?.state === "assigned" && leader.sessionId ? leader : null;
  const field = {
    ...text,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 48,
  };
  const heading = { ...text, fontSize: 18, fontWeight: "600" as const };
  const short = reason.trim().length < MIN_REASON || title.trim().length < 3;

  const requests = useQuery({
    queryKey: ["orca-session-requests", props.host?.id],
    enabled: grouped,
    retry: false,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    queryFn: () => readRequests({}),
  });
  const mine = (requests.data?.requests ?? []).filter((r) => r.seat === project.id);

  // Why a seat will refuse, read before the operator is asked for a 12-character reason.
  const allowances = useQuery({
    queryKey: ["orca-role-allowances", props.host?.id],
    enabled: grouped,
    retry: false,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    queryFn: () => readAllowances({}),
  });
  const allowance = (allowances.data?.allowances ?? []).find((a) => a.seat === project.id) ?? null;
  const exhausted = allowance !== null && allowance.remaining === 0;
  const stalePin = allowance !== null && !allowance.current;

  // Ownership for the sessions on this project's workstreams, so a declared one can be adopted.
  const agentIds = (d?.sessions ?? []).flatMap((s) => {
    const node = fleet?.nodes.find((n) => n.id === s.sessionId);
    return node?.agentId ? [node.agentId] : [];
  });
  const owned = useQuery({
    queryKey: ["orca-session-ownership", props.host?.id, agentIds.join(",")],
    enabled: grouped && agentIds.length > 0,
    retry: false,
    queryFn: () => readOwnership({ agentIds }),
  });
  const ownershipOf = (sessionId: string) => {
    const node = fleet?.nodes.find((n) => n.id === sessionId);
    return node?.agentId ? (owned.data?.ownership[node.agentId] ?? null) : null;
  };

  // Adoption is keyed by the CREATION RECORD, not the session. The only creation record this
  // surface can see is the request row that produced the session, so adoption is offered exactly
  // when that is resolvable and is explained when it is not, rather than sending a guessed id.
  const requestOf = (sessionId: string) =>
    (requests.data?.requests ?? []).find((r) => r.sessionId === sessionId)?.requestId ?? null;

  const runAdopt = async (sessionId: string, request: string) => {
    if (!seated) return;
    setAdopting(sessionId);
    try {
      setAdoptResult(
        await adopt({
          seat: seated.seat,
          expectedRevision: leader!.revision,
          request,
          reason: reason.trim(),
        }),
      );
      void owned.refetch();
      void allowances.refetch();
    } catch (error) {
      setAdoptResult({
        status: "refused",
        message: error instanceof Error ? error.message : "Adoption unavailable",
        observedAt: new Date().toISOString(),
        sessionId: null,
        seat: null,
        remaining: null,
        grantsAuthority: false,
      });
    } finally {
      setAdopting(null);
    }
  };

  const run = async () => {
    if (!seated || !taskId) return;
    setBusy(true);
    try {
      setResult(
        await requestSession({
          seat: seated.seat,
          expectedRevision: leader!.revision,
          taskId,
          provider,
          title: title.trim(),
          reason: reason.trim(),
        }),
      );
      void requests.refetch();
      void view.refetch();
    } catch (error) {
      setResult({
        status: "refused",
        message: error instanceof Error ? error.message : "Role request unavailable",
        observedAt: new Date().toISOString(),
        requestId: null,
        state: null,
        grantsAuthority: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const runGrant = async () => {
    if (!seated) return;
    setBusy(true);
    try {
      setGrantResult(
        await setAllowance({
          seat: seated.seat,
          role: "project-orchestrator",
          expectedRevision: leader!.revision,
          maxSessions: Number(grant),
          reason: reason.trim(),
        }),
      );
      void allowances.refetch();
    } catch (error) {
      setGrantResult({
        status: "refused",
        message: error instanceof Error ? error.message : "Allowance grant unavailable",
        observedAt: new Date().toISOString(),
        seat: null,
        maxSessions: null,
        remaining: null,
        grantsAuthority: false,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!grouped)
    return (
      <Text style={muted}>
        Work without a recorded project has no lead and no project goal. A project lead is bound to
        a registered project, never to a task.
      </Text>
    );

  return (
    <View style={{ gap: 14 }}>
      {view.isPending && (
        <Text style={text}>Reading this project's recorded leadership and progress…</Text>
      )}
      {d && !d.available && (
        <Text accessibilityLiveRegion="polite" style={text}>
          This project's recorded leadership and progress could not be read, so its goal, lead and
          needs are unknown rather than absent.
          {d.unavailable ? ` Controller reported: ${d.unavailable}` : ""}
        </Text>
      )}

      {d?.available && (
        <>
          {/* Goal — the registered project's own words, never a summary invented here. */}
          <Text accessibilityRole="header" style={heading}>
            Goal
          </Text>
          {d.summary ? (
            <>
              <Text style={text}>
                {d.summary.description ?? "This project records no description."}
              </Text>
              <Text style={muted}>Status: {d.summary.status.replaceAll("_", " ")}</Text>
            </>
          ) : (
            <Text style={text}>
              The project directory could not confirm this project, so its goal is unknown here.
              Recorded leadership is still shown.
            </Text>
          )}

          {/* Progress — counts of recorded deliveries, with the controller's own caveat attached. */}
          <Text accessibilityRole="header" style={heading}>
            Progress
          </Text>
          {d.progress ? (
            <>
              <Text style={text}>
                {d.progress.recorded} recorded{" "}
                {d.progress.recorded === 1 ? "delivery" : "deliveries"} across{" "}
                {d.progress.memberTasks} confirmed{" "}
                {d.progress.memberTasks === 1 ? "workstream" : "workstreams"}, {d.progress.sessions}{" "}
                {d.progress.sessions === 1 ? "session" : "sessions"}, {d.progress.unresolved}{" "}
                unresolved.
              </Text>
              <Text style={muted}>{d.progress.basis}</Text>
              {d.progress.truncated && (
                <Text style={muted}>
                  Coverage was truncated, so these counts are a lower bound.
                </Text>
              )}
            </>
          ) : (
            <Text style={text}>
              Membership could not be confirmed, so no aggregate progress is claimed for this
              project. This is unknown, not zero.
            </Text>
          )}

          {/* Needs and decisions — the controller's own entries, each with its own wording. */}
          <Text accessibilityRole="header" style={heading}>
            What is needed
          </Text>
          {!d.needed.length && !d.blockers.length && (
            <Text style={muted}>
              The controller records no outstanding need or blocker for this project. Published
              briefs are shown separately below.
            </Text>
          )}
          {d.blockers.map((n, i) => (
            <View
              key={`b-${i}`}
              style={{
                gap: 4,
                padding: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Text style={{ ...text, fontWeight: "600" }}>
                Blocked · {n.kind.replaceAll("-", " ")}
              </Text>
              <Text style={text}>{n.detail}</Text>
              {n.taskId && (
                <WorkButton
                  theme={props.theme}
                  label={`Open blocked workstream: ${workName(fleet?.tasks.find((t) => t.id === n.taskId)?.title)}`}
                  onPress={() => props.onTask(n.taskId!)}
                >
                  Open this workstream
                </WorkButton>
              )}
            </View>
          ))}
          {d.needed.map((n, i) => (
            <View key={`n-${i}`} style={{ gap: 4 }}>
              <Text style={{ ...text, fontWeight: "600" }}>{n.kind.replaceAll("-", " ")}</Text>
              <Text style={muted}>{n.detail}</Text>
            </View>
          ))}

          {/* Outstanding requests: a seat has been asked, and no session exists yet. */}
          {!!mine.length && (
            <>
              <Text accessibilityRole="header" style={heading}>
                Asked of this lead
              </Text>
              <Text style={muted}>
                These are requests published to the seat. A request is not a session; work appears
                below only once the controller reports it.
              </Text>
              {mine.map((r) => (
                <View
                  key={r.requestId}
                  style={{
                    gap: 4,
                    padding: 14,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: c.border,
                  }}
                >
                  <Text style={{ ...text, fontWeight: "600" }}>{r.title ?? "Requested work"}</Text>
                  <Text style={muted}>
                    {r.state}
                    {r.provider ? ` · ${r.provider}` : ""}
                    {r.at ? ` · ${r.at}` : ""}
                  </Text>
                  {r.detail && <Text style={muted}>{r.detail}</Text>}
                  {r.sessionId && fleet?.nodes.some((n) => n.id === r.sessionId) && (
                    <WorkButton
                      theme={props.theme}
                      label={`Open the session this request produced: ${r.title ?? "requested work"}`}
                      onPress={() => onSession(r.sessionId!)}
                    >
                      Open the session it produced
                    </WorkButton>
                  )}
                </View>
              ))}
            </>
          )}
          {requests.data && !requests.data.available && (
            <Text style={muted}>
              Outstanding requests could not be read, so whether this role has been asked for work
              is unknown here.
            </Text>
          )}

          {/* Membership, stated as membership. Ownership is a separate read and is not claimed here. */}
          <Text accessibilityRole="header" style={heading}>
            Work in this project
          </Text>
          <Text style={muted}>
            Sessions recorded on this project's confirmed workstreams. Being on a member workstream
            is membership, not ownership.
          </Text>
          {!d.sessions.length && (
            <Text style={text}>
              No session is recorded on this project's confirmed workstreams.
            </Text>
          )}
          {d.sessions.map((s) => {
            const node = fleet?.nodes.find((n) => n.id === s.sessionId);
            const own = ownershipOf(s.sessionId);
            const name = node ? sessionName(node, fleet) : "Session not in the current observation";
            return (
              <View
                key={s.sessionId}
                style={{ gap: 4, borderLeftWidth: 2, borderColor: c.border, paddingLeft: 12 }}
              >
                <Text style={text}>{name}</Text>
                <Text style={muted}>
                  {workName(fleet?.tasks.find((t) => t.id === s.taskId)?.title)} · control {s.mode}
                  {node ? ` · ${sessionStatus(node, false)}` : ""}
                </Text>
                {/* The controller's own three states, in its own words. Never inferred from membership. */}
                {own && (
                  <Text style={muted}>
                    {ownershipLabel(own)}
                    {own.detail && own.state !== "managed" ? ` · ${own.detail}` : ""}
                  </Text>
                )}
                {own?.state === "declared" &&
                  seated &&
                  (requestOf(s.sessionId) ? (
                    <WorkButton
                      theme={props.theme}
                      disabled={adopting !== null || short || exhausted}
                      label={`Adopt ${name} into this project's lead role`}
                      onPress={() => {
                        const request = requestOf(s.sessionId);
                        if (request) void runAdopt(s.sessionId, request);
                      }}
                    >
                      Adopt into the role
                    </WorkButton>
                  ) : (
                    <Text style={muted}>
                      Adoption names the record this session was created under, and that record is
                      not visible here — it was not created through a request to this role. Adopt it
                      from a surface that can name its creation record.
                    </Text>
                  ))}
                {own?.state === "declared" && seated && short && requestOf(s.sessionId) && (
                  <Text style={muted}>Adoption records a reason too: write one below first.</Text>
                )}
                {node && (
                  <WorkButton
                    theme={props.theme}
                    label={`Open session: ${sessionName(node, fleet)}`}
                    onPress={() => onSession(node.id)}
                  >
                    Retained updates and conversation
                  </WorkButton>
                )}
              </View>
            );
          })}
          {owned.data && (
            <Text style={muted}>
              Adoption is an operator act: a role cannot grow its own ownership, and adopting spends
              the role's session allowance just as asking for one does.
            </Text>
          )}
          {adoptResult && (
            <Text accessibilityLiveRegion="polite" style={text}>
              {adoptResult.message}
            </Text>
          )}

          {/* Starting work. Routed through the seat, or an explicit way to fill the seat first. */}
          <Text accessibilityRole="header" style={heading}>
            Ask the lead for work
          </Text>
          {!seated ? (
            <>
              <Text style={text}>
                This project has no assigned lead, so work cannot be routed through one. Recording
                one is the next step — it states who is accountable and grants no authority.
              </Text>
              <WorkButton
                theme={props.theme}
                label={`Assign a lead for ${project.name}`}
                onPress={onAssign}
              >
                Assign a lead
              </WorkButton>
            </>
          ) : (
            <>
              <Text style={muted}>
                This asks the lead role to do the work. The controller publishes a request and wakes
                the seat; no session exists until the seat fulfils it. The seat gains no authority
                over the result.
              </Text>
              {/* Say why a seat will refuse before asking the operator to write a reason. */}
              {allowances.data && !allowances.data.available && (
                <Text style={muted}>
                  This role's session allowance could not be read, so whether it can accept work is
                  unknown here.
                </Text>
              )}
              {allowance === null && allowances.data?.available && (
                <Text accessibilityLiveRegion="polite" style={text}>
                  No operator session allowance is recorded for this role, so it will refuse until
                  one is granted. Asking is still possible; the refusal will say the same.
                </Text>
              )}
              {allowance && (
                <Text style={text}>
                  Session allowance: {allowance.remaining ?? "unknown"} remaining
                  {allowance.limit === null ? "" : ` of ${allowance.limit}`}
                  {allowance.revision === null ? "" : ` at role revision ${allowance.revision}`}.
                </Text>
              )}
              {stalePin && (
                <Text accessibilityLiveRegion="polite" style={text}>
                  This allowance is pinned to a role revision this role no longer has. Replacing a
                  leader resets the count while the project still lists the sessions the previous
                  holder owned, so the successor can do nothing until an operator grants a fresh
                  allowance. That is operator-in-the-loop by design, not a fault.
                </Text>
              )}
              {exhausted && (
                <Text accessibilityLiveRegion="polite" style={text}>
                  This role has no remaining session allowance, so it will refuse both new requests
                  and adoptions until an operator grants more.
                </Text>
              )}
              {(allowance === null || exhausted || stalePin) && allowances.data?.available && (
                <>
                  <TextInput
                    accessibilityLabel="Sessions to allow this role"
                    placeholder="Sessions to allow (0 to 32)"
                    placeholderTextColor={c.foregroundMuted}
                    value={grant}
                    onChangeText={(v) => {
                      setGrant(v.replace(/[^0-9]/g, "").slice(0, 2));
                      setGrantResult(null);
                    }}
                    keyboardType="number-pad"
                    editable={!busy}
                    style={field}
                  />
                  <WorkButton
                    theme={props.theme}
                    disabled={busy || short || grant === "" || Number(grant) > 32}
                    label="Grant this role a session allowance"
                    onPress={() => {
                      void runGrant();
                    }}
                  >
                    Grant allowance
                  </WorkButton>
                  <Text style={muted}>
                    A grant is pinned to the role's current revision and uses the reason written
                    below. It grants no authority.
                  </Text>
                </>
              )}
              {grantResult && (
                <Text accessibilityLiveRegion="polite" style={text}>
                  {grantResult.message}
                </Text>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {project.taskIds.map((id) => (
                  <WorkButton
                    key={id}
                    theme={props.theme}
                    label={`Workstream for new work: ${workName(fleet?.tasks.find((t) => t.id === id)?.title)}`}
                    selected={taskId === id}
                    onPress={() => {
                      setTaskId(taskId === id ? null : id);
                      setResult(null);
                    }}
                  >
                    {workName(fleet?.tasks.find((t) => t.id === id)?.title)}
                  </WorkButton>
                ))}
              </View>
              {!project.taskIds.length && (
                <Text style={text}>
                  No workstream is recorded in this project yet, so there is nothing to create work
                  against.
                </Text>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {(["claude", "codex"] as const).map((p) => (
                  <WorkButton
                    key={p}
                    theme={props.theme}
                    label={`Provider: ${p === "claude" ? "Claude" : "Codex"}`}
                    selected={provider === p}
                    onPress={() => setProvider(p)}
                  >
                    {p === "claude" ? "Claude" : "Codex"}
                  </WorkButton>
                ))}
              </View>
              <TextInput
                accessibilityLabel="New work title"
                placeholder="What this work is"
                placeholderTextColor={c.foregroundMuted}
                value={title}
                onChangeText={(v) => {
                  setTitle(v);
                  setResult(null);
                }}
                maxLength={120}
                editable={!busy}
                style={field}
              />
              <TextInput
                accessibilityLabel="Why this work belongs to this project"
                placeholder="Why this work belongs to this project"
                placeholderTextColor={c.foregroundMuted}
                value={reason}
                onChangeText={(v) => {
                  setReason(v);
                  setResult(null);
                }}
                maxLength={2000}
                multiline
                editable={!busy}
                style={field}
              />
              <WorkButton
                theme={props.theme}
                disabled={busy || short || !taskId || exhausted}
                label="Ask this project's lead for a session"
                onPress={() => {
                  void run();
                }}
              >
                Ask the lead for a session
              </WorkButton>
              <Text style={muted}>
                {short
                  ? `A title and a recorded reason of at least ${MIN_REASON} characters are required.`
                  : "A role can be current and still refuse: its operator session allowance may be exhausted or pinned to an older revision."}
              </Text>
            </>
          )}

          {result && (
            <View
              style={{
                gap: 4,
                padding: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Text accessibilityLiveRegion="polite" style={text}>
                {result.message}
              </Text>
              {result.status === "requested" && result.requestId && (
                <Text style={muted}>Request record: {result.requestId}</Text>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}
