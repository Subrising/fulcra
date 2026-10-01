import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useContract } from "./use-contract";
import { projectBriefRpc, type ProjectBrief } from "../shared/cc/brief";
import type { Owner } from "../shared/cc/remit";
import { Button, Notice, Pill, SectionTitle, type Theme } from "./organisation-ui";
import { HEALTH_LABEL, dayLabel, ownerLine, relativeTime } from "./organisation-model";

/**
 * One project's story (CONTRACTS §4): Now / Next / Needs you / Risks, written by that project's orchestrator and
 * labelled "Written by <name>, <time>". Out-of-date stories say so. Ids stay behind "Details".
 */
const HEALTH_TONE = { "on-track": "success", "at-risk": "warning", blocked: "danger", idle: "muted" } as const;
const SEVERITY = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ProjectStory({ projectId, name, owner, theme, compact, hostId, onEditRemit }: { projectId: string; name: string; owner: Owner; theme: Theme; compact: boolean; hostId?: string; onEditRemit: () => void }) {
  const c = theme.colors, text = { color: c.foreground, lineHeight: 22 }, muted = { color: c.foregroundMuted, lineHeight: 20 };
  const read = useContract(projectBriefRpc);
  const query = useQuery({ queryKey: ["orca-organisation", hostId, "brief", projectId], queryFn: () => read({ projectId }), refetchInterval: 60000, refetchIntervalInBackground: false, retry: false });
  const [details, setDetails] = useState(false);
  const d = query.data, b: ProjectBrief | null = d?.brief ?? null, o = d?.observed;
  const card = { gap: 10, padding: compact ? 14 : 18, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 };
  return <View testID="org-story" style={{ gap: 14 }}>
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: compact ? 22 : 26, fontWeight: "700" }}>{name}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <Text style={muted}>{ownerLine(owner)}</Text>
        <Button theme={theme} testID="org-remit-edit-open" label={`Change which prime owns ${name}`} onPress={onEditRemit}>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>Change prime</Text>
        </Button>
      </View>
    </View>
    {!d && <Text style={text}>{query.isPending ? "Reading the latest update…" : "The update could not be read."}</Text>}
    {d?.error && <Notice colors={c} tone="warning">Could not refresh just now; showing what was last read. {d.error}</Notice>}
    {d && !b && <View style={card}>
      <Text style={{ ...text, fontWeight: "600" }}>No update has been written yet.</Text>
      <Text style={muted}>The project's orchestrator writes one whenever something changes, and at least once a day while work is going on.</Text>
    </View>}
    {b && <View style={card}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Pill colors={c} tone={HEALTH_TONE[b.health]}>{HEALTH_LABEL[b.health]}</Pill>
        {d?.stale && <Pill colors={c} tone="warning">May be out of date</Pill>}
      </View>
      <Text style={{ color: c.foreground, fontSize: 18, lineHeight: 25, fontWeight: "600" }}>{b.headline}</Text>
      <Text style={muted}>Written by {d?.authorName ?? "the project's orchestrator"}, {relativeTime(b.writtenAt)}</Text>
      {d?.stale && <Text style={muted}>Work has moved on since this was written, or it is more than a day old.</Text>}
    </View>}
    {b && <>
      <View style={{ gap: 6 }}><SectionTitle colors={c}>Now</SectionTitle><Text style={text}>{b.now}</Text></View>
      <View style={{ gap: 6 }}>
        <SectionTitle colors={c}>Next</SectionTitle>
        {!b.next.length ? <Text style={muted}>No next steps written.</Text> : b.next.map((n, i) => <Text key={i} style={text}>• {n.text}{n.by ? ` — by ${dayLabel(n.by)}` : ""}</Text>)}
      </View>
      <View style={{ gap: 6 }}>
        <SectionTitle colors={c}>Needs you</SectionTitle>
        {!b.needsYou.length ? <Text style={muted}>Nothing needs you on this project.</Text> : b.needsYou.map((n, i) => <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: 10 }}>
          <Text style={text}>{n.text}</Text>{n.decision && <Text style={muted}>Waiting in your Inbox.</Text>}
        </View>)}
      </View>
      <View style={{ gap: 6 }}>
        <SectionTitle colors={c}>Risks</SectionTitle>
        {!b.risks.length ? <Text style={muted}>No risks written.</Text> : b.risks.map((r, i) => <View key={i} style={{ gap: 2 }}>
          <Text style={text}>{r.text} <Text style={{ color: r.severity === "high" ? c.statusDanger : r.severity === "medium" ? c.statusWarning : c.foregroundMuted, fontWeight: "600" }}>· {SEVERITY[r.severity]}</Text></Text>
          {r.mitigation ? <Text style={muted}>What is being done: {r.mitigation}</Text> : null}
        </View>)}
      </View>
      {b.shipped.length > 0 && <View style={{ gap: 6 }}><SectionTitle colors={c}>Finished since last time</SectionTitle>{b.shipped.map((s, i) => <Text key={i} style={text}>✓ {s.text}</Text>)}</View>}
    </>}
    {o && <Text style={muted}>Right now: {o.sessionsRunning} of {plural(o.sessionsTotal, "session")} working · {plural(o.openDecisions, "decision")} waiting for you · {plural(o.heldMessages, "message")} held</Text>}
    <Button theme={theme} testID="org-story-details" label={details ? "Hide details" : "Show details"} expanded={details} onPress={() => setDetails(!details)}>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{details ? "Hide details" : "Details"}</Text>
    </Button>
    {details && <View style={{ gap: 4 }}>
      <Text selectable style={muted}>Project: {projectId}</Text>
      {b && <Text selectable style={muted}>Update {b.revision} · written by seat {b.author.seat} (session {b.author.sessionId}) at {b.writtenAt}</Text>}
      {b?.evidence.map((e, i) => <Text key={i} selectable style={muted}>{e.label}: {e.ref}</Text>)}
      {b?.shipped.filter(s => s.ref).map((s, i) => <Text key={`s${i}`} selectable style={muted}>{s.text}: {s.ref}</Text>)}
      {d && <Text style={muted}>Checked {relativeTime(d.observedAt)}{d.partial ? " · some counts could not be read" : ""}</Text>}
    </View>}
  </View>;
}
