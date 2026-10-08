import { useEffect, useRef, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, TextInput, View } from "react-native";
import { taskManagementRpc, type ManagementInput } from "../shared/management";
import { fleetRpc } from "../shared/fleet";
import { OriginalConversation } from "./original-conversation";
import { ManagementSection } from "./management-section";
import { WorkButton } from "./work-button";
import { LeadershipPanel } from "./leadership";
import { SupervisionPanel } from "./supervision";
import { observedList, retainRequestIdentity } from "./management-query";
import { NativeQueuedInstruction } from "./native-queued-instruction";
type SessionRole = "planning" | "orchestration" | "implementation";
// "Default" sends no role: the session gets the installation's ordinary defaults, exactly as before roles existed.
const ROLE_CHOICES: ReadonlyArray<readonly [SessionRole | null, string]> = [
  [null, "Default"],
  ["planning", "Planning"],
  ["orchestration", "Orchestration"],
  ["implementation", "Implementation"],
];
// Correlation IDs convey no authority; a collision is rejected by the controller's body check.
function messageId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}
export function ManagementPanel({
  theme,
  navigation,
  host,
  titles: observedTitles,
  taskId,
}: Pick<PluginSurfaceProps, "theme" | "navigation" | "host"> & {
  titles: Record<string, string>;
  taskId: string;
}) {
  const rpc = useContract(taskManagementRpc),
    readFleet = useContract(fleetRpc),
    colors = theme.colors;
  const fleet = useQuery({
    queryKey: ["orca-fleet", host?.id],
    queryFn: () => readFleet({}),
    staleTime: 5000,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const nodes = fleet.data?.nodes.filter((n) => n.task === taskId) ?? [];
  const titles = { ...observedTitles, ...Object.fromEntries(nodes.map((n) => [n.id, n.title])) };
  const openConversation = (id: string, label: string) => {
    const node = nodes.find((n) => n.id === id);
    return node ? (
      <OriginalConversation
        key={id}
        theme={theme}
        navigation={navigation}
        host={host}
        targetHost={node.host}
        targetServerId={node.serverId}
        agentId={node.agentId}
        label={label}
      />
    ) : (
      <Text style={{ color: colors.foregroundMuted }}>
        Conversation identity unavailable. Refresh the work view before opening it.
      </Text>
    );
  };
  const manage = (command: ManagementInput) => rpc({ taskId, command });
  const checkConnection = () =>
    new Promise<Awaited<ReturnType<typeof manage>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fulcra connection unconfirmed")), 3000);
      manage({ action: "health" }).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const health = useQuery({
    queryKey: ["orca-management-health"],
    queryFn: checkConnection,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const list = useQuery({
    queryKey: ["orca-management", taskId],
    queryFn: () => observedList(() => manage({ action: "list" })),
    staleTime: 5000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [provider, setProvider] = useState<"claude" | "codex">("claude"),
    [title, setTitle] = useState(""),
    [selected, setSelected] = useState("");
  // DESIGN-NEXT-BUILD A3: what the new session is for; its model and effort come from the installation's role defaults.
  const [role, setRole] = useState<SessionRole | null>(null);
  const [instruction, setInstruction] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [workerLimit, setWorkerLimit] = useState("3"),
    [showResolved, setShowResolved] = useState(false);
  const urgentLock = useRef(false),
    sequence = useRef(0);
  const [abandonReasons, setAbandonReasons] = useState<Record<string, string>>({});
  const lock = useRef(false),
    identity = useRef<{ key: string; id: string } | null>(null);
  const text = { color: colors.foreground },
    muted = { color: colors.foregroundMuted },
    field = {
      color: colors.foreground,
      borderColor: colors.border,
      borderWidth: 1,
      padding: 12,
      borderRadius: 8,
    };
  const rows = list.data?.sessions ?? [],
    row = rows.find((s) => s.id === selected);
  let resolved = 0;
  const deliveries = (list.data?.deliveries ?? []).filter(
    (d) =>
      !["delivered", "refused", "abandoned"].includes(d.state) || (showResolved && resolved++ < 50),
  );
  const workerAttention = (list.data?.supervisors ?? [])
    .flatMap((s) => s.workers)
    .filter((w) => w.fault || (w.lastEvent && !w.lastEvent.consumed));
  const handoffAttention = (list.data?.handoffs ?? []).filter(
    (h) => h.state === "pending" || ["intent", "uncertain"].includes(h.deliveryState),
  );
  const connected =
    list.data?.status === "observed" &&
    !list.isError &&
    clock - Date.parse(list.data.observedAt) < 60000 &&
    health.data?.status === "observed" &&
    !health.isError &&
    clock - health.dataUpdatedAt < 8000;
  const fresh = connected && list.data?.taskAuthority?.allowed === true;
  const idFor = (actionKey: string) => {
    const key = `${taskId}:${actionKey}`;
    if (identity.current?.key !== key) identity.current = { key, id: messageId() };
    return identity.current.id;
  };
  async function act(input: ManagementInput) {
    const urgent = input.action === "takeover";
    if (urgent ? urgentLock.current : lock.current) return;
    if (urgent) urgentLock.current = true;
    else {
      lock.current = true;
      setBusy(true);
    }
    const operation = ++sequence.current;
    let invoked = false;
    try {
      if (
        !urgent &&
        [
          "create",
          "assign",
          "handback",
          "supervise",
          "resume",
          "leadership",
          "recover",
          "disposition",
          "allow-routine",
          "revoke-routine",
        ].includes(input.action)
      ) {
        const probe = await checkConnection();
        if (probe.status !== "observed") throw new Error(probe.message);
      }
      invoked = true;
      const result = await manage(input);
      identity.current = retainRequestIdentity(identity.current, result);
      if (operation === sequence.current) {
        setNotice(
          `${result.message}${result.messageId ? ` Delivery ID: ${result.messageId}` : ""}`,
        );
        if (result.sessionId) setSelected(result.sessionId);
        if (result.status === "delivered") {
          if (input.action === "assign") setInstruction("");
          if (input.action === "create") setTitle("");
        }
      }
      if (result.status === "abandoned" && "messageId" in input)
        setAbandonReasons((old) => ({ ...old, [input.messageId]: "" }));
      if (result.messageId && ["delivered", "refused", "abandoned"].includes(result.status))
        await manage({ action: "acknowledge", messageId: result.messageId }).catch(() => undefined);
      void list.refetch();
    } catch {
      if (operation === sequence.current)
        setNotice(
          invoked
            ? `Connection unavailable; the action is unconfirmed. Check durable history before continuing.${"messageId" in input ? ` Request reference: ${input.messageId}` : ""}`
            : "Connection check failed. No action was sent; refresh before continuing.",
        );
    } finally {
      if (urgent) urgentLock.current = false;
      else {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const button = (label: string, run: () => void, disabled = false, duringRequest = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={(!duringRequest && busy) || disabled}
      onPress={run}
      style={{
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.accent,
        opacity: (!duringRequest && busy) || disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color: colors.accentForeground }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{ gap: 12, padding: 16, borderColor: colors.border, borderWidth: 1, borderRadius: 12 }}
    >
      <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>Manage work</Text>
      <Text style={muted}>
        Anyone authenticated to this private Fulcra host can manage enrolled sessions. Typing,
        stopping or answering a permission prompt in the native conversation takes control back;
        instructions sent here keep the lead in control.
      </Text>
      {list.data?.permissionError && (
        <Text style={text}>Routine permission handler: {list.data.permissionError}</Text>
      )}
      {!connected &&
        button(
          "Retry controller",
          () => {
            void manage({ action: "retry-controller" })
              .then((result) => {
                setNotice(result.message);
                void health.refetch();
                void list.refetch();
              })
              .catch(() =>
                setNotice("Controller retry failed. Restart Command Centre in Settings."),
              );
          },
          false,
          true,
        )}
      {!connected && (
        <Text style={text}>
          {health.isError
            ? "Fulcra connection unavailable or unconfirmed."
            : health.data?.status === "error"
              ? health.data.message
              : "Management unavailable or stale."}{" "}
          Saved records are not live. Refresh before assigning work.{" "}
          {list.data?.status === "error" ? list.data.message : ""}
        </Text>
      )}
      {connected && !fresh && (
        <Text style={text}>
          New work is disabled: {list.data?.taskAuthority?.error ?? "Task authority inactive"}.
          Existing sessions remain available for inspection, human takeover and revocation.
        </Text>
      )}
      {notice && (
        <Text selectable accessibilityLiveRegion="polite" style={text}>
          {notice}
        </Text>
      )}
      <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
        {workerAttention.length > 0 && (
          <Text style={text}>
            Worker updates to inspect in Restore a saved team:{" "}
            {workerAttention.map((w) => titles[w.workerId ?? ""] ?? "Saved worker").join(", ")}.
          </Text>
        )}
        {handoffAttention.length > 0 && (
          <Text style={text}>
            {handoffAttention.length} handoff records need inspection in Change team leader.
            Delivery is separate from acceptance.
          </Text>
        )}
        {list.data?.leadershipError && (
          <Text style={text}>Handoff delivery needs attention: {list.data.leadershipError}</Text>
        )}
      </View>
      {row && (
        <View style={{ gap: 8 }}>
          <Text style={text}>Selected session: {titles[row.id] ?? row.id}</Text>
          {button(
            "Take control",
            () =>
              void act({
                action: "takeover",
                sessionId: row.id,
                reason: reason.trim() || "User takes control from the Fulcra management interface",
              }),
            false,
            true,
          )}
        </View>
      )}
      <ManagementSection theme={theme} title="Restore a saved team">
        <SupervisionPanel
          theme={theme}
          openConversation={openConversation}
          titles={titles}
          roles={list.data?.supervisors ?? []}
          fresh={fresh}
          busy={busy}
          observedAt={list.data?.observedAt}
          sessions={rows}
          onResume={(input) =>
            void act({
              ...input,
              action: "resume",
              messageId: idFor(`resume:${JSON.stringify(input)}`),
            })
          }
        />
        <NativeQueuedInstruction
          target={row ?? null}
          fresh={fresh && !busy}
          hostId={host?.id}
          colors={colors}
        />
      </ManagementSection>
      <ManagementSection theme={theme} title="Change team leader">
        <LeadershipPanel
          theme={theme}
          titles={titles}
          data={list.data}
          fresh={fresh}
          busy={busy}
          onTransfer={(input) =>
            void act({
              ...input,
              action: "leadership",
              messageId: idFor(`leadership:${JSON.stringify(input)}`),
            })
          }
        />
      </ManagementSection>
      <ManagementSection theme={theme} title="Sessions and instructions">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(["claude", "codex"] as const).map((p) => (
            <Pressable
              key={p}
              accessibilityRole="radio"
              accessibilityState={{ checked: p === provider }}
              disabled={busy}
              onPress={() => {
                setProvider(p);
                identity.current = null;
              }}
              style={{ ...field, backgroundColor: colors.surface0 }}
            >
              <Text style={text}>
                {p === provider ? "● " : "○ "}
                {p === "claude" ? "Claude" : "Codex"}
              </Text>
            </Pressable>
          ))}
        </View>
        <View
          accessibilityLabel="What the new session is for"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        >
          {ROLE_CHOICES.map(([r, label]) => (
            <Pressable
              key={label}
              accessibilityRole="radio"
              accessibilityState={{ checked: r === role }}
              disabled={busy}
              onPress={() => {
                setRole(r);
                identity.current = null;
              }}
              style={{ ...field, backgroundColor: colors.surface0 }}
            >
              <Text style={text}>
                {r === role ? "● " : "○ "}
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          editable={!busy}
          accessibilityLabel="New session title"
          placeholder="Session title"
          placeholderTextColor={colors.foregroundMuted}
          value={title}
          maxLength={120}
          onChangeText={(v) => {
            setTitle(v);
            identity.current = null;
          }}
          style={field}
        />
        {button(
          "Create session",
          () =>
            void act({
              action: "create",
              provider,
              title: title.trim(),
              ...(role ? { role } : {}),
              messageId: idFor(`create:${provider}:${role ?? "default"}:${title.trim()}`),
            }),
          !fresh || title.trim().length < 3,
        )}
        {list.data?.partial && <Text style={muted}>Showing the first 32 enrolled sessions.</Text>}
        {rows.map((s) => (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityLabel={`Manage ${titles[s.id] ?? s.id}`}
            accessibilityState={{ selected: selected === s.id }}
            disabled={busy}
            onPress={() => {
              setSelected(s.id);
              setReason("");
              setInstruction("");
              identity.current = null;
            }}
            style={{ padding: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 8 }}
          >
            <Text style={text}>
              {selected === s.id ? "● " : ""}
              {titles[s.id] ?? s.id}
            </Text>
            <Text style={muted}>
              Saved control: {s.mode} · generation {s.generation}
            </Text>
          </Pressable>
        ))}
        {row && (
          <View style={{ gap: 10 }}>
            <Text style={muted}>
              Control mode is separate from runtime activity. Taking control revokes future
              automation; already delivered work may continue.
            </Text>
            {button(
              "Inspect current state and deliveries",
              () => void act({ action: "inspect", sessionId: row.id }),
            )}
            {openConversation(row.id, "Open managed conversation")}
            <TextInput
              accessibilityLabel="Control transfer context"
              placeholder="Context for taking control or handing it to Fulcra"
              placeholderTextColor={colors.foregroundMuted}
              value={reason}
              onChangeText={setReason}
              maxLength={2000}
              multiline
              style={field}
            />
            {row.mode === "human" &&
              button(
                "Let Fulcra control this",
                () =>
                  void act({
                    action: "handback",
                    sessionId: row.id,
                    generation: row.generation,
                    reason: reason.trim(),
                  }),
                !fresh || reason.trim().length < 12,
              )}
            {row.mode === "delegated" && (
              <View style={{ gap: 8 }}>
                <Text style={muted}>
                  Routine files: Claude Write and exact Edit only, inside this session's owned
                  folder, up to 256 KiB. One shared allowance of 100 responses covers a supervisor
                  and its new workers. Shell commands, hidden files and other requests remain
                  pending for a decision. Verification pauses further approvals for at most two
                  minutes before reporting an incident.
                </Text>
                {(list.data?.permissions ?? [])
                  .filter((p) => p.sessionId === row.id)
                  .map((p) => (
                    <View key={p.sessionId}>
                      <Text style={text}>
                        Routine grant {p.active ? "active" : "inactive"} · shared remaining{" "}
                        {p.remaining}/100 · awaiting verification or response {p.pending}
                      </Text>
                      <Text style={muted}>{p.reason}</Text>
                      {p.recent.map((r) => (
                        <Text key={r.id} style={muted}>
                          {r.state}: {r.note}
                        </Text>
                      ))}
                    </View>
                  ))}
                {button(
                  "Allow routine file approvals",
                  () =>
                    void act({
                      action: "allow-routine",
                      sessionId: row.id,
                      generation: row.generation,
                      reason: reason.trim(),
                    }),
                  !fresh || reason.trim().length < 12,
                )}
                {button(
                  "Revoke routine file approvals",
                  () =>
                    void act({
                      action: "revoke-routine",
                      sessionId: row.id,
                      generation: row.generation,
                      reason: reason.trim() || "Operator revokes routine permission handling",
                    }),
                  !connected,
                )}
              </View>
            )}
            {row.mode === "human" && (
              <View style={{ gap: 8 }}>
                <Text style={muted}>
                  Give a newly created session control as a supervisor. It may create this many workers
                  over its lifetime. Use Give control back to the lead above for an existing
                  organization.
                </Text>
                <TextInput
                  editable={!busy}
                  accessibilityLabel="Supervisor worker allowance"
                  value={workerLimit}
                  onChangeText={setWorkerLimit}
                  keyboardType="number-pad"
                  maxLength={1}
                  style={field}
                />
                {button(
                  "Let Fulcra control this as a lead",
                  () =>
                    void act({
                      action: "supervise",
                      sessionId: row.id,
                      generation: row.generation,
                      maxWorkers: Number(workerLimit),
                      reason: reason.trim(),
                    }),
                  !fresh || reason.trim().length < 12 || !/^[1-6]$/.test(workerLimit),
                )}
              </View>
            )}
            <TextInput
              editable={!busy}
              accessibilityLabel="Task instruction"
              placeholder="Outcome, scope, constraints and what a good result looks like"
              placeholderTextColor={colors.foregroundMuted}
              value={instruction}
              onChangeText={(v) => {
                setInstruction(v);
                identity.current = null;
              }}
              maxLength={16384}
              multiline
              style={{ ...field, minHeight: 100 }}
            />
            {button(
              "Send instruction",
              () =>
                void act({
                  action: "assign",
                  sessionId: row.id,
                  generation: row.generation,
                  text: instruction.trim(),
                  messageId: idFor(`assign:${row.id}:${row.generation}:${instruction.trim()}`),
                }),
              !fresh || row.mode !== "delegated" || !instruction.trim(),
            )}
          </View>
        )}
      </ManagementSection>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Delivery history</Text>
      <WorkButton
        theme={theme}
        label="Show resolved delivery history"
        expanded={showResolved}
        onPress={() => setShowResolved(!showResolved)}
      />
      <Text style={muted}>
        Unresolved deliveries stay visible. Expand to inspect the latest 50 resolved deliveries,
        within the 1,000-entry journal limit. Check history before resubmitting after a connection
        failure.
      </Text>
      {deliveries.map((d) => (
        <View
          key={d.id}
          style={{
            gap: 8,
            padding: 10,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
          }}
        >
          <Text selectable style={text}>
            {d.kind} · {d.state === "reserved" ? "queued" : d.state} · {d.id}
          </Text>
          {d.state === "prepared" && (
            <Text style={muted}>
              Creation was prepared, but no admitted delivery is recorded. It will not be retried
              automatically. There is no delivery to reconcile or abandon; retain this reference.
            </Text>
          )}
          {d.session && <Text style={muted}>{titles[d.session] ?? d.session}</Text>}
          {["intent", "uncertain"].includes(d.state) && (
            <>
              <Text style={muted}>
                {["resume", "leadership"].includes(d.kind)
                  ? "Reconcile finishes a hand-over that was left half-done. It does not change who is in charge or repeat any work."
                  : d.kind === "create"
                    ? "Reconcile checks the original request and may finish creating it."
                    : "Reconcile checks whether the message arrived without sending it again."}
              </Text>
              {button(
                `Reconcile ${d.id}`,
                () => void act({ action: "recover", messageId: d.id }),
                !fresh,
              )}
              <TextInput
                accessibilityLabel={`Reason to abandon ${d.id}`}
                placeholder="Evidence and reason to abandon this unresolved delivery"
                placeholderTextColor={colors.foregroundMuted}
                value={abandonReasons[d.id] ?? ""}
                onChangeText={(value) => setAbandonReasons((old) => ({ ...old, [d.id]: value }))}
                maxLength={2000}
                multiline
                style={field}
              />
              {button(
                `Abandon ${d.id}`,
                () =>
                  void act({
                    action: "disposition",
                    messageId: d.id,
                    reason: (abandonReasons[d.id] ?? "").trim(),
                  }),
                (abandonReasons[d.id] ?? "").trim().length < 12,
              )}
            </>
          )}
        </View>
      ))}
      {button(
        "Refresh management",
        () => {
          void list.refetch();
        },
        false,
        true,
      )}
    </View>
  );
}
