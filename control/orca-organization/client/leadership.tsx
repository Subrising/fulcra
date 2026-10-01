import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ContractOutput } from "../shared/rpc-contract";
import { managementRpc, type ManagementInput } from "../shared/management";
type Data = ContractOutput<typeof managementRpc>;
type Transfer = Omit<Extract<ManagementInput, { action: "leadership" }>, "action" | "messageId">;
export function LeadershipPanel({ theme, titles, data, fresh, busy, onTransfer }: Pick<PluginSurfaceProps, "theme"> & { titles: Record<string, string>; data?: Data; fresh: boolean; busy: boolean; onTransfer: (a: Transfer) => void }) {
  const [source, setSource] = useState(""), [destination, setDestination] = useState(""), [context, setContext] = useState(""), [allowance, setAllowance] = useState("2");
  const c = theme.colors, text = { color: c.foreground }, muted = { color: c.foregroundMuted }, field = { color: c.foreground, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 };
  const rows = data?.sessions ?? [], roles = data?.supervisors ?? [], role = roles.find(r => r.id === source), from = rows.find(s => s.id === source), to = rows.find(s => s.id === destination);
  const workers = (role?.workers ?? []).flatMap(w => { const s = rows.find(r => r.id === w.workerId); return s ? [{ sessionId: s.id, expectedGeneration: s.generation }] : []; });
  const disabled = !fresh || busy || data?.leadershipCapacity?.transferAllowed === false || !from || !to || source === destination || !(data?.leadershipCandidates ?? []).includes(destination) || workers.length !== role?.workers.length || !/^[1-6]$/.test(allowance) || Number(allowance) < workers.length || context.trim().length < 12;
  const choose = (id: string, selected: boolean, label: string, run: () => void) => <Pressable key={id} accessibilityRole="radio" accessibilityLabel={`${label}: ${titles[id] ?? id}`} accessibilityState={{ checked: selected }} disabled={busy} onPress={run} style={field}><Text style={text}>{selected ? "● " : "○ "}{titles[id] ?? id}</Text></Pressable>;
  return <View style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
    <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>Transfer leadership</Text>
    <Text style={muted}>Move an idle saved organization to another supervisor. The same workers, conversations and files continue under one new accountable owner.</Text>
    {data?.leadershipCapacity?.transferAllowed === false && <Text style={text}>Transfer capacity reached. Current ownership stays intact. Use the existing supervisor; history maintenance is required before another transfer.</Text>}
    <Text style={text}>Current supervisor</Text>
    {roles.filter(r => r.workers.length > 0).map(r => choose(r.id, source === r.id, "Transfer from", () => setSource(r.id)))}
    <Text style={text}>Incoming supervisor</Text>
    {(data?.leadershipCandidates ?? []).filter(id => id !== source).map(id => choose(id, destination === id, "Transfer to", () => setDestination(id)))}
    {!data?.leadershipCandidates?.length && <Text style={muted}>Create a session below first. The incoming supervisor must be human-owned and have no worker reservations.</Text>}
    {!role && <Text style={muted}>Choose a supervisor with saved workers to see which sessions would move. If none are listed, there is no saved organization to transfer in this task.</Text>}
    {role && <Text style={muted}>Affected workers: {role.workers.length ? role.workers.map(w => titles[w.workerId ?? ""] ?? w.workerId ?? "Unresolved creation").join(", ") : "None"}. The outgoing supervisor becomes human-owned. Previous routine permission grants become inactive; a fresh grant is required.</Text>}
    <TextInput accessibilityLabel="Incoming supervisor worker allowance" editable={!busy} value={allowance} onChangeText={setAllowance} keyboardType="number-pad" maxLength={1} style={field} />
    <Text style={muted}>Worker allowance includes the inherited workers. All affected sessions must be idle with no unresolved work.</Text>
    <TextInput accessibilityLabel="Leadership handoff context" editable={!busy} value={context} onChangeText={setContext} maxLength={8000} multiline placeholder="Outcome, current outputs and evidence, open decisions, and what the incoming supervisor should do next" placeholderTextColor={c.foregroundMuted} style={{ ...field, minHeight: 120 }} />
    <Pressable accessibilityRole="button" accessibilityLabel="Transfer leadership and send handoff" disabled={disabled} onPress={() => { if (from && to) onTransfer({ sessionId: source, generation: from.generation, destinationId: destination, destinationGeneration: to.generation, maxWorkers: Number(allowance), workers, context: context.trim() }); }} style={{ padding: 12, borderRadius: 8, backgroundColor: c.accent, opacity: disabled ? 0.45 : 1 }}><Text style={{ color: c.accentForeground }}>Transfer leadership and send handoff</Text></Pressable>
    {data?.leadershipError && <Text style={text}>Handoff delivery needs attention: {data.leadershipError}</Text>}
    {(data?.handoffs ?? []).map(h => <View key={h.id} style={{ gap: 6, padding: 10, borderTopWidth: 1, borderColor: c.border }}>
      <Text style={text}>{titles[h.source] ?? h.source} → {titles[h.destination] ?? h.destination}</Text>
      <Text style={muted}>Ownership transferred · handoff delivery: {h.deliveryState} · {h.state === "consumed" ? "Incoming supervisor read the handoff" : h.state === "pending" ? "Not yet acknowledged" : h.state.replaceAll("-", " ")}</Text>
      <Text style={muted}>{h.context}</Text>
      {h.consumed && <Text style={text}>Next-action note: {h.consumed}</Text>}
      {h.note && <Text style={text}>{h.note}</Text>}
      <Text selectable style={muted}>Handoff {h.id}{"\n"}Wake {h.wakeId}. Delivery and consumption do not accept the work. Reconcile uncertain delivery in the history below; abandonment revokes destination automation.</Text>
    </View>)}
  </View>;
}
