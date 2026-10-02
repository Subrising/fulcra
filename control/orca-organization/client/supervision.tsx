import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Supervisor, ManagementInput } from "../shared/management";
interface Session {
  id: string;
  mode: "human" | "delegated";
  generation: number;
}
type Resume = Omit<Extract<ManagementInput, { action: "resume" }>, "action" | "messageId">;
interface ResumeProps {
  theme: PluginSurfaceProps["theme"];
  titles: Record<string, string>;
  fresh: boolean;
  busy: boolean;
  sessions: Session[];
  onResume: (input: Resume) => void;
}
function ResumeGroup({
  theme,
  titles,
  fresh,
  busy,
  sessions,
  onResume,
  role,
  parent,
}: ResumeProps & { role: Supervisor; parent: Session }) {
  const [selected, setSelected] = useState<Record<string, number>>({}),
    [reason, setReason] = useState("");
  const colors = theme.colors,
    workers = Object.entries(selected).map(([sessionId, expectedGeneration]) => ({
      sessionId,
      expectedGeneration,
    }));
  const changed = workers.some(
    (w) =>
      !sessions.some(
        (s) => s.id === w.sessionId && s.mode === "human" && s.generation === w.expectedGeneration,
      ),
  );
  const disabled = !fresh || busy || changed || reason.trim().length < 12;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted }}>
        Hand back this supervisor and the workers you select. Saved sessions and outputs stay
        intact. Send an instruction afterward to continue work.
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Supervisor: human · generation {parent.generation}. {workers.length} workers selected.
      </Text>
      {role.workers
        .filter((w) => w.workerId)
        .map((w) => {
          const id = w.workerId!,
            row = sessions.find((s) => s.id === id),
            checked = selected[id] !== undefined;
          return (
            <Pressable
              key={id}
              accessibilityRole="checkbox"
              accessibilityLabel={`Resume worker: ${titles[id] ?? id}`}
              accessibilityState={{ checked }}
              disabled={
                !fresh || busy || (!checked && (row?.mode !== "human" || w.phase !== "attached"))
              }
              onPress={() =>
                setSelected((old) => {
                  const next = { ...old };
                  if (checked) delete next[id];
                  else if (row) next[id] = row.generation;
                  return next;
                })
              }
              style={{ padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}
            >
              <Text style={{ color: colors.foreground }}>
                {checked ? "☑ " : "☐ "}
                {titles[id] ?? id}
              </Text>
              <Text style={{ color: colors.foregroundMuted }}>
                {row ? `${row.mode} · generation ${row.generation}` : "Current control unavailable"}
              </Text>
            </Pressable>
          );
        })}
      {changed && (
        <Text style={{ color: colors.foreground }}>
          Selected worker control changed. Review the selection before handing it back.
        </Text>
      )}
      <Text style={{ color: colors.foregroundMuted }}>
        Only human-owned workers can be selected. Take control of other workers first if you want to
        include them.
      </Text>
      <TextInput
        accessibilityLabel={`Organization handback reason: ${titles[parent.id] ?? parent.id}`}
        editable={!busy}
        value={reason}
        onChangeText={setReason}
        maxLength={2000}
        multiline
        placeholder="Context and reason for handing back"
        placeholderTextColor={colors.foregroundMuted}
        style={{
          color: colors.foreground,
          padding: 12,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Restore saved delegation: ${titles[parent.id] ?? parent.id}`}
        disabled={disabled}
        onPress={() =>
          onResume({
            sessionId: parent.id,
            generation: parent.generation,
            workers,
            reason: reason.trim(),
          })
        }
        style={{
          padding: 12,
          borderRadius: 8,
          backgroundColor: colors.accent,
          opacity: disabled ? 0.45 : 1,
        }}
      >
        <Text style={{ color: colors.accentForeground }}>Restore saved delegation</Text>
      </Pressable>
    </View>
  );
}
export function SupervisionPanel({
  theme,
  openConversation,
  titles,
  roles,
  fresh,
  busy,
  sessions,
  onResume,
  observedAt,
}: ResumeProps & {
  openConversation: (id: string, label: string) => ReactNode;
  roles: Supervisor[];
  observedAt?: string;
}) {
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const open = (id: string, label: string) =>
    openConversation(id, `${label}: ${titles[id] ?? "Saved conversation"}`);
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>Supervisors and workers</Text>
      <Text style={muted}>
        {fresh
          ? "Saved delegation and event records. Native activity is shown in the conversations."
          : "Connection unconfirmed. These are saved records, not live state."}
        {observedAt ? ` Saved at ${new Date(observedAt).toLocaleTimeString()}.` : ""}
      </Text>
      {!roles.length && (
        <Text style={muted}>
          {fresh
            ? "No supervisor roles recorded. Create a session and delegate it as a supervisor below."
            : "No saved supervisor observation is available."}
        </Text>
      )}
      {roles.map((s) => (
        <View
          key={s.id}
          style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}
        >
          <Text style={{ ...text, fontSize: 17, fontWeight: "600" }}>{titles[s.id] ?? s.id}</Text>
          <Text style={muted}>
            Saved role: {s.active ? "delegated" : "suspended"}. {s.reserved} of {s.maxWorkers}{" "}
            worker creations reserved.
          </Text>
          {open(s.id, "Open supervisor conversation")}
          {!s.workers.length && <Text style={muted}>No workers created yet.</Text>}
          {s.workers.map((w) => (
            <View
              key={w.requestId}
              style={{ gap: 6, padding: 12, borderLeftWidth: 2, borderColor: c.border }}
            >
              <Text style={text}>
                {w.workerId ? (titles[w.workerId] ?? w.workerId) : "Worker creation in progress"}
              </Text>
              <Text style={muted}>
                {w.ownership === "linked"
                  ? "Owned by this supervisor"
                  : w.ownership === "orphaned"
                    ? "Automation suspended; explicit reassociation required"
                    : `Creation unresolved: ${w.phase}`}
              </Text>
              {w.lastEvent && (
                <Text style={muted}>
                  Last event: {w.lastEvent.kind.replaceAll("-", " ")} ·{" "}
                  {new Date(w.lastEvent.at).toLocaleTimeString()}
                  {"\n"}
                  {w.lastEvent.consumed
                    ? "Supervisor read this event"
                    : "Not yet acknowledged"} ·
                  delivery state: {w.lastEvent.state}. This does not establish acceptance.
                </Text>
              )}
              {w.fault && <Text style={text}>Event delivery needs attention: {w.fault}</Text>}
              {w.workerId && open(w.workerId, "Open worker conversation")}
            </View>
          ))}
          {!s.active &&
            sessions
              .filter((p) => p.id === s.id && p.mode === "human")
              .map((parent) => (
                <ResumeGroup
                  key={`${parent.id}:${parent.generation}`}
                  theme={theme}
                  titles={titles}
                  fresh={fresh}
                  busy={busy}
                  sessions={sessions}
                  onResume={onResume}
                  role={s}
                  parent={parent}
                />
              ))}
        </View>
      ))}
    </View>
  );
}
