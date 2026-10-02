import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { briefingRpc } from "../shared/briefing";
import { UNGROUPED } from "./projects";
import { WorkButton } from "./work-button";

export function ProjectBriefing(
  props: PluginSurfaceProps & { project: string | null; now: number; onTask: (id: string) => void },
) {
  const c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted },
    read = useContract(briefingRpc);
  const [after, setAfter] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string | null>(null),
    [limit, setLimit] = useState(3);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["orca-project-briefing", props.host?.id, after],
    queryFn: () => read({ after }),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const d = query.data,
    age = props.now - Date.parse(d?.observedAt ?? ""),
    stale = query.isError || !Number.isFinite(age) || age > 45000 || age < -5000;
  const entries =
    d?.entries.filter(
      (e) =>
        props.project === null ||
        (props.project === UNGROUPED
          ? e.projectId === null
          : e.projectId === props.project || e.affects.some((p) => p.projectId === props.project)),
    ) ?? [];
  const move = (cursor: string | null) => {
    setAfter(cursor);
    setExpanded(null);
    setLimit(3);
  };
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...text, fontSize: 22, fontWeight: "600" }}>
        Decisions and dependencies
      </Text>
      <Text style={muted}>
        What needs your judgment, why other projects are affected, and the work this depends on.
      </Text>
      {!d && (
        <Text accessibilityLiveRegion="polite" style={text}>
          {query.isPending
            ? "Reading shared decision records…"
            : "Decision records unavailable. Coverage is unknown; refresh to try again."}
        </Text>
      )}
      {d && (
        <>
          {stale && (
            <Text accessibilityLiveRegion="polite" style={text}>
              Saved observation is outdated or disconnected. These summaries are not current.
            </Text>
          )}
          <Text style={text}>
            {entries.filter((e) => e.question).length} requests for judgment ·{" "}
            {entries.reduce((n, e) => n + e.affects.length, 0)} project impacts ·{" "}
            {entries.reduce((n, e) => n + e.dependencies.length, 0)} dependencies recorded on this
            page
          </Text>
          {d.partial && (
            <Text accessibilityLiveRegion="polite" style={text}>
              Coverage is incomplete. More decisions or impacts may exist.
            </Text>
          )}
          <WorkButton
            theme={props.theme}
            label="Review decisions and dependencies"
            expanded={open}
            onPress={() => setOpen(!open)}
          />
          {open && (
            <>
              <Text style={muted}>
                {d.partial ? "Incomplete coverage" : "Current page checked"} · {d.scanned} of{" "}
                {d.total} recorded tasks checked on this page. {d.missing} have no published brief;{" "}
                {d.unavailable} could not be read.
              </Text>
              <Text style={muted}>
                Observed {new Date(d.observedAt).toLocaleString()}. Records are published reports;
                board status does not establish accepted output or a fulfilled dependency.
              </Text>
              {!entries.length && (
                <Text style={text}>
                  No matching decision records on this page. This does not establish that the
                  project has no decisions or dependencies.
                </Text>
              )}
              {entries.slice(0, limit).map((e) => (
                <View
                  key={e.taskId}
                  style={{
                    padding: 18,
                    gap: 10,
                    borderRadius: 18,
                    borderWidth: 1,
                    borderColor: c.border,
                    backgroundColor: c.surface1 ?? c.surface0,
                  }}
                >
                  <Text style={muted}>
                    {e.projectName ?? "Project unverified"}
                    {props.project && props.project !== UNGROUPED && e.projectId !== props.project
                      ? " · affects this project"
                      : ""}
                  </Text>
                  <Text style={{ ...text, fontSize: 19, lineHeight: 26, fontWeight: "600" }}>
                    {e.title}
                  </Text>
                  {e.question && (
                    <View style={{ gap: 4 }}>
                      <Text style={{ ...text, fontWeight: "600" }}>Your judgment is requested</Text>
                      <Text style={text}>{e.question}</Text>
                    </View>
                  )}
                  <Text style={text}>{e.outcome}</Text>
                  {e.nextStep && <Text style={text}>Next: {e.nextStep}</Text>}
                  {e.affects.map((p) => (
                    <View key={p.projectId} style={{ gap: 4 }}>
                      <Text style={{ ...text, fontWeight: "600" }}>
                        Affects {p.name ?? "a project that is unavailable"}
                      </Text>
                      <Text style={muted}>{p.reason}</Text>
                    </View>
                  ))}
                  {e.dependencies.map((dep, i) => (
                    <View key={i} style={{ gap: 4 }}>
                      <Text style={{ ...text, fontWeight: "600" }}>
                        Depends on: {dep.title ?? "work that cannot be verified"}
                      </Text>
                      <Text style={muted}>{dep.reason}</Text>
                      {dep.reportedStatus && (
                        <Text style={muted}>
                          Reported board status: {dep.reportedStatus.replace(/_/g, " ")}
                        </Text>
                      )}
                      {dep.taskId && (
                        <WorkButton
                          theme={props.theme}
                          label={`Open dependency: ${dep.title}`}
                          onPress={() => props.onTask(dep.taskId!)}
                        >
                          Inspect dependency
                        </WorkButton>
                      )}
                    </View>
                  ))}
                  <WorkButton
                    theme={props.theme}
                    label={`Decision context: ${e.title}`}
                    expanded={expanded === e.taskId}
                    onPress={() => setExpanded(expanded === e.taskId ? null : e.taskId)}
                  >
                    Read context and recorded choice
                  </WorkButton>
                  {expanded === e.taskId && (
                    <>
                      <Text style={text}>{e.currentState}</Text>
                      <Text style={muted}>
                        {e.decision
                          ? `Recorded rationale: ${e.decision}`
                          : "No choice is recorded. This alone does not mean your approval is required."}
                      </Text>
                      <Text style={muted}>
                        {e.publishedAt
                          ? `Published ${new Date(e.publishedAt).toLocaleString()}`
                          : "Publication time not recorded"}
                      </Text>
                    </>
                  )}
                  <WorkButton
                    theme={props.theme}
                    label={`Open decision work: ${e.title}`}
                    onPress={() => props.onTask(e.taskId)}
                  >
                    Open task, options and evidence
                  </WorkButton>
                </View>
              ))}
              {entries.length > limit && (
                <WorkButton
                  theme={props.theme}
                  label="Show more decision records"
                  onPress={() => setLimit(limit + 3)}
                />
              )}
              {d.nextCursor && (
                <WorkButton
                  theme={props.theme}
                  label="Check next page of decision records"
                  onPress={() => move(d.nextCursor)}
                >
                  Check next page for more decisions and incoming impacts
                </WorkButton>
              )}
              {after && (
                <WorkButton
                  theme={props.theme}
                  label="Return to first decision page"
                  onPress={() => move(null)}
                />
              )}
              {(after || d.nextCursor) && (
                <Text style={muted}>
                  Only this page is shown. Records can change between pages; refresh from the first
                  page to check newly added work.
                </Text>
              )}
            </>
          )}
        </>
      )}
      <WorkButton
        theme={props.theme}
        label="Refresh decision records"
        onPress={() => {
          void query.refetch();
        }}
      />
    </View>
  );
}
