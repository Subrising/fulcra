import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { Pressable, Text, View } from "react-native";
import { outcomeRpc, outcomeArtifactRpc } from "../shared/outcomes";
const perspectives = { CTO: "System boundaries, alternatives and reversal costs", EM: "Owners, dependencies, progress and delivery evidence", Product: "User outcomes, trade-offs, assumptions and examples", Security: "Data boundaries, access, affected systems and review scope", Marketing: "Audience impact, claims, evidence and launch readiness" };
export function OutcomePanel({ taskId, theme, navigation }: Pick<PluginSurfaceProps, "theme" | "navigation"> & { taskId: string }) {
  const read = useContract(outcomeRpc), readArtifact = useContract(outcomeArtifactRpc), c = theme.colors;
  const [perspective, setPerspective] = useState<keyof typeof perspectives>("CTO"), [choice, setChoice] = useState<string | null>(null), [artifactId, setArtifact] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["orca-outcome", taskId], queryFn: () => read({ taskId }), refetchInterval: 30000, refetchIntervalInBackground: false, retry: false });
  const d = query.data, record = d?.record, stale = query.isError || !d || Date.now() - Date.parse(d.observedAt) > 60000;
  const artifactCurrent = !!artifactId && d?.artifacts.find(a => a.id === artifactId)?.state === "matches";
  const artifact = useQuery({ queryKey: ["orca-outcome-artifact", taskId, d?.recordSha256, artifactId], enabled: !!artifactId && !!d?.recordSha256 && !stale && artifactCurrent, retry: false,
    queryFn: () => readArtifact({ taskId, artifactId: artifactId!, recordSha256: d!.recordSha256! }) });
  const text = { color: c.foreground }, muted = { color: c.foregroundMuted }, box = { padding: 14, gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 10 }, button = { minHeight: 44, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 };
  return <View style={{ gap: 12 }}>
    <Text style={{ ...text, fontSize: 22, fontWeight: "600" }}>Decision and delivery</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{Object.keys(perspectives).map(p => <Pressable key={p} accessibilityRole="radio" accessibilityState={{ checked: p === perspective }} accessibilityLabel={`${p} perspective`} style={button} onPress={() => setPerspective(p as keyof typeof perspectives)}><Text style={text}>{p === perspective ? "● " : ""}{p}</Text></Pressable>)}</View>
    <Text style={muted}>{perspectives[perspective]}. Perspective changes the questions, not the recorded facts or authority.</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Refresh decision evidence" style={button} onPress={() => { void query.refetch(); if (artifactId) void artifact.refetch(); }}><Text style={text}>{query.isFetching ? "Reading evidence…" : "Refresh evidence"}</Text></Pressable>
    {query.isError && <Text style={text}>Decision evidence unavailable. Retained information is stale.</Text>}
    {query.isPending && <Text style={muted}>Reading the published task decision…</Text>}
    {d && <Text style={muted}>{stale ? "STALE · " : ""}{d.message} Observed {d.observedAt}</Text>}
    {record && <>
      <View style={box}><Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>{record.title}</Text><Text style={text}>Outcome: {record.outcome}</Text><Text style={text}>Current situation: {record.currentState}</Text></View>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Alternatives and impacts</Text>
      {record.alternatives.map(a => <View key={a.id} style={box}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: choice === a.id }} accessibilityLabel={`Inspect alternative ${a.title}`} style={button} onPress={() => setChoice(choice === a.id ? null : a.id)}><Text style={{ ...text, fontWeight: "600" }}>{a.title}{record.decision?.alternativeId === a.id ? " · Recorded choice" : ""}</Text></Pressable>
        <Text style={text}>{a.change}</Text>
        {choice === a.id && <><Text style={text}>Expected benefit: {a.benefits}</Text><Text style={text}>Risks and uncertainty: {a.risks}</Text><Text style={text}>Dependencies: {a.dependencies.join("; ") || "None recorded"}</Text><Text style={text}>Example: {a.example}</Text></>}
      </View>)}
      <View style={box}><Text style={{ ...text, fontWeight: "600" }}>Recorded decision</Text>{record.decision ? <><Text style={text}>{record.decision.rationale}</Text><Text style={muted}>{record.decision.by} · {record.decision.at}</Text><Text style={text}>Authority: {record.decision.authority}</Text></> : <Text style={text}>No choice recorded. Inspect alternatives before consequential work.</Text>}</View>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Saved outputs and evidence</Text>
      {!record.artifacts.length && <Text style={muted}>No files published yet. A completed conversation does not establish delivery.</Text>}
      {record.artifacts.map(a => { const state = d?.artifacts.find(x => x.id === a.id); return <View key={a.id} style={box}>
        <Text style={{ ...text, fontWeight: "600" }}>{a.title} · {a.kind}</Text><Text style={text}>{state?.state === "matches" ? "Matches published version" : state?.state === "changed" ? "Changed since publication" : "File unavailable"}</Text>
        <Text selectable style={muted}>{a.file}{"\n"}Published SHA256: {a.sha256}</Text>
        {state?.actualSha256 && state.actualSha256 !== a.sha256 && <Text selectable style={muted}>Current SHA256: {state.actualSha256}</Text>}
        <Pressable accessibilityRole="button" disabled={stale || state?.state !== "matches"} accessibilityLabel={`Read ${a.title}`} style={button} onPress={() => setArtifact(a.id)}><Text style={text}>Read saved file</Text></Pressable>
        {a.producerSessionId && navigation && <Pressable accessibilityRole="button" accessibilityLabel={`Open producer of ${a.title}`} style={button} onPress={() => navigation.openAgent({ agentId: a.producerSessionId! })}><Text style={text}>Open recorded producer conversation</Text></Pressable>}
      </View>; })}
      {record.reviews.map((r, i) => <View key={i} style={box}><Text style={{ ...text, fontWeight: "600" }}>Recorded review: {r.verdict}</Text><Text style={text}>{r.by} · {r.scope}</Text><Text style={text}>{!stale && d?.reviews[i]?.current ? "Referenced evidence matches" : "Review evidence is stale or unavailable"}</Text><Text style={muted}>{d?.reviews[i]?.reason}</Text></View>)}
      {artifactId && <View style={box}><Text style={{ ...text, fontWeight: "600" }}>{record.artifacts.find(a => a.id === artifactId)?.title ?? "Saved file"}</Text>
        {(stale || !artifactCurrent || artifact.isError) ? <Text style={text}>Saved content unavailable or stale. Refresh evidence.</Text> : artifact.isPending ? <Text style={muted}>Reading exact published file…</Text> : <><Text style={muted}>{artifact.data?.message} Observed {artifact.data?.observedAt}</Text>{artifact.data?.text != null && <Text selectable style={{ ...text, fontFamily: "monospace" }}>{artifact.data.text}</Text>}</>}
        <Pressable accessibilityRole="button" style={button} onPress={() => setArtifact(null)}><Text style={text}>Close saved file</Text></Pressable>
      </View>}
    </>}
  </View>;
}
