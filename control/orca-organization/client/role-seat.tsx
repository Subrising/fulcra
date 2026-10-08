import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { taskManagementRpc } from "../shared/management";
import { roleAssignRpc, type RoleAssignResult } from "../shared/roles";
import type { Fleet } from "../shared/fleet";
import type { Seat } from "../shared/roles";
import { sessionName, workName } from "./work-labels";
import { WorkButton } from "./work-button";
import { modeText } from "./work-map-model";

/**
 * Recording who is accountable for a project.
 *
 * This writes one controller role binding and nothing else. It starts no session, sends no
 * instruction, moves no work and grants no authority — the controller says so on every reply and
 * this panel repeats it rather than letting the operator assume otherwise.
 *
 * Both fences are values actually observed, never defaults. `expectedRevision` comes from the seat
 * this view read, and `expectedSessionGeneration` from the candidate's own saved control row. If
 * either moved since, the controller refuses the write and the refusal is shown verbatim rather
 * than retried — a stale writer is exactly what the revision counter exists to stop.
 */
const MIN_REASON = 12;

/**
 * What the panel is filling. A prime seat is held by a session enrolled on the programme root; a
 * project seat by a session on one of that project's own member workstreams. The candidate list is
 * therefore supplied by the caller rather than assumed here.
 */
export interface SeatTarget {
  seat: Seat;
  label: string;
  candidateTaskIds: string[];
  scope: string;
}

export function SeatPanel({
  target,
  fleet,
  props,
  onDone,
  onChanged,
}: {
  target: SeatTarget;
  fleet?: Fleet;
  props: PluginSurfaceProps;
  onDone: () => void;
  onChanged: () => void;
}) {
  const c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const taskManage = useContract(taskManagementRpc),
    assign = useContract(roleAssignRpc);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RoleAssignResult | null>(null);
  const seat = target.seat;
  const field = {
    ...text,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 48,
  };

  // Candidate control rows come from the existing task management read, which is the only place
  // that reports a session's current generation — the value the assignment must be fenced on.
  const rows = useQuery({
    queryKey: ["orca-task-manage-sessions", props.host?.id, taskId],
    enabled: taskId !== null,
    retry: false,
    queryFn: () => taskManage({ taskId: taskId!, command: { action: "list" } }),
  });
  const readRefused =
    rows.isError ||
    rows.data?.status === "error" ||
    (!!rows.data && !Array.isArray(rows.data.sessions));
  const refusal = rows.error instanceof Error ? rows.error.message : rows.data?.message;
  const sessions = readRefused ? [] : (rows.data?.sessions ?? []).filter((s) => s.task === taskId);
  const chosen = sessions.find((s) => s.id === sessionId) ?? null;
  const short = reason.trim().length < MIN_REASON;

  const run = async (build: () => Parameters<typeof assign>[0]) => {
    setBusy(true);
    try {
      const d = await assign(build());
      setResult(d);
      if (d.status !== "error") onChanged();
    } catch (error) {
      setResult({
        status: "error",
        message: error instanceof Error ? error.message : "Role assignment unavailable",
        observedAt: new Date().toISOString(),
        role: null,
        seat: null,
        revision: null,
        sessionId: null,
        previousSessionId: null,
        grantsAuthority: false,
      });
    } finally {
      setBusy(false);
    }
  };

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
      <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>
        Who is accountable for {target.label}
      </Text>
      <Text style={muted}>
        This records who is accountable. It does not start, stop or message any session.
      </Text>

      <>
        <Text style={muted}>
          {seat.state === "assigned" ? "Someone is assigned now." : "Nobody is assigned yet."}
        </Text>

        <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>
          Choose the accountable session
        </Text>
        <Text style={muted}>{target.scope}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {target.candidateTaskIds.map((id) => (
            <WorkButton
              key={id}
              theme={props.theme}
              label={`Workstream: ${workName(fleet?.tasks.find((t) => t.id === id)?.title)}`}
              selected={taskId === id}
              onPress={() => {
                setTaskId(taskId === id ? null : id);
                setSessionId(null);
                setResult(null);
              }}
            >
              {workName(fleet?.tasks.find((t) => t.id === id)?.title)}
            </WorkButton>
          ))}
        </View>
        {!target.candidateTaskIds.length && (
          <Text style={text}>
            No workstream is available for this role, so no session can be named accountable for it
            yet.
          </Text>
        )}
        {taskId && rows.isPending && <Text style={text}>Reading this workstream's sessions…</Text>}
        {taskId && readRefused && (
          <Text accessibilityLiveRegion="polite" style={text}>
            Fulcra could not read this workstream's sessions, so none can be chosen. Nothing was
            changed.{" "}
            {refusal
              ? `Read refusal: ${refusal.slice(0, 1000)}`
              : "No refusal detail was returned."}
          </Text>
        )}
        {taskId && readRefused && (
          <WorkButton
            theme={props.theme}
            label="Retry workstream session read"
            onPress={() => {
              void rows.refetch();
            }}
          />
        )}
        {taskId && readRefused && (
          <Text style={muted}>
            Use the saved company source. Resolve any management/direct-connection refusal there;
            this read does not assign a role or change permissions.
          </Text>
        )}
        {taskId && !readRefused && rows.data && !sessions.length && (
          <Text style={text}>This workstream has no saved sessions.</Text>
        )}
        {sessions.map((s) => {
          const node = fleet?.nodes.find((n) => n.id === s.id);
          return (
            <WorkButton
              key={s.id}
              theme={props.theme}
              label={`Accountable session: ${node ? sessionName(node, fleet) : s.id}`}
              selected={sessionId === s.id}
              onPress={() => {
                setSessionId(sessionId === s.id ? null : s.id);
                setResult(null);
              }}
            >{`${node ? sessionName(node, fleet) : "Saved session"} · ${modeText(s.mode)}`}</WorkButton>
          );
        })}

        <TextInput
          accessibilityLabel="Why this session is accountable"
          placeholder="Why this session is accountable for the project"
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
        <Text style={muted}>
          {short
            ? `A recorded reason of at least ${MIN_REASON} characters is required; Fulcra refuses a shorter one.`
            : "This reason is kept with the assignment and its history."}
        </Text>

        <WorkButton
          theme={props.theme}
          disabled={busy || short || !chosen}
          label={
            seat.state === "assigned"
              ? "Record this session as accountable, replacing the current one"
              : "Record this session as accountable"
          }
          onPress={() =>
            chosen &&
            run(() => ({
              action: "assign",
              role: seat.role,
              seat: seat.seat,
              sessionId: chosen.id,
              expectedRevision: seat.revision,
              expectedSessionGeneration: chosen.generation,
              reason: reason.trim(),
            }))
          }
        >
          {seat.state === "assigned" ? "Replace accountable session" : "Record accountable session"}
        </WorkButton>

        {seat.state === "assigned" && (
          <WorkButton
            theme={props.theme}
            disabled={busy || short}
            label="Empty this role. The project then has no recorded lead"
            onPress={() =>
              run(() => ({
                action: "vacate",
                role: seat.role,
                seat: seat.seat,
                expectedRevision: seat.revision,
                reason: reason.trim(),
              }))
            }
          >
            Empty this role
          </WorkButton>
        )}
      </>

      {result && (
        <Text accessibilityLiveRegion="polite" style={text}>
          {result.message}
        </Text>
      )}
      {result?.status === "error" && (
        <Text style={muted}>
          Nothing was changed. Refresh to read the current role before trying again.
        </Text>
      )}
      <WorkButton theme={props.theme} label="Close accountability panel" onPress={onDone}>
        Close
      </WorkButton>
    </View>
  );
}
