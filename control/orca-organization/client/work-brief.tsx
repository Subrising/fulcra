import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { outcomeRpc, outcomeArtifactRpc } from "../shared/outcomes";
import { WorkButton } from "./work-button";

/** Published human context, kept separate from runtime state and release approval. */
export function WorkBrief({ taskId, frozen, onTask, theme, host, compact = false }: Pick<PluginSurfaceProps, "theme" | "host"> & { taskId: string; frozen: boolean; onTask: (id: string) => void; compact?: boolean }) {
  const read = useContract(outcomeRpc), readArtifact = useContract(outcomeArtifactRpc);
  const [opened, setOpened] = useState<string | null>(null), [impactOpen, setImpactOpen] = useState(false);
  const query = useQuery({ queryKey: ["orca-work-brief", host?.id, taskId], queryFn: () => read({ taskId }), refetchInterval: frozen ? false : 30000, refetchOnWindowFocus: !frozen, retry: false });
  const d = query.data, r = d?.record, stale = query.isError || !d || !Number.isFinite(Date.parse(d.observedAt)) || Date.now() - Date.parse(d.observedAt) > 60000;
  const current = !!opened && !stale && d?.artifacts.some(a => a.id === opened && a.state === "matches");
  const artifact = useQuery({ queryKey: ["orca-brief-output", host?.id, taskId, d?.recordSha256, opened], enabled: !!current && !!d?.recordSha256, retry: false,
    queryFn: () => readArtifact({ taskId, artifactId: opened!, recordSha256: d!.recordSha256! }) });
  const c = theme.colors, text = { color: c.foreground }, muted = { color: c.foregroundMuted };
  const choice = r?.alternatives.find(a => a.id === r.decision?.alternativeId);
  if (compact) return <View style={{ gap: 6 }}>
    <Text style={{ ...text, fontWeight: "600" }}>Reported progress</Text>
    <Text style={{ ...muted, lineHeight: 22 }}>{query.isPending ? "Reading the saved brief…" : r ? r.currentState : "No progress brief has been published yet."}</Text>
    {r?.coordination?.decisionNeeded && <Text style={text}>Needs your decision: {r.coordination.decisionNeeded}</Text>}
    {r?.nextStep && <Text style={text}>Next: {r.nextStep}</Text>}
    {r && <Text style={muted}>{r.publishedAt ? `Brief written ${new Date(r.publishedAt).toLocaleString()}` : "Saved brief · date unavailable"}{stale ? " · Update overdue" : ""}</Text>}
  </View>;
  return <View style={{ gap: 16, padding: 20, backgroundColor: c.surface1 ?? c.surface0, borderWidth: 1, borderColor: c.border, borderRadius: 16 }}>
    {query.isPending ? <Text style={muted}>Reading the work brief…</Text> : !r ? <><Text style={text}>This task needs a progress brief.</Text><Text style={muted}>The goal, result and next step have not been published yet. Open the task to inspect the conversations.</Text></> : <>
      <Text style={muted}>{r.publishedAt ? `Brief written ${new Date(r.publishedAt).toLocaleString()}` : "Saved brief · publication time not recorded"}</Text>
      {stale && <Text style={text}>Connection lost or update overdue. This is the last saved brief.</Text>}
      <View style={{ gap: 6 }}><Text style={{ ...muted, fontWeight: "600" }}>GOAL</Text><Text style={{ ...text, fontSize: 18, lineHeight: 26 }}>{r.outcome}</Text></View>
      <View style={{ gap: 6 }}><Text style={{ ...text, fontWeight: "600" }}>Where things stand</Text><Text style={{ ...text, lineHeight: 22 }}>{r.currentState}</Text></View>
      {choice && <WorkButton theme={theme} label="Why this approach and its impact" expanded={impactOpen} onPress={() => setImpactOpen(!impactOpen)} />}{choice && impactOpen && <View style={{ gap: 6 }}><Text style={{ ...text, fontWeight: "600" }}>Why this approach</Text><Text style={text}>{choice.benefits}</Text><Text style={muted}>{choice.example}</Text><Text style={text}>Trade-off: {choice.risks}</Text></View>}
      <View style={{ gap: 6 }}><Text style={{ ...text, fontWeight: "600" }}>Next step</Text><Text style={text}>{r.nextStep ?? "No next step has been published. Open the task to inspect its plan."}</Text></View>
      <View style={{ gap: 6 }}><Text style={{ ...text, fontWeight: "600" }}>Decision</Text><Text style={text}>{r.coordination?.decisionNeeded ?? r.decision?.rationale ?? "No decision has been recorded. Open the task to compare the options."}</Text></View>
      {r.artifacts.some(a => a.kind === "output") && <View style={{ gap: 8 }}><Text style={{ ...text, fontWeight: "600" }}>Outputs you can read</Text>{r.artifacts.filter(a => a.kind === "output").map(a => {
        const state = d!.artifacts.find(x => x.id === a.id)?.state;
        return <View key={a.id} style={{ gap: 4 }}><WorkButton theme={theme} label={`Read output ${a.title}`} disabled={stale || state !== "matches"} onPress={() => setOpened(opened === a.id ? null : a.id)}>{`${a.title} ↗`}</WorkButton>{state !== "matches" && <Text style={muted}>{state === "changed" ? "Changed since the brief was published" : "File currently unavailable"}</Text>}</View>;
      })}</View>}
      {opened && <View style={{ gap: 8 }}><Text style={{ ...text, fontWeight: "600" }}>{r.artifacts.find(a => a.id === opened)?.title}</Text><Text selectable style={{ ...text, lineHeight: 23 }}>{!current || artifact.isError ? "This output is unavailable or changed. Refresh before reading it." : artifact.isPending ? "Reading the saved output…" : artifact.data?.text ?? artifact.data?.message}</Text><WorkButton theme={theme} label="Close output" onPress={() => setOpened(null)} /></View>}
    </>}
    <WorkButton theme={theme} label="Open task decisions and work" onPress={() => onTask(taskId)}>Decisions, impacts and work →</WorkButton>
  </View>;
}
